/**
 * Multi-Agent Runtime
 *
 * Manages A2A protocol lifecycle inside a sandbox:
 *   1. Bootstrap — write config, install prompts
 *   2. Start — seed message, spawn watcher
 *   3. Stream — demux tagged NDJSON into per-agent parsers + loggers
 *   4. Stop — kill watcher + all agents
 *
 * Evidence: a2a-spec.md Evolve SDK integration section
 */

import type {
  SandboxInstance,
  SandboxProvider,
  SandboxCreateOptions,
  MultiAgentEntry,
  MultiAgentRunOptions,
  A2AConfig,
  A2AStreamLine,
  StreamCallbacks,
  AgentType,
  McpServerConfig,
  SkillName,
  FileMap,
  WorkspaceMode,
  ResolvedStorageConfig,
  AgentResponse,
  LifecycleEvent,
} from "./types";
import { SessionLogger } from "./observability";
import { createAgentParser, type AgentParser, type OutputEvent } from "./parsers";
import { getAgentConfig } from "./registry";
import { writeMcpConfig } from "./mcp";
import { buildWorkerSystemPrompt } from "./prompts";
import { DEFAULT_WORKING_DIR } from "./constants";

// =============================================================================
// TYPES
// =============================================================================

export interface MultiAgentOptions {
  agents: MultiAgentEntry[];
  sandboxProvider: SandboxProvider;
  /** Shared skills (merged with per-agent) */
  sharedSkills?: SkillName[];
  /** Shared MCP servers (merged with per-agent) */
  sharedMcpServers?: Record<string, McpServerConfig>;
  /** Environment secrets */
  secrets?: Record<string, string>;
  /** Workspace files */
  files?: FileMap;
  /** Context files */
  context?: FileMap;
  /** Workspace mode */
  workspaceMode?: WorkspaceMode;
  /** Working directory */
  workingDirectory?: string;
  /** Gateway mode API key (for session logging + spend tracking) */
  apiKey?: string;
  /** Is direct mode (user's own sandbox key) */
  isDirectMode?: boolean;
  /** Session tag prefix */
  sessionTagPrefix?: string;
  /** Observability metadata */
  observability?: Record<string, unknown>;
  /** Storage config */
  storage?: ResolvedStorageConfig;
}

/** Extended stream callbacks for multi-agent (includes agent tag) */
export interface MultiAgentStreamCallbacks extends StreamCallbacks {
  /** Called for agent-to-agent mailbox messages */
  onMailbox?: (message: unknown) => void;
}

// =============================================================================
// MULTI-AGENT RUNTIME
// =============================================================================

export class MultiAgentRuntime {
  private sandbox?: SandboxInstance;
  private options: MultiAgentOptions;
  private workingDir: string;

  // Per-agent parsers and session loggers
  private parsers: Map<string, AgentParser> = new Map();
  private sessionLoggers: Map<string, SessionLogger> = new Map();

  constructor(options: MultiAgentOptions) {
    this.options = options;
    this.workingDir = options.workingDirectory || DEFAULT_WORKING_DIR;
  }

  // ===========================================================================
  // SANDBOX
  // ===========================================================================

  async getSandbox(): Promise<SandboxInstance> {
    if (this.sandbox) return this.sandbox;

    const envVars = this.buildEnvironmentVariables();

    this.sandbox = await this.options.sandboxProvider.create({
      envs: envVars,
      workingDirectory: this.workingDir,
    });

    return this.sandbox;
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  /**
   * Full multi-agent run:
   *   1. Create sandbox
   *   2. Setup workspace + MCP/skills per agent
   *   3. Write A2A config → `a2a bootstrap`
   *   4. `a2a start` with seed message
   *   5. `a2a stream` → demux → per-agent parsers + loggers
   *   6. Wait for completion
   */
  async run(
    runOptions: MultiAgentRunOptions,
    callbacks?: MultiAgentStreamCallbacks,
  ): Promise<AgentResponse> {
    const sandbox = await this.getSandbox();
    const { prompt, seedTo = "*", timeoutMs } = runOptions;

    // --- Setup workspace structure ---
    await this.setupWorkspace(sandbox);

    // --- Setup per-agent MCP + skills ---
    await this.setupAgents(sandbox);

    // --- Write A2A config and bootstrap ---
    const config = this.buildA2AConfig(prompt);
    await sandbox.files.write(
      "/tmp/a2a-config.json",
      JSON.stringify(config, null, 2),
    );
    await sandbox.commands.run("a2a bootstrap --config /tmp/a2a-config.json");

    // --- Initialize per-agent parsers ---
    for (const agent of this.options.agents) {
      this.parsers.set(agent.type, createAgentParser(agent.type));
    }

    // --- Start watcher + seed message ---
    await sandbox.commands.run(
      `a2a start --to "${seedTo}" "${escapeForShell(prompt)}"`,
    );

    // --- Stream: spawn `a2a stream` and demux ---
    let lineBuffer = "";

    const handle = await sandbox.commands.spawn("a2a stream", {
      cwd: this.workingDir,
      timeoutMs,
      onStdout: (chunk: string) => {
        lineBuffer += chunk;
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          this.handleStreamLine(line, sandbox, callbacks);
        }
      },
      onStderr: (chunk: string) => {
        callbacks?.onStderr?.(chunk);
      },
    });

    // Wait for stream to end (watcher exits → agents done → stream EOF)
    const result = await handle.wait();

    // --- Stop and cleanup ---
    await sandbox.commands.run("a2a stop").catch(() => {});

    // Flush all session loggers
    await this.flushLoggers();

    return {
      sandboxId: sandbox.sandboxId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /**
   * Interrupt all agents (kill watcher), optionally send a new message and restart
   */
  async interrupt(): Promise<void> {
    if (!this.sandbox) return;
    await this.sandbox.commands.run("a2a stop").catch(() => {});
  }

  /**
   * Send a new message and restart with --no-clean (preserves state)
   */
  async send(
    prompt: string,
    seedTo: string = "*",
    callbacks?: MultiAgentStreamCallbacks,
  ): Promise<void> {
    if (!this.sandbox) throw new Error("No active sandbox");

    // Stop current agents
    await this.sandbox.commands.run("a2a stop").catch(() => {});

    // Restart with --no-clean (preserves log, cursors, sessions)
    await this.sandbox.commands.run(
      `a2a start --no-clean --to "${seedTo}" "${escapeForShell(prompt)}"`,
    );
  }

  async kill(): Promise<void> {
    if (!this.sandbox) return;
    await this.sandbox.commands.run("a2a stop").catch(() => {});
    await this.flushLoggers();
    await this.sandbox.kill();
    this.sandbox = undefined;
  }

  getSession(): string | null {
    return this.sandbox?.sandboxId ?? null;
  }

  // ===========================================================================
  // STREAM DEMUXER
  // ===========================================================================

  private handleStreamLine(
    line: string,
    sandbox: SandboxInstance,
    callbacks?: MultiAgentStreamCallbacks,
  ): void {
    let parsed: A2AStreamLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      return; // skip malformed lines
    }

    const { ch, agent, data } = parsed;

    switch (ch) {
      case "stdout": {
        if (!agent || typeof data !== "string") break;
        const parser = this.parsers.get(agent);
        const events = parser?.(data) ?? null;

        // Log to per-agent session logger
        const logger = this.getOrCreateLogger(agent as AgentType, sandbox);
        logger?.writeEventParsed(data, events);

        // Emit raw stdout (tagged with agent)
        callbacks?.onStdout?.(`[${agent}] ${data}\n`);

        // Emit parsed content events
        if (events && callbacks?.onContent) {
          for (const event of events) {
            // Tag event with agent name
            (event as any).agent = agent;
            callbacks.onContent(event);
          }
        }
        break;
      }

      case "stderr": {
        if (!agent || typeof data !== "string") break;
        callbacks?.onStderr?.(`[${agent}] ${data}`);
        break;
      }

      case "mailbox": {
        callbacks?.onMailbox?.(data);
        break;
      }

      case "lifecycle": {
        if (callbacks?.onLifecycle && agent) {
          callbacks.onLifecycle({
            sandboxId: sandbox.sandboxId,
            sandbox: "running",
            agent: "running",
            timestamp: new Date().toISOString(),
            reason: "run_start",
            ...(data as object),
          } as LifecycleEvent);
        }
        break;
      }
    }
  }

  // ===========================================================================
  // PER-AGENT SETUP
  // ===========================================================================

  /**
   * Setup MCP servers and skills for each agent in the sandbox.
   * Merges shared config with per-agent config.
   */
  private async setupAgents(sandbox: SandboxInstance): Promise<void> {
    for (const agent of this.options.agents) {
      const registry = getAgentConfig(agent.type);

      // Merge shared + per-agent MCP servers
      const mergedMcp: Record<string, McpServerConfig> = {
        ...this.options.sharedMcpServers,
        ...agent.mcpServers,
      };

      // Write MCP config if any servers configured
      if (Object.keys(mergedMcp).length > 0) {
        await writeMcpConfig(sandbox, agent.type, mergedMcp);
      }

      // Merge shared + per-agent skills
      const mergedSkills: SkillName[] = [
        ...(this.options.sharedSkills ?? []),
        ...(agent.skills ?? []),
      ];

      // Copy skills to agent's skills directory
      if (mergedSkills.length > 0) {
        const { sourceDir, targetDir } = registry.skillsConfig;
        for (const skill of mergedSkills) {
          await sandbox.commands.run(
            `cp -r ${sourceDir}/${skill} ${targetDir}/${skill} 2>/dev/null || true`,
          );
        }
      }
    }
  }

  /**
   * Setup workspace structure (same as single-agent)
   */
  private async setupWorkspace(sandbox: SandboxInstance): Promise<void> {
    // Create workspace directories
    const mode = this.options.workspaceMode ?? "knowledge";
    const dirs = [
      `${this.workingDir}/context`,
      `${this.workingDir}/scripts`,
      `${this.workingDir}/temp`,
      `${this.workingDir}/output`,
    ];
    if (mode === "swe") {
      dirs.push(`${this.workingDir}/repo`);
    }
    await sandbox.commands.run(`mkdir -p ${dirs.join(" ")}`);

    // Upload context files
    if (this.options.context) {
      const files = Object.entries(this.options.context).map(([name, data]) => ({
        path: `${this.workingDir}/context/${name}`,
        data,
      }));
      await sandbox.files.writeBatch(files);
    }

    // Upload workspace files
    if (this.options.files) {
      const files = Object.entries(this.options.files).map(([name, data]) => ({
        path: `${this.workingDir}/${name}`,
        data,
      }));
      await sandbox.files.writeBatch(files);
    }
  }

  // ===========================================================================
  // A2A CONFIG
  // ===========================================================================

  /**
   * Build A2A config JSON for `a2a bootstrap`.
   * Role prompts are passed as promptText — A2A package composes final prompt.
   */
  private buildA2AConfig(prompt: string): A2AConfig {
    const isGateway = !this.options.isDirectMode;

    return {
      gateway: isGateway,
      workspace: this.workingDir,
      agents: this.options.agents.map((agent) => ({
        type: agent.type,
        model: agent.model,
        promptText: buildRolePrompt(agent.role),
      })),
    };
  }

  // ===========================================================================
  // ENV VARS
  // ===========================================================================

  private buildEnvironmentVariables(): Record<string, string> {
    const envs: Record<string, string> = {};

    // Per-agent API keys from registry
    for (const agent of this.options.agents) {
      const registry = getAgentConfig(agent.type);
      const apiKey = this.options.secrets?.[registry.apiKeyEnv]
        || process.env[registry.apiKeyEnv]
        || this.options.apiKey;
      if (apiKey) {
        envs[registry.apiKeyEnv] = apiKey;
      }
    }

    // User secrets
    if (this.options.secrets) {
      Object.assign(envs, this.options.secrets);
    }

    return envs;
  }

  // ===========================================================================
  // SESSION LOGGERS
  // ===========================================================================

  private getOrCreateLogger(
    agentType: AgentType,
    sandbox: SandboxInstance,
  ): SessionLogger | undefined {
    if (this.options.isDirectMode) return undefined; // no dashboard in direct mode

    const existing = this.sessionLoggers.get(agentType);
    if (existing) return existing;

    const provider = this.options.sandboxProvider;
    const registry = getAgentConfig(agentType);

    const logger = new SessionLogger({
      provider: provider.name || provider.providerType || "unknown",
      agent: agentType,
      model: registry.defaultModel,
      sandboxId: sandbox.sandboxId,
      tagPrefix: this.options.sessionTagPrefix || "evolve-multi",
      apiKey: this.options.apiKey,
      observability: {
        ...this.options.observability,
        multiAgent: true,
      },
    });

    this.sessionLoggers.set(agentType, logger);
    return logger;
  }

  private async flushLoggers(): Promise<void> {
    const promises = Array.from(this.sessionLoggers.values()).map((l) =>
      l.close(),
    );
    await Promise.all(promises);
  }
}

// =============================================================================
// HELPERS
// =============================================================================

function escapeForShell(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\$/g, "\\$")
    .replace(/`/g, "\\`");
}

/**
 * Build role prompt text from a role key.
 * For now, passes role as-is. Later: SDK maps role keys to built-in prompts.
 */
function buildRolePrompt(role: string): string {
  return `You are the ${role}. Focus on your designated responsibilities and collaborate with other agents through the A2A protocol.`;
}
