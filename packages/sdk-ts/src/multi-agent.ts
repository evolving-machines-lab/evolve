/**
 * Multi-Agent Runtime
 *
 * Manages A2A protocol lifecycle inside a sandbox:
 *   1. Bootstrap — write config, install prompts
 *   2. Start — seed message, spawn watcher
 *   3. Stream — demux tagged NDJSON into per-agent parsers + loggers
 *   4. Stop — kill watcher + all agents
 *
 * Lifecycle events match single-agent: boot → ready → run_start → run_complete.
 * From the user's perspective, this is one run() regardless of agent count.
 *
 * Evidence: a2a-spec.md Evolve SDK integration section
 */

import { randomBytes } from "crypto";
import type {
  SandboxInstance,
  SandboxProvider,
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
  SandboxCommandResult,
  LifecycleEvent,
  LifecycleReason,
  SandboxLifecycleState,
  AgentRuntimeState,
  SessionStatus,
  CheckpointInfo,
} from "./types";
import { SessionLogger } from "./observability";
import { createAgentParser, type AgentParser, type OutputEvent } from "./parsers";
import { getAgentConfig } from "./registry";
import { writeMcpConfig } from "./mcp";
import { DEFAULT_WORKING_DIR } from "./constants";
import { createCheckpoint, restoreCheckpoint } from "./storage";

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

/** Extended stream callbacks for multi-agent (includes mailbox) */
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

  // State (matches single-agent lifecycle)
  private sandboxState: SandboxLifecycleState = "stopped";
  private agentState: AgentRuntimeState = "idle";
  private hasRun = false;
  private sessionTag: string;
  private lastCheckpointId?: string;

  // Per-agent parsers and session loggers
  private parsers: Map<string, AgentParser> = new Map();
  private sessionLoggers: Map<string, SessionLogger> = new Map();

  constructor(options: MultiAgentOptions) {
    // Enforce one instance per agent type (spec requirement)
    const types = options.agents.map(a => a.type);
    const dupes = types.filter((t, i) => types.indexOf(t) !== i);
    if (dupes.length > 0) {
      throw new Error(`Duplicate agent type(s): ${[...new Set(dupes)].join(", ")}. One instance per agent type.`);
    }

    this.options = options;
    this.workingDir = options.workingDirectory || DEFAULT_WORKING_DIR;
    this.sessionTag = `${options.sessionTagPrefix || "evolve-multi"}-${randomBytes(8).toString("hex")}`;
  }

  // ===========================================================================
  // SANDBOX
  // ===========================================================================

  private async ensureSandbox(callbacks?: StreamCallbacks): Promise<SandboxInstance> {
    if (this.sandbox) return this.sandbox;

    this.sandboxState = "booting";
    this.emitLifecycle(callbacks, "sandbox_boot");

    const envVars = this.buildEnvironmentVariables();

    this.sandbox = await this.options.sandboxProvider.create({
      envs: envVars,
      workingDirectory: this.workingDir,
    });

    this.sandboxState = "ready";
    this.agentState = "idle";
    this.emitLifecycle(callbacks, "sandbox_ready");

    return this.sandbox;
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  /**
   * Full multi-agent run:
   *   1. Create sandbox (or restore from checkpoint)
   *   2. Setup workspace + MCP/skills per agent
   *   3. Write A2A config → `a2a bootstrap`
   *   4. `a2a start` with seed message
   *   5. `a2a stream` → demux → per-agent parsers + loggers
   *   6. Wait for completion
   *   7. Auto-checkpoint if storage configured
   */
  async run(
    runOptions: MultiAgentRunOptions,
    callbacks?: MultiAgentStreamCallbacks,
  ): Promise<AgentResponse> {
    const { prompt, seedTo = "*", timeoutMs, from, checkpointComment } = runOptions;

    // --- Restore from checkpoint if requested ---
    if (from && !this.options.storage) {
      throw new Error("Cannot restore from checkpoint without storage configured. Call .withStorage().");
    }

    let sandbox: SandboxInstance;
    if (from && this.options.storage) {
      sandbox = await this.restoreFromCheckpoint(from, callbacks);
    } else {
      sandbox = await this.ensureSandbox(callbacks);

      // Fresh run: full setup
      await this.setupWorkspace(sandbox);
      await this.setupAgents(sandbox);

      const config = this.buildA2AConfig();
      await sandbox.files.write(
        "/tmp/a2a-config.json",
        JSON.stringify(config, null, 2),
      );
      await sandbox.commands.run("a2a bootstrap --config /tmp/a2a-config.json");
    }

    // --- Initialize per-agent parsers ---
    for (const agent of this.options.agents) {
      if (!this.parsers.has(agent.type)) {
        this.parsers.set(agent.type, createAgentParser(agent.type));
      }
    }

    // --- Mark running ---
    this.agentState = "running";
    this.emitLifecycle(callbacks, "run_start");

    // --- Start watcher + seed message ---
    const startCmd = this.hasRun
      ? `a2a start --no-clean --to "${seedTo}" "${escapeForShell(prompt)}"`
      : `a2a start --to "${seedTo}" "${escapeForShell(prompt)}"`;
    await sandbox.commands.run(startCmd);

    // --- Stream until completion ---
    const result = await this.streamUntilDone(sandbox, callbacks, timeoutMs);

    this.hasRun = true;
    const success = result.exitCode === 0;
    this.agentState = success ? "idle" : "error";
    this.emitLifecycle(callbacks, success ? "run_complete" : "run_failed");

    // --- Auto-checkpoint if storage configured ---
    let checkpoint: CheckpointInfo | undefined;
    if (this.options.storage && success) {
      try {
        checkpoint = await this.checkpoint({ comment: checkpointComment });
      } catch (e) {
        console.warn(`[Evolve] Auto-checkpoint failed: ${(e as Error).message}`);
      }
    }

    // Flush all session loggers
    await this.flushLoggers();

    return {
      sandboxId: sandbox.sandboxId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      checkpoint,
    };
  }

  /**
   * Interrupt all agents (kill watcher)
   */
  async interrupt(callbacks?: StreamCallbacks): Promise<void> {
    if (!this.sandbox) return;
    await this.sandbox.commands.run("a2a stop").catch(() => {});
    this.agentState = "interrupted";
    this.emitLifecycle(callbacks, "run_interrupted");
  }

  /**
   * Send a new message and restart agents (preserves state via --no-clean).
   * Returns a new stream handle — caller should read it.
   */
  async send(
    prompt: string,
    seedTo: string = "*",
    callbacks?: MultiAgentStreamCallbacks,
  ): Promise<AgentResponse> {
    if (!this.sandbox) throw new Error("No active sandbox. Call run() first.");

    // Stop current agents
    await this.sandbox.commands.run("a2a stop").catch(() => {});

    // Restart with --no-clean + new message, then stream
    this.agentState = "running";
    this.emitLifecycle(callbacks, "run_start");

    const sandbox = this.sandbox;
    await sandbox.commands.run(
      `a2a start --no-clean --to "${seedTo}" "${escapeForShell(prompt)}"`,
    );

    const result = await this.streamUntilDone(sandbox, callbacks);

    const success = result.exitCode === 0;
    this.agentState = success ? "idle" : "error";
    this.emitLifecycle(callbacks, success ? "run_complete" : "run_failed");

    return {
      sandboxId: sandbox.sandboxId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /**
   * Create a checkpoint of the current sandbox state.
   * Includes workspace + all agent dirs + ~/.a2a/ (excluding pids/.lock).
   */
  async checkpoint(options?: { comment?: string }): Promise<CheckpointInfo> {
    if (!this.sandbox) throw new Error("No active sandbox");
    if (!this.options.storage) throw new Error("Storage not configured");

    const primaryType = this.options.agents[0].type;
    const tarCmd = this.buildMultiAgentTarCommand();

    const result = await createCheckpoint(
      this.sandbox,
      this.options.storage,
      primaryType,
      this.workingDir,
      {
        tag: this.sessionTag,
        model: this.options.agents.map(a => a.model || getAgentConfig(a.type).defaultModel).join(","),
        workspaceMode: this.options.workspaceMode || "knowledge",
        comment: options?.comment,
        parentId: this.lastCheckpointId,
      },
      tarCmd,
    );

    this.lastCheckpointId = result.id;
    return result;
  }

  async kill(callbacks?: StreamCallbacks): Promise<void> {
    if (!this.sandbox) return;
    await this.sandbox.commands.run("a2a stop").catch(() => {});
    await this.flushLoggers();
    await this.sandbox.kill();
    this.sandbox = undefined;
    this.sandboxState = "stopped";
    this.agentState = "idle";
    this.emitLifecycle(callbacks, "sandbox_killed");
  }

  async pause(callbacks?: StreamCallbacks): Promise<void> {
    if (!this.sandbox) return;
    await this.sandbox.commands.run("a2a stop").catch(() => {});
    await this.sandbox.pause();
    this.sandboxState = "paused";
    this.agentState = "idle";
    this.emitLifecycle(callbacks, "sandbox_pause");
  }

  async resume(callbacks?: StreamCallbacks): Promise<void> {
    if (!this.sandbox) return;
    // Reconnect (unpause)
    this.sandbox = await this.options.sandboxProvider.connect(this.sandbox.sandboxId);
    this.sandboxState = "ready";
    this.agentState = "idle";
    this.emitLifecycle(callbacks, "sandbox_resume");
  }

  getSession(): string | null {
    return this.sandbox?.sandboxId ?? null;
  }

  getSessionTag(): string {
    return this.sessionTag;
  }

  status(): SessionStatus {
    return {
      sandboxId: this.sandbox?.sandboxId ?? null,
      sandbox: this.sandboxState,
      agent: this.agentState,
      activeProcessId: null,
      hasRun: this.hasRun,
      timestamp: new Date().toISOString(),
    };
  }

  async flushObservability(): Promise<void> {
    await this.flushLoggers();
  }

  // ===========================================================================
  // RESTORE FROM CHECKPOINT
  // ===========================================================================

  private async restoreFromCheckpoint(
    from: string,
    callbacks?: StreamCallbacks,
  ): Promise<SandboxInstance> {
    if (!this.options.storage) throw new Error("Storage not configured");

    this.sandboxState = "booting";
    this.emitLifecycle(callbacks, "sandbox_boot");

    const envVars = this.buildEnvironmentVariables();
    this.sandbox = await this.options.sandboxProvider.create({
      envs: envVars,
      workingDirectory: this.workingDir,
    });

    // Restore checkpoint archive into sandbox
    await restoreCheckpoint(this.sandbox, this.options.storage, from);

    this.sandboxState = "ready";
    this.agentState = "idle";
    this.hasRun = true; // restored = has prior state
    this.emitLifecycle(callbacks, "sandbox_ready");

    return this.sandbox;
  }

  // ===========================================================================
  // STREAM DEMUXER
  // ===========================================================================

  /**
   * Spawn `a2a stream`, demux lines, wait for completion, then stop.
   */
  private async streamUntilDone(
    sandbox: SandboxInstance,
    callbacks?: MultiAgentStreamCallbacks,
    timeoutMs?: number,
  ): Promise<SandboxCommandResult> {
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

    const result = await handle.wait();

    if (lineBuffer.trim()) {
      this.handleStreamLine(lineBuffer, sandbox, callbacks);
    }

    await sandbox.commands.run("a2a stop").catch(() => {});
    return result;
  }

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

        // Emit parsed content events (attach agent name for multi-agent consumers)
        if (events && callbacks?.onContent) {
          for (const event of events) {
            callbacks.onContent(Object.assign({}, event, { agent }));
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
        // A2A lifecycle events are internal — we don't surface them as
        // SDK lifecycle events. The SDK lifecycle is boot → ready → run → complete.
        break;
      }
    }
  }

  // ===========================================================================
  // PER-AGENT SETUP
  // ===========================================================================

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
        await writeMcpConfig(agent.type, sandbox, this.workingDir, mergedMcp);
      }

      // Merge shared + per-agent skills (deduplicated)
      const mergedSkills = [...new Set([
        ...(this.options.sharedSkills ?? []),
        ...(agent.skills ?? []),
      ])];

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

  private async setupWorkspace(sandbox: SandboxInstance): Promise<void> {
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

    if (this.options.context) {
      const files = Object.entries(this.options.context).map(([name, data]) => ({
        path: `${this.workingDir}/context/${name}`,
        data,
      }));
      await sandbox.files.writeBatch(files);
    }

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

  private buildA2AConfig(): A2AConfig {
    return {
      gateway: !this.options.isDirectMode,
      workspace: this.workingDir,
      agents: this.options.agents.map((agent) => ({
        type: agent.type,
        model: agent.model,
        promptText: buildRolePrompt(agent.role),
      })),
    };
  }

  // ===========================================================================
  // TAR COMMAND (multi-agent checkpoint)
  // ===========================================================================

  /**
   * Build tar command that includes:
   *   - workspace/
   *   - ~/.a2a/ (excluding internal/pids/ and internal/.lock)
   *   - All agent settings dirs (~/.claude/, ~/.codex/, etc.)
   */
  private buildMultiAgentTarCommand(): string {
    const workspaceDir = this.workingDir.startsWith("/home/user/")
      ? this.workingDir.slice("/home/user/".length)
      : "workspace";

    // Collect all agent settings dirs
    const agentDirs = new Set<string>();
    for (const agent of this.options.agents) {
      const registry = getAgentConfig(agent.type);
      const dirs = registry.checkpointDirs?.length
        ? registry.checkpointDirs
        : [registry.mcpConfig.settingsDir];
      for (const d of dirs) {
        const normalized = d.startsWith("~/") ? d.slice(2) : d.startsWith("/home/user/") ? d.slice("/home/user/".length) : d;
        agentDirs.add(normalized);
      }
    }

    const excludes = [
      "node_modules", "__pycache__", "*.pyc", ".cache", ".npm", ".pip", ".venv", "venv",
      // A2A excludes (stale PIDs + lock)
      ".a2a/internal/pids",
      ".a2a/internal/.lock",
      // Workspace temp
      `${workspaceDir}/temp`,
    ].map(e => `--exclude='${e}'`).join(" ");

    const dirs = [
      `'${workspaceDir}/'`,
      `'.a2a/'`,
      ...Array.from(agentDirs).map(d => `'${d}/'`),
    ].join(" ");

    return [
      `tar -czf /tmp/evolve-ckpt.tar.gz -C /home/user ${excludes} ${dirs}`,
      `sha256sum /tmp/evolve-ckpt.tar.gz | awk '{print $1}'`,
    ].join(" && ");
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
    if (this.options.isDirectMode) return undefined;

    const existing = this.sessionLoggers.get(agentType);
    if (existing) return existing;

    const provider = this.options.sandboxProvider;
    const entry = this.options.agents.find(a => a.type === agentType);
    const registry = getAgentConfig(agentType);

    const logger = new SessionLogger({
      provider: provider.name || provider.providerType || "unknown",
      agent: agentType,
      model: entry?.model || registry.defaultModel,
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

  // ===========================================================================
  // LIFECYCLE HELPERS
  // ===========================================================================

  private emitLifecycle(callbacks: StreamCallbacks | undefined, reason: LifecycleReason): void {
    callbacks?.onLifecycle?.({
      sandboxId: this.sandbox?.sandboxId ?? null,
      sandbox: this.sandboxState,
      agent: this.agentState,
      timestamp: new Date().toISOString(),
      reason,
    });
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

function buildRolePrompt(role: string): string {
  return `You are the ${role}. Focus on your designated responsibilities and collaborate with other agents through the A2A protocol.`;
}
