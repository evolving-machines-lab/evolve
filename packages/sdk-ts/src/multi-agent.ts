/**
 * Multi-Agent Runtime
 *
 * Orchestrates multiple CLI agents inside a single sandbox.
 * From the SDK consumer's perspective, this is one run() regardless of agent count.
 */

import { randomBytes } from "crypto";
import type {
  SandboxInstance,
  SandboxProvider,
  MultiAgentEntry,
  MultiAgentRunOptions,
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
import { DEFAULT_WORKING_DIR, DEFAULT_TIMEOUT_MS } from "./constants";
import { buildWorkerSystemPrompt } from "./prompts";
import { createCheckpoint, restoreCheckpoint, getLatestCheckpoint } from "./storage";

// =============================================================================
// INTERNAL PROTOCOL TYPES (not exported)
// =============================================================================

interface A2AConfig {
  root: string;
  gateway: boolean;
  workspace: string;
  agents: Array<{
    type: AgentType;
    model?: string;
    role?: string;
    promptText?: string;
  }>;
}

interface A2AStreamLine {
  ch: "stdout" | "stderr" | "mailbox" | "lifecycle";
  agent?: string;
  data: unknown;
}

// =============================================================================
// TYPES
// =============================================================================

export interface MultiAgentOptions {
  agents: MultiAgentEntry[];
  sandboxProvider: SandboxProvider;
  /** Existing sandbox ID to reconnect to */
  sandboxId?: string;
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
  /** Shared system prompt (fallback for agents without per-agent systemPrompt) */
  systemPrompt?: string;
  /** Shared schema (fallback for agents without per-agent schema) */
  schema?: unknown;
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
  private sessionTimestamp?: string;
  private pendingPrompt?: string;
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

    // Enforce mutual exclusion: shared OR per-agent, not both
    if (options.systemPrompt && options.agents.some(a => a.systemPrompt)) {
      throw new Error(
        "Cannot use both .withSystemPrompt() and per-agent systemPrompt. Use one or the other."
      );
    }
    if (options.schema && options.agents.some(a => a.schema)) {
      throw new Error(
        "Cannot use both .withSchema() and per-agent schema. Use one or the other."
      );
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

    if (this.options.sandboxId) {
      // Reconnect to existing sandbox
      this.sandbox = await this.options.sandboxProvider.connect(this.options.sandboxId);
      this.hasRun = true;
    } else {
      const envVars = this.buildEnvironmentVariables();
      this.sandbox = await this.options.sandboxProvider.create({
        envs: envVars,
        workingDirectory: this.workingDir,
      });
    }

    this.sandboxState = "ready";
    this.agentState = "idle";
    this.emitLifecycle(callbacks, "sandbox_ready");

    return this.sandbox;
  }

  // ===========================================================================
  // LIFECYCLE
  // ===========================================================================

  /** Full multi-agent run. */
  async run(
    runOptions: MultiAgentRunOptions,
    callbacks?: MultiAgentStreamCallbacks,
  ): Promise<AgentResponse> {
    if (this.agentState === "running") {
      throw new Error("Multi-agent runtime is already running. Wait for completion or call interrupt().");
    }

    const { prompt, seedTo = "*", timeoutMs = DEFAULT_TIMEOUT_MS, checkpointComment } = runOptions;
    let from = runOptions.from;

    // --- Restore from checkpoint if requested ---
    if (from && !this.options.storage) {
      throw new Error("Cannot restore from checkpoint without storage configured. Call .withStorage().");
    }

    // Resolve "latest" to concrete checkpoint ID
    if (from === "latest" && this.options.storage) {
      const latest = await getLatestCheckpoint(this.options.storage);
      if (!latest) {
        throw new Error('No checkpoints found for from: "latest".');
      }
      from = latest.id;
    }

    let sandbox: SandboxInstance;
    if (from && this.options.storage) {
      sandbox = await this.restoreFromCheckpoint(from, callbacks);
    } else {
      sandbox = await this.ensureSandbox(callbacks);

      // Fresh run: full setup (independent, run in parallel)
      await Promise.all([this.setupWorkspace(sandbox), this.setupAgents(sandbox)]);

      const config = this.buildA2AConfig();
      await sandbox.files.write(
        "/tmp/a2a-config.json",
        JSON.stringify(config, null, 2),
      );
      await this.runOrThrow(sandbox, "a2a bootstrap --config /tmp/a2a-config.json", "bootstrap");
    }

    // --- Initialize per-agent parsers ---
    for (const agent of this.options.agents) {
      if (!this.parsers.has(agent.type)) {
        this.parsers.set(agent.type, createAgentParser(agent.type));
      }
    }

    // Store prompt so loggers write it when first created during streaming
    this.pendingPrompt = prompt;

    // --- Mark running ---
    if (!this.sessionTimestamp) {
      this.sessionTimestamp = new Date().toISOString();
    }
    this.agentState = "running";
    this.emitLifecycle(callbacks, "run_start");

    // --- Start watcher + seed message ---
    const startCmd = this.hasRun
      ? `a2a start --no-clean --to "${escapeForShell(seedTo)}" "${escapeForShell(prompt)}"`
      : `a2a start --to "${escapeForShell(seedTo)}" "${escapeForShell(prompt)}"`;
    await this.runOrThrow(sandbox, startCmd, "start", callbacks);

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


  /** Create a checkpoint of the current sandbox state. */
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
    this.hasRun = false;
    this.lastCheckpointId = undefined;
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

  getSessionTimestamp(): string | null {
    return this.sessionTimestamp ?? null;
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

  /** Stream output from all agents until completion. */
  private async streamUntilDone(
    sandbox: SandboxInstance,
    callbacks?: MultiAgentStreamCallbacks,
    timeoutMs?: number,
  ): Promise<SandboxCommandResult> {
    let lineBuffer = "";

    const handle = await sandbox.commands.spawn("a2a stream", {
      cwd: this.workingDir,
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

    // Poll watcher PID to detect completion (stream.py won't exit on its own)
    const startTime = Date.now();
    const pollMs = 2000;
    // Give agents time to start before first status check
    await new Promise(r => setTimeout(r, 5000));

    while (true) {
      if (timeoutMs && (Date.now() - startTime) > timeoutMs) {
        break; // timeout
      }

      const statusResult = await sandbox.commands.run(
        "test -f ~/.a2a/internal/pids/watcher.pid && kill -0 $(cat ~/.a2a/internal/pids/watcher.pid) 2>/dev/null && echo running || echo done",
      ).catch(() => ({ stdout: "done", stderr: "", exitCode: 1 }));

      if (statusResult.stdout.trim() === "done") {
        // Watcher exited — agents finished, give stream a moment to flush
        await new Promise(r => setTimeout(r, 500));
        break;
      }

      await new Promise(r => setTimeout(r, pollMs));
    }

    // Flush remaining buffer
    if (lineBuffer.trim()) {
      this.handleStreamLine(lineBuffer, sandbox, callbacks);
    }

    // Kill stream process (infinite loop) and stop any remaining agents
    await handle.kill().catch(() => {});
    await sandbox.commands.run("a2a stop").catch(() => {});

    return {
      exitCode: timeoutMs && (Date.now() - startTime) > timeoutMs ? 124 : 0,
      stdout: "",
      stderr: "",
    };
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
        const msg = data as Record<string, unknown>;
        const sender = typeof msg.from === "string" ? msg.from : undefined;
        if (sender) {
          const logger = this.getOrCreateLogger(sender as AgentType, sandbox);
          logger?.writeMailbox(msg);
        }
        callbacks?.onMailbox?.(data);
        break;
      }

      case "lifecycle": {
        // Internal lifecycle events — not surfaced to SDK consumers.
        break;
      }
    }
  }

  // ===========================================================================
  // PER-AGENT SETUP
  // ===========================================================================

  private async setupAgents(sandbox: SandboxInstance): Promise<void> {
    await Promise.all(this.options.agents.map(async (agent) => {
      const registry = getAgentConfig(agent.type);

      // Write system prompt + schema to agent's MD file (per-agent overrides shared)
      const prompt = agent.systemPrompt ?? this.options.systemPrompt;
      const schema = agent.schema ?? this.options.schema;
      if (prompt || schema || this.options.workspaceMode) {
        const fullPrompt = buildWorkerSystemPrompt({
          workingDir: this.workingDir,
          systemPrompt: prompt,
          schema: schema as any,
          mode: this.options.workspaceMode ?? "knowledge",
        });
        const filePath = `${this.workingDir}/${registry.systemPromptFile}`;
        await sandbox.files.write(filePath, fullPrompt);
      }

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
        await sandbox.files.makeDir(targetDir);
        const srcs = mergedSkills.map(s => `${sourceDir}/${s}`).join(" ");
        await sandbox.commands.run(`cp -r ${srcs} ${targetDir}/ 2>/dev/null || true`);
      }
    }));
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
  // CONFIG
  // ===========================================================================

  private buildA2AConfig(): A2AConfig {
    return {
      root: "/home/user/.a2a",
      gateway: !this.options.isDirectMode,
      workspace: this.workingDir,
      agents: this.options.agents.map((agent) => ({
        type: agent.type,
        model: agent.model,
        role: agent.role,
        promptText: agent.rolePrompt,
      })),
    };
  }

  // ===========================================================================
  // TAR COMMAND (multi-agent checkpoint)
  // ===========================================================================

  /** Build tar command for multi-agent checkpoint. */
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
      // Protocol state excludes
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
      tag: this.sessionTag,
      apiKey: this.options.apiKey,
      observability: {
        ...this.options.observability,
        multiAgent: true,
      },
    });

    // Write pending prompt if this is a fresh logger
    if (this.pendingPrompt) {
      logger.writePrompt(this.pendingPrompt);
    }

    this.sessionLoggers.set(agentType, logger);
    return logger;
  }

  private async flushLoggers(): Promise<void> {
    const promises = Array.from(this.sessionLoggers.values()).map((l) =>
      l.close(),
    );
    await Promise.all(promises);
    this.sessionLoggers.clear();
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

  /** Run a sandbox command and throw on non-zero exit. */
  private async runOrThrow(
    sandbox: SandboxInstance,
    cmd: string,
    label: string,
    callbacks?: StreamCallbacks,
  ): Promise<SandboxCommandResult> {
    const result = await sandbox.commands.run(cmd);
    if (result.exitCode !== 0) {
      this.agentState = "error";
      if (callbacks) this.emitLifecycle(callbacks, "run_failed");
      throw new Error(`Multi-agent ${label} failed (exit ${result.exitCode}): ${result.stderr}`);
    }
    return result;
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

