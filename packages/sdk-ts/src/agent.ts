/**
 * Unified Agent Implementation
 *
 * Single Agent class that uses registry lookup for agent-specific behavior.
 * All agent differences are data (in registry), not code.
 *
 * Evidence: sdk-rewrite-v3.md Design Decisions section
 */

import type { z } from "zod";
import Ajv, { type ValidateFunction } from "ajv";
import { randomUUID, randomBytes } from "crypto";
import type {
  AgentType,
  SandboxInstance,
  SandboxCommandHandle,
  FileMap,
  AgentConfig,
  ResolvedAgentConfig,
  AgentOptions,
  RunOptions,
  ExecuteCommandOptions,
  AgentResponse,
  OutputResult,
  StreamCallbacks,
  JsonSchema,
  SchemaValidationOptions,
  SkillName,
  McpServerConfig,
  AgentRuntimeState,
  SandboxLifecycleState,
  LifecycleReason,
  SessionStatus,
  LifecycleEvent,
  ResolvedStorageConfig,
  CheckpointInfo,
} from "./types";
import { VALIDATION_PRESETS } from "./types";
import { getAgentConfig, type AgentRegistryEntry } from "./registry";
import { writeMcpConfig } from "./mcp";
import { createAgentParser, type AgentParser } from "./parsers";
import { DEFAULT_TIMEOUT_MS, DEFAULT_WORKING_DIR, getGatewayUrl, getGeminiGatewayUrl } from "./constants";
import { buildWorkerSystemPrompt } from "./prompts";
import { isZodSchema } from "./utils";
import { SessionLogger } from "./observability";
import { setupComposio } from "./composio";
import { createCheckpoint, restoreCheckpoint, getLatestCheckpoint, type RestoreMetadata } from "./storage";

// Re-export types for external consumers
export type {
  AgentConfig,
  AgentOptions,
  RunOptions,
  ExecuteCommandOptions,
  AgentResponse,
  StreamCallbacks,
  AgentRuntimeState,
  SandboxLifecycleState,
  SessionStatus,
  LifecycleEvent,
};

// =============================================================================
// PROMPT ESCAPING
// =============================================================================

/**
 * Escape prompt for bash double-quoted strings
 *
 * Only escape characters that are special inside double quotes.
 * Evidence: sdk-rewrite-v3.md Prompt Escaping section
 */
function escapePrompt(prompt: string): string {
  return prompt
    .replace(/\\/g, "\\\\") // Escape backslashes FIRST
    .replace(/"/g, '\\"') // Escape double quotes
    .replace(/\$/g, "\\$") // Escape dollar signs
    .replace(/`/g, "\\`"); // Escape backticks (command substitution)
}

// =============================================================================
// SPEND TRACKING HELPERS
// =============================================================================

/** Generate a session tag: `{prefix}-{16 hex chars}` */
function generateSessionTag(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

/**
 * Merge spend tracking headers into an existing ANTHROPIC_CUSTOM_HEADERS value.
 * Preserves user-supplied headers; spend headers overwrite only matching keys.
 * Format: newline-separated "Name: Value" pairs.
 */
function mergeCustomHeaders(existing: string | undefined, updates: Record<string, string>): string {
  const merged = new Map<string, string>();

  // Parse existing headers (case-insensitive key lookup)
  if (existing) {
    for (const line of existing.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const colon = trimmed.indexOf(":");
      if (colon <= 0) continue;
      const name = trimmed.slice(0, colon).trim();
      const value = trimmed.slice(colon + 1).trim();
      merged.set(name.toLowerCase(), `${name}: ${value}`);
    }
  }

  // Apply updates (overwrites matching keys)
  for (const [name, value] of Object.entries(updates)) {
    merged.set(name.toLowerCase(), `${name}: ${value}`);
  }

  return Array.from(merged.values()).join("\n");
}

// =============================================================================
// AGENT CLASS
// =============================================================================

/**
 * Unified Agent class
 *
 * Uses registry lookup for agent-specific behavior.
 * Tracks hasRun state for continue flag handling.
 */
export class Agent {
  private agentConfig: ResolvedAgentConfig;
  private options: AgentOptions;
  private sandbox?: SandboxInstance;
  private hasRun: boolean = false;
  private readonly workingDir: string;
  private lastRunTimestamp?: number;
  private readonly registry: AgentRegistryEntry;
  /** Unified session ID — used for both observability (SessionLogger) and spend tracking (LiteLLM customer-id) */
  private sessionTag: string;
  private sessionLogger?: SessionLogger;
  private activeCommand?: SandboxCommandHandle;
  private activeProcessId: string | null = null;
  private activeOperationId: number | null = null;
  private activeOperationKind: "run" | "command" | null = null;
  private nextOperationId: number = 0;
  private interruptedOperations = new Set<number>();
  private sandboxState: SandboxLifecycleState;
  private agentState: AgentRuntimeState = "idle";

  // Skills storage
  private readonly skills?: SkillName[];

  // Storage / Checkpointing
  private readonly storage?: ResolvedStorageConfig;
  private lastCheckpointId?: string;

  // Schema storage (mutually exclusive)
  private readonly zodSchema?: z.ZodType<unknown>;
  private readonly jsonSchema?: JsonSchema;
  private readonly schemaOptions?: SchemaValidationOptions;
  private readonly compiledValidator?: ValidateFunction;

  constructor(agentConfig: ResolvedAgentConfig, options: AgentOptions = {}) {
    this.agentConfig = agentConfig;
    this.options = options;
    this.workingDir = options.workingDirectory || DEFAULT_WORKING_DIR;
    this.sandboxState = options.sandboxId ? "ready" : "stopped";

    // Store skills
    this.skills = options.skills;

    // Store storage config
    this.storage = options.storage;

    // Auto-detect and store schema type
    if (options.schema) {
      if (isZodSchema(options.schema)) {
        this.zodSchema = options.schema;
        if (options.schemaOptions) {
          console.warn("[Evolve] schemaOptions ignored for Zod schemas - use .passthrough(), .strip(), z.coerce instead");
        }
      } else {
        // JSON Schema - validate at config time (fail fast)
        this.jsonSchema = options.schema as JsonSchema;
        this.schemaOptions = options.schemaOptions;

        // Compile schema (validates it's valid JSON Schema + creates reusable validator)
        try {
          const ajv = this.createAjvValidator();
          this.compiledValidator = ajv.compile(this.jsonSchema);
        } catch (e) {
          throw new Error(`Invalid JSON Schema: ${(e as Error).message}`);
        }
      }
    }

    // Cache registry lookup once in constructor
    this.registry = getAgentConfig(agentConfig.type);

    // Unified session tag — generated early for spend tracking headers at sandbox creation,
    // then shared with SessionLogger on first run(). Rotated on kill()/setSession().
    this.sessionTag = generateSessionTag(options.sessionTagPrefix || "evolve");
  }

  private emitLifecycle(callbacks: StreamCallbacks | undefined, reason: LifecycleReason): void {
    callbacks?.onLifecycle?.({
      sandboxId: this.getSession(),
      sandbox: this.sandboxState,
      agent: this.agentState,
      timestamp: new Date().toISOString(),
      reason,
    });
  }

  private invalidateActiveOperation(): void {
    this.activeCommand = undefined;
    this.activeProcessId = null;
    this.activeOperationId = null;
    this.activeOperationKind = null;
  }

  private beginOperation(
    kind: "run" | "command",
    handle: SandboxCommandHandle,
    callbacks: StreamCallbacks | undefined,
    reason: LifecycleReason
  ): number {
    const opId = ++this.nextOperationId;
    this.activeOperationId = opId;
    this.activeOperationKind = kind;
    this.activeCommand = handle;
    this.activeProcessId = handle.processId;
    this.sandboxState = "running";
    this.agentState = "running";
    this.emitLifecycle(callbacks, reason);
    return opId;
  }

  private finalizeOperation(
    opId: number,
    callbacks: StreamCallbacks | undefined,
    reason: LifecycleReason,
    nextAgentState: AgentRuntimeState = "idle",
    nextSandboxState: SandboxLifecycleState = "ready"
  ): boolean {
    if (this.activeOperationId !== opId) {
      return false;
    }
    this.invalidateActiveOperation();
    this.sandboxState = nextSandboxState;
    this.agentState = nextAgentState;
    this.emitLifecycle(callbacks, reason);
    return true;
  }

  private watchBackgroundOperation(
    opId: number,
    kind: "run" | "command",
    handle: SandboxCommandHandle,
    callbacks?: StreamCallbacks
  ): void {
    const completeReason: LifecycleReason =
      kind === "run" ? "run_background_complete" : "command_background_complete";
    const failedReason: LifecycleReason =
      kind === "run" ? "run_background_failed" : "command_background_failed";
    const interruptedReason: LifecycleReason =
      kind === "run" ? "run_interrupted" : "command_interrupted";

    void handle
      .wait()
      .then((result) => {
        const interrupted = this.interruptedOperations.delete(opId) || result.exitCode === 130;
        if (interrupted) {
          this.finalizeOperation(opId, callbacks, interruptedReason, "interrupted");
          return;
        }
        const reason = result.exitCode === 0 ? completeReason : failedReason;
        const nextState = result.exitCode === 0 ? "idle" : "error";
        this.finalizeOperation(opId, callbacks, reason, nextState);
      })
      .catch(() => {
        this.interruptedOperations.delete(opId);
        this.finalizeOperation(opId, callbacks, failedReason, "error");
      });
  }

  /**
   * Create Ajv validator instance with configured options
   */
  private createAjvValidator(): Ajv {
    // Start with loose preset (default), then apply mode, then individual options
    const preset = VALIDATION_PRESETS[this.schemaOptions?.mode || "loose"];
    const opts = {
      ...preset,
      // Individual options override preset
      ...(this.schemaOptions?.coerceTypes !== undefined && { coerceTypes: this.schemaOptions.coerceTypes }),
      ...(this.schemaOptions?.removeAdditional !== undefined && { removeAdditional: this.schemaOptions.removeAdditional }),
      ...(this.schemaOptions?.useDefaults !== undefined && { useDefaults: this.schemaOptions.useDefaults }),
      ...(this.schemaOptions?.allErrors !== undefined && { allErrors: this.schemaOptions.allErrors }),
    };
    // Disable strict mode - allows unknown formats (e.g., date-time from Pydantic schemas)
    // Ajv validates structure, Pydantic handles format validation for rich types
    return new Ajv({ ...opts, strict: false });
  }

  // ===========================================================================
  // SANDBOX MANAGEMENT
  // ===========================================================================

  /**
   * Get or create sandbox instance
   */
  async getSandbox(callbacks?: StreamCallbacks): Promise<SandboxInstance> {
    if (this.sandbox) return this.sandbox;

    if (!this.options.sandboxProvider) {
      throw new Error("No sandbox provider configured");
    }

    const provider = this.options.sandboxProvider;
    this.sandboxState = "booting";
    this.emitLifecycle(callbacks, "sandbox_boot");
    try {
      if (this.options.sandboxId) {
        // Connect to existing sandbox - skip setup
        if (
          this.options.mcpServers ||
          this.options.context ||
          this.options.files ||
          this.options.systemPrompt
        ) {
          console.warn(
            "[Evolve] Connecting to existing sandbox - ignoring mcpServers, context, files, and systemPrompt"
          );
        }
        this.sandbox = await provider.connect(this.options.sandboxId);
        // Existing sandbox may have prior runs - use resume/continue command
        this.hasRun = true;
        this.sandboxState = "ready";
        this.agentState = "idle";
        this.emitLifecycle(callbacks, "sandbox_connected");
      } else {
        // Create new sandbox with full initialization
        const envVars = this.buildEnvironmentVariables();

        this.sandbox = await provider.create({
          envs: envVars,
          workingDirectory: this.workingDir,
        });

        // Agent-specific setup (e.g., codex login)
        await this.setupAgentAuth(this.sandbox);

        // Workspace setup
        await this.setupWorkspace(this.sandbox);
        this.sandboxState = "ready";
        this.agentState = "idle";
        this.emitLifecycle(callbacks, "sandbox_ready");
      }
    } catch (error) {
      this.sandboxState = "error";
      this.agentState = "error";
      this.emitLifecycle(callbacks, "sandbox_error");
      throw error;
    }

    return this.sandbox;
  }

  /**
   * Build environment variables for sandbox
   */
  private buildEnvironmentVariables(): Record<string, string> {
    const envVars: Record<string, string> = {};

    // File-based OAuth (Codex, Gemini): auth file handles auth, no API key env var needed
    if (this.agentConfig.oauthFileContent) {
      // Some agents need an activation env var (e.g., Gemini needs GOOGLE_GENAI_USE_GCA=true)
      if (this.registry.oauthActivationEnv) {
        envVars[this.registry.oauthActivationEnv.key] = this.registry.oauthActivationEnv.value;
      }
    } else if (this.registry.providerEnvMap && !this.agentConfig.isDirectMode) {
      // Multi-provider CLI in gateway mode (e.g., OpenCode): set ALL provider API keys
      // so any model prefix (anthropic/*, openai/*, google/*) can find its key
      for (const mapping of Object.values(this.registry.providerEnvMap)) {
        envVars[mapping.keyEnv] = this.agentConfig.apiKey;
      }
    } else {
      // Single-provider: resolve model-specific key env for multi-provider CLIs in direct mode
      const providerPrefix = this.agentConfig.model?.split("/")[0];
      const providerMapping = providerPrefix ? this.registry.providerEnvMap?.[providerPrefix] : undefined;
      const effectiveKeyEnv = providerMapping ? providerMapping.keyEnv : this.registry.apiKeyEnv;
      // OAuth mode uses oauthEnv (e.g., CLAUDE_CODE_OAUTH_TOKEN), else apiKeyEnv
      const keyEnv = this.agentConfig.isOAuth && this.registry.oauthEnv
        ? this.registry.oauthEnv
        : effectiveKeyEnv;
      envVars[keyEnv] = this.agentConfig.apiKey;
    }

    if (this.agentConfig.isDirectMode && !this.agentConfig.isOAuth) {
      // Direct mode (non-OAuth): use resolved baseUrl if set (e.g., Qwen needs Dashscope endpoint)
      if (this.agentConfig.baseUrl) {
        envVars[this.registry.baseUrlEnv] = this.agentConfig.baseUrl;
      }
    } else if (!this.agentConfig.isDirectMode) {
      // Gateway mode: route through Evolve gateway
      const gatewayUrl = this.registry.usePassthroughGateway
        ? getGeminiGatewayUrl()
        : getGatewayUrl();

      if (this.registry.gatewayConfigEnv) {
        // OpenCode gateway: define a custom "litellm" provider that routes through the LiteLLM gateway
        // using OpenAI-compatible format. Model names pass through as-is (e.g. openrouter/anthropic/claude-sonnet-4.6).
        const selectedModel = this.agentConfig.model || this.registry.defaultModel;
        envVars[this.registry.gatewayConfigEnv] = JSON.stringify({
          provider: {
            litellm: {
              npm: "@ai-sdk/openai-compatible",
              options: {
                baseURL: `${gatewayUrl}/v1`,
                apiKey: this.agentConfig.apiKey,
              },
              models: {
                [selectedModel]: { name: selectedModel },
              },
            },
          },
        });
      } else {
        // Single-provider: set base URL env var
        envVars[this.registry.baseUrlEnv] = gatewayUrl;
      }

      // Expose EVOLVE_API_KEY in sandbox for gateway services (e.g., browser-use)
      envVars['EVOLVE_API_KEY'] = this.agentConfig.apiKey;
    }
    // OAuth direct mode: no baseUrl needed (Claude Code CLI handles it)

    if (this.options.secrets) {
      Object.assign(envVars, this.options.secrets);
    }

    // Spend tracking: merge session-level LiteLLM header (gateway mode only).
    // Uses mergeCustomHeaders to preserve any user-supplied headers from secrets.
    if (!this.agentConfig.isDirectMode && this.registry.customHeadersEnv) {
      const headerEnv = this.registry.customHeadersEnv;
      envVars[headerEnv] = mergeCustomHeaders(envVars[headerEnv], {
        "x-litellm-customer-id": this.sessionTag,
      });
    }

    return envVars;
  }

  /**
   * Build per-run env overrides for spend tracking.
   * Merges session + run headers into the custom headers env var.
   * Passed to spawn() so each .run() gets a unique trace-id.
   */
  private buildRunEnvs(runId: string): Record<string, string> | undefined {
    if (this.agentConfig.isDirectMode) return undefined;
    const headerEnv = this.registry.customHeadersEnv;
    if (!headerEnv) return undefined;

    // Start from any user-supplied headers (via secrets), then merge spend headers
    const base = this.options.secrets?.[headerEnv];
    return {
      [headerEnv]: mergeCustomHeaders(base, {
        "x-litellm-customer-id": this.sessionTag,
        "x-litellm-trace-id": runId,
      }),
    };
  }

  /**
   * Agent-specific authentication setup
   */
  private async setupAgentAuth(sandbox: SandboxInstance): Promise<void> {
    // File-based OAuth: write auth file directly
    if (this.agentConfig.oauthFileContent && this.registry.oauthFileName) {
      const settingsDir = this.registry.mcpConfig.settingsDir.replace(/^~/, "/home/user");
      await sandbox.files.makeDir(settingsDir);
      await sandbox.files.write(`${settingsDir}/${this.registry.oauthFileName}`, this.agentConfig.oauthFileContent);
      return;
    }
    // Default: run setup command (e.g., "codex login --with-api-key")
    if (this.registry.setupCommand) {
      await sandbox.commands.run(this.registry.setupCommand, { timeoutMs: 30000 });
    }
  }

  /**
   * Setup workspace structure and files
   *
   * @param opts.skipSystemPrompt - When true, skip writing the system prompt file.
   *   Used on restore from checkpoint: the tar already contains the correct file.
   */
  private async setupWorkspace(
    sandbox: SandboxInstance,
    opts?: { skipSystemPrompt?: boolean }
  ): Promise<void> {
    const workspaceMode = this.options.workspaceMode || "knowledge";

    // Create workspace folders (swe mode includes repo/)
    const folders = workspaceMode === "swe"
      ? `${this.workingDir}/repo ${this.workingDir}/context ${this.workingDir}/scripts ${this.workingDir}/temp ${this.workingDir}/output`
      : `${this.workingDir}/context ${this.workingDir}/scripts ${this.workingDir}/temp ${this.workingDir}/output`;

    await sandbox.commands.run(`mkdir -p ${folders}`, { timeoutMs: 30000 });

    // Write system prompt file (skip on restore — checkpoint tar has the correct one)
    if (!opts?.skipSystemPrompt) {
      const fullPrompt = buildWorkerSystemPrompt({
        workingDir: this.workingDir,
        systemPrompt: this.options.systemPrompt,
        schema: this.zodSchema || this.jsonSchema,
        mode: workspaceMode,
      });

      const filePath = `${this.workingDir}/${this.registry.systemPromptFile}`;
      await sandbox.files.write(filePath, fullPrompt);
    }

    // Upload context files
    if (this.options.context) {
      await this.uploadContextFiles(sandbox, this.options.context);
    }

    // Upload workspace files
    if (this.options.files) {
      await this.uploadWorkspaceFiles(sandbox, this.options.files);
    }

    // Setup Composio and MCP servers
    let mcpServers: Record<string, McpServerConfig> = { ...this.options.mcpServers };

    if (this.options.composio) {
      const composioMcp = await setupComposio(
        this.options.composio.userId,
        this.options.composio.config
      );
      mcpServers = {
        ...mcpServers,
        composio: {
          type: "http",
          url: composioMcp.url,
          headers: composioMcp.headers,
        },
      };
    }

    // Write MCP config if any servers configured.
    // NOTE: On restore, this intentionally overwrites the archived MCP config.
    // MCP servers require fresh auth tokens (Composio URLs, API keys) that the
    // current Evolve instance generates — stale tokens from the checkpoint won't
    // work. Gateway mode and Composio both produce session-scoped URLs.
    if (Object.keys(mcpServers).length > 0) {
      await writeMcpConfig(
        this.agentConfig.type,
        sandbox,
        this.workingDir,
        mcpServers
      );
    }

    // Setup skills
    if (this.skills?.length) {
      await this.setupSkills(sandbox);
    }
  }

  /**
   * Setup skills for the agent
   *
   * Copies selected skills from source (~/.evolve/skills/) to CLI-specific directory.
   * All CLIs use the same pattern: skills are auto-discovered from their target directory.
   */
  private async setupSkills(sandbox: SandboxInstance): Promise<void> {
    if (!this.skills?.length) return;

    const { skillsConfig } = this.registry;
    const { sourceDir, targetDir } = skillsConfig;

    await sandbox.files.makeDir(targetDir);

    // Copy selected skills from source to target directory
    for (const skill of this.skills) {
      const copyCmd = `cp -r ${sourceDir}/${skill} ${targetDir}/ 2>/dev/null || true`;
      await sandbox.commands.run(copyCmd, { timeoutMs: 30000 });
    }
  }

  /**
   * Upload context files to context/ folder
   */
  private async uploadContextFiles(
    sandbox: SandboxInstance,
    files: FileMap
  ): Promise<void> {
    const entries = Object.entries(files).map(([name, content]) => ({
      path: `${this.workingDir}/context/${name}`,
      data: content,
    }));

    if (entries.length === 0) return;

    // Create parent directories
    const dirs = new Set(
      entries.map((e) => e.path.substring(0, e.path.lastIndexOf("/"))).filter(Boolean)
    );
    if (dirs.size > 0) {
      await sandbox.commands.run(`mkdir -p ${Array.from(dirs).join(" ")}`, {
        timeoutMs: 30000,
      });
    }

    await sandbox.files.writeBatch(entries);
  }

  /**
   * Upload workspace files to working directory
   */
  private async uploadWorkspaceFiles(
    sandbox: SandboxInstance,
    files: FileMap
  ): Promise<void> {
    const entries = Object.entries(files).map(([path, content]) => ({
      // Support absolute paths (use as-is) and relative paths (prefix with workingDir)
      path: path.startsWith("/") ? path : `${this.workingDir}/${path}`,
      data: content,
    }));

    if (entries.length === 0) return;

    // Create parent directories
    const dirs = new Set(
      entries.map((e) => e.path.substring(0, e.path.lastIndexOf("/"))).filter(Boolean)
    );
    if (dirs.size > 0) {
      await sandbox.commands.run(`mkdir -p ${Array.from(dirs).join(" ")}`, {
        timeoutMs: 30000,
      });
    }

    await sandbox.files.writeBatch(entries);
  }

  // ===========================================================================
  // COMMAND BUILDING
  // ===========================================================================

  /**
   * Build the CLI command for running the agent
   */
  private buildCommand(prompt: string): string {
    return this.registry.buildCommand({
      prompt: escapePrompt(prompt),
      model: this.agentConfig.model || this.registry.defaultModel,
      isResume: this.hasRun,
      reasoningEffort: this.agentConfig.reasoningEffort,
      isDirectMode: this.agentConfig.isDirectMode,
      skills: this.skills,
    });
  }

  // ===========================================================================
  // RUN METHOD
  // ===========================================================================

  /**
   * Run agent with prompt
   *
   * Streams output via callbacks, returns final response.
   */
  async run(
    options: RunOptions,
    callbacks?: StreamCallbacks
  ): Promise<AgentResponse> {
    const { prompt, timeoutMs = DEFAULT_TIMEOUT_MS, background = false, checkpointComment } = options;
    let { from } = options;
    if (this.activeCommand) {
      throw new Error(
        "Agent is already running. Call interrupt(), wait for the active/background run to finish, or create a new Evolve instance."
      );
    }

    // =========================================================================
    // GUARD: mutual exclusivity check before any network calls
    // =========================================================================
    if (from) {
      if (this.sandbox || this.options.sandboxId) {
        throw new Error(
          "Cannot restore into existing sandbox. Call kill() first, or create a new Evolve instance."
        );
      }
    }

    // =========================================================================
    // RESOLVE "latest": convert to concrete checkpoint ID
    // =========================================================================
    if (from === "latest") {
      if (!this.storage) {
        throw new Error("Storage not configured. Call .withStorage() before using from: \"latest\".");
      }
      const latest = await getLatestCheckpoint(this.storage);
      if (!latest) {
        throw new Error("No checkpoints found for from: \"latest\".");
      }
      from = latest.id;
    }

    // =========================================================================
    // RESTORE PATH: if `from` is provided, restore checkpoint into fresh sandbox
    // =========================================================================
    if (from) {
      if (!this.storage) {
        throw new Error("Storage not configured. Call .withStorage() before using 'from'.");
      }
      if (!this.options.sandboxProvider) {
        throw new Error("No sandbox provider configured");
      }

      // Create fresh sandbox
      const envVars = this.buildEnvironmentVariables();
      this.sandboxState = "booting";
      this.emitLifecycle(callbacks, "sandbox_boot");
      try {
        this.sandbox = await this.options.sandboxProvider.create({
          envs: envVars,
          workingDirectory: this.workingDir,
        });

        // Restore checkpoint archive into sandbox (returns metadata for validation)
        const ckptMeta = await restoreCheckpoint(this.sandbox, this.storage, from);

        // Validate agent type — changing agent type on restore is structural (wrong
        // dirs, wrong CLI, wrong config format). Model changes are fine.
        if (ckptMeta.agentType && ckptMeta.agentType !== this.agentConfig.type) {
          throw new Error(
            `Cannot restore checkpoint: agent type mismatch (checkpoint: ${ckptMeta.agentType}, current: ${this.agentConfig.type})`
          );
        }

        // Validate workspace mode — changing mode on restore could break directory
        // layout and system prompt assumptions. Skip check for old checkpoints
        // that don't have this field.
        const currentMode = this.options.workspaceMode || "knowledge";
        if (ckptMeta.workspaceMode && ckptMeta.workspaceMode !== currentMode) {
          throw new Error(
            `Cannot restore checkpoint: workspace mode mismatch (checkpoint: ${ckptMeta.workspaceMode}, current: ${currentMode})`
          );
        }

        // Fresh auth setup (overwrites stale tokens from archive)
        await this.setupAgentAuth(this.sandbox);

        // Workspace setup — skip system prompt write on restore UNLESS the user
        // explicitly configured prompt-affecting options on this instance
        const hasExplicitPromptConfig = !!(
          this.options.systemPrompt ||
          this.zodSchema ||
          this.jsonSchema
        );
        await this.setupWorkspace(this.sandbox, {
          skipSystemPrompt: !hasExplicitPromptConfig,
        });

        // Mark as resumed so CLI uses --continue flag
        this.hasRun = true;
        // Track lineage: the checkpoint we restored from
        this.lastCheckpointId = from;
        this.sandboxState = "ready";
        this.agentState = "idle";
        this.emitLifecycle(callbacks, "sandbox_ready");
      } catch (error) {
        if (this.sandbox) {
          await this.sandbox.kill().catch(() => {});
          this.sandbox = undefined;
        }
        this.sandboxState = "error";
        this.agentState = "error";
        this.emitLifecycle(callbacks, "sandbox_error");
        throw error;
      }
    }

    const sandbox = await this.getSandbox(callbacks);

    // Track turn start time BEFORE process starts (for output file filtering)
    // Files modified AFTER this time will be returned by getOutputFiles()
    this.lastRunTimestamp = Date.now();

    // Initialize session logger on first run (local logging always, dashboard sync only in gateway mode)
    if (!this.sessionLogger) {
      const provider = this.options.sandboxProvider;
      this.sessionLogger = new SessionLogger({
        provider: provider?.name || provider?.providerType || "unknown",
        agent: this.agentConfig.type,
        model: this.agentConfig.model || this.registry.defaultModel,
        sandboxId: sandbox.sandboxId,
        tag: this.sessionTag,
        apiKey: this.agentConfig.isDirectMode ? undefined : this.agentConfig.apiKey,
        observability: this.options.observability,
      });
    }

    // Log the prompt (non-blocking)
    this.sessionLogger.writePrompt(prompt);

    // Build command and per-run spend tracking env
    const command = this.buildCommand(prompt);
    const runId = randomUUID();
    const runEnvs = this.buildRunEnvs(runId);

    // Line buffer for NDJSON parsing (shared by both modes)
    let lineBuffer = "";

    // Create parser once (shared by onContent callback and session logger)
    const parser = createAgentParser(this.agentConfig.type);

    // Streaming callback for stdout (shared by both modes)
    const onStdout = (chunk: string) => {
      // Line-based NDJSON parsing
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? ""; // Keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;

        // Parse once, use for both session logger and onContent
        const events = parser(line);

        // Log to session logger with pre-parsed events (non-blocking)
        this.sessionLogger?.writeEventParsed(line, events);

        // Emit raw stdout with newline (matches raw output)
        callbacks?.onStdout?.(line + "\n");

        // Emit content events to callback
        if (events && callbacks?.onContent) {
          for (const event of events) {
            callbacks.onContent(event);
          }
        }
      }
    };

    // Streaming callback for stderr (shared by both modes)
    const onStderr = (chunk: string) => {
      callbacks?.onStderr?.(chunk);
    };

    // Spawn for both background and foreground to support interrupt()
    const handle = await sandbox.commands.spawn(command, {
      cwd: this.workingDir,
      timeoutMs,
      envs: runEnvs,
      onStdout,
      onStderr,
    });
    const opId = this.beginOperation("run", handle, callbacks, "run_start");
    // Mark as resumed for subsequent runs as soon as execution starts.
    this.hasRun = true;

    if (background) {
      this.watchBackgroundOperation(opId, "run", handle, callbacks);
      return {
        sandboxId: sandbox.sandboxId,
        runId,
        exitCode: 0,
        stdout: `Background process started with ID ${handle.processId}`,
        stderr: "",
      };
    }

    let result;
    try {
      result = await handle.wait();
    } catch (error) {
      this.interruptedOperations.delete(opId);
      this.finalizeOperation(opId, callbacks, "run_failed", "error");
      throw error;
    }

    const interrupted = this.interruptedOperations.delete(opId) || result.exitCode === 130;
    if (interrupted) {
      this.finalizeOperation(opId, callbacks, "run_interrupted", "interrupted");
    } else if (result.exitCode === 0) {
      this.finalizeOperation(opId, callbacks, "run_complete", "idle");
    } else {
      this.finalizeOperation(opId, callbacks, "run_failed", "error");
    }

    // Process any remaining buffered content
    if (lineBuffer.trim()) {
      // Parse once, use for both session logger and onContent
      const events = parser(lineBuffer);

      // Log to session logger with pre-parsed events (non-blocking)
      this.sessionLogger?.writeEventParsed(lineBuffer, events);

      // Emit raw stdout
      callbacks?.onStdout?.(lineBuffer + "\n");

      // Emit content events to callback
      if (events && callbacks?.onContent) {
        for (const event of events) {
          callbacks.onContent(event);
        }
      }
    }

    // Flush observability events so dashboard is complete before returning.
    // This ensures Python SDK (and any caller) gets deterministic flushing
    // as part of run() — no reliance on timers or explicit kill().
    // Capped at 2s so dashboard slowness never delays the caller.
    if (this.sessionLogger && !background) {
      await Promise.race([
        this.sessionLogger.flush(),
        new Promise<void>((resolve) => setTimeout(resolve, 2000)),
      ]);
    }

    // =========================================================================
    // AUTO-CHECKPOINT: after successful foreground run with storage configured
    // =========================================================================
    let checkpoint: CheckpointInfo | undefined;
    if (this.storage && !background && result.exitCode === 0) {
      try {
        checkpoint = await createCheckpoint(
          sandbox,
          this.storage,
          this.agentConfig.type,
          this.workingDir,
          {
            tag: this.sessionTag,
            model: this.agentConfig.model || this.registry.defaultModel,
            workspaceMode: this.options.workspaceMode || "knowledge",
            comment: checkpointComment,
            parentId: this.lastCheckpointId,
          }
        );
        this.lastCheckpointId = checkpoint.id;
      } catch (e) {
        // Non-fatal: log warning, return response without checkpoint
        console.warn(`[Evolve] Auto-checkpoint failed: ${(e as Error).message}`);
      }
    }

    return {
      sandboxId: sandbox.sandboxId,
      runId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      checkpoint,
    };
  }

  // ===========================================================================
  // EXECUTE COMMAND
  // ===========================================================================

  /**
   * Execute arbitrary command in sandbox
   */
  async executeCommand(
    command: string,
    options: ExecuteCommandOptions = {},
    callbacks?: StreamCallbacks
  ): Promise<AgentResponse> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, background = false } = options;
    if (this.activeCommand) {
      throw new Error(
        "Agent is already running. Call interrupt(), wait for the active/background command to finish, or create a new Evolve instance."
      );
    }
    const sandbox = await this.getSandbox(callbacks);

    // Track turn start time BEFORE process starts (for output file filtering)
    // Files modified AFTER this time will be returned by getOutputFiles()
    this.lastRunTimestamp = Date.now();

    let stdout = "";
    let stderr = "";

    // Streaming callbacks (shared by both modes)
    const onStdout = (chunk: string) => {
      stdout += chunk;
      callbacks?.onStdout?.(chunk);
    };
    const onStderr = (chunk: string) => {
      stderr += chunk;
      callbacks?.onStderr?.(chunk);
    };

    const handle = await sandbox.commands.spawn(command, {
      cwd: this.workingDir,
      timeoutMs,
      onStdout,
      onStderr,
    });
    const opId = this.beginOperation("command", handle, callbacks, "command_start");

    if (background) {
      this.watchBackgroundOperation(opId, "command", handle, callbacks);
      return {
        sandboxId: sandbox.sandboxId,
        exitCode: 0,
        stdout: `Background process started with ID ${handle.processId}`,
        stderr: "",
      };
    }

    let result;
    try {
      result = await handle.wait();
    } catch (error) {
      this.interruptedOperations.delete(opId);
      this.finalizeOperation(opId, callbacks, "command_failed", "error");
      throw error;
    }

    const interrupted = this.interruptedOperations.delete(opId) || result.exitCode === 130;
    if (interrupted) {
      this.finalizeOperation(opId, callbacks, "command_interrupted", "interrupted");
    } else if (result.exitCode === 0) {
      this.finalizeOperation(opId, callbacks, "command_complete", "idle");
    } else {
      this.finalizeOperation(opId, callbacks, "command_failed", "error");
    }

    return {
      sandboxId: sandbox.sandboxId,
      exitCode: result.exitCode,
      // Prefer streaming-collected output; fall back to wait() result
      // (handles race condition where command completes before stream connects)
      stdout: stdout || result.stdout || "",
      stderr: stderr || result.stderr || "",
    };
  }

  // ===========================================================================
  // FILE OPERATIONS
  // ===========================================================================

  /**
   * Upload context files (to context/ folder)
   */
  async uploadContext(files: FileMap): Promise<void> {
    const sandbox = await this.getSandbox();
    await this.uploadContextFiles(sandbox, files);
  }

  /**
   * Upload files to working directory
   */
  async uploadFiles(files: FileMap): Promise<void> {
    const sandbox = await this.getSandbox();
    await this.uploadWorkspaceFiles(sandbox, files);
  }

  /**
   * Get output files from output/ folder with optional schema validation
   *
   * Returns files modified after the last run() call.
   * If schema was provided, validates result.json and returns typed data.
   *
   * @param recursive - Include files in subdirectories (default: false)
   */
  async getOutputFiles<T = unknown>(recursive = false): Promise<OutputResult<T>> {
    const sandbox = await this.getSandbox();
    const outputDir = `${this.workingDir}/output`;

    // Get file list with ctime (inode change time)
    // ctime reflects when the file was actually written to disk, even if mtime is overwritten
    // (e.g., wget sets mtime to server's Last-Modified, but ctime is the local write time)
    const depthArg = recursive ? "" : "-maxdepth 1";
    const result = await sandbox.commands.run(
      `find ${outputDir} ${depthArg} -type f -exec stat -c '%n|%Z' {} \\; 2>/dev/null || true`,
      { timeoutMs: 30000 }
    );

    const lines = result.stdout.split("\n").filter(Boolean);

    // Convert turn start time to seconds for comparison with stat's ctime
    // Subtract 2 seconds to account for potential clock skew between host and sandbox
    const turnStartTimeSec = this.lastRunTimestamp
      ? Math.floor(this.lastRunTimestamp / 1000) - 2
      : 0;

    // Parse and filter files
    const filesToRead: string[] = [];
    const outputDirPrefix = `${outputDir}/`;

    for (const line of lines) {
      const [fullPath, ctimeStr] = line.split("|");
      if (!fullPath || !ctimeStr) continue;

      const ctimeSec = parseInt(ctimeStr, 10);

      // Only include files created/written after the current turn started
      if (turnStartTimeSec > 0 && ctimeSec < turnStartTimeSec) {
        continue;
      }

      filesToRead.push(fullPath);
    }

    // Read all files in parallel
    const files: FileMap = {};
    const results = await Promise.all(
      filesToRead.map(async (fullPath) => {
        try {
          const content = await sandbox.files.read(fullPath);
          // Get relative path from output/ directory
          const relativePath = fullPath.startsWith(outputDirPrefix)
            ? fullPath.slice(outputDirPrefix.length)
            : fullPath.split("/").pop() || fullPath;
          return { relativePath, content };
        } catch {
          return null;
        }
      })
    );

    for (const r of results) {
      if (r) files[r.relativePath] = r.content;
    }

    // No schema - return files only
    if (!this.zodSchema && !this.jsonSchema) return { files, data: null };

    // Validate result.json against schema
    const json = files["result.json"];
    if (!json) {
      return { files, data: null, error: "Schema provided but agent did not create output/result.json" };
    }

    // Convert to string once (for parsing and rawData)
    const rawData = typeof json === "string" ? json : new TextDecoder().decode(json as Uint8Array);

    try {
      const parsed = JSON.parse(rawData);

      // Validate with Zod if provided
      if (this.zodSchema) {
        const validated = this.zodSchema.safeParse(parsed);
        return validated.success
          ? { files, data: validated.data as T }
          : { files, data: null, error: `Schema validation failed: ${validated.error.message}`, rawData };
      }

      // Validate with Ajv (JSON Schema)
      if (this.compiledValidator) {
        const valid = this.compiledValidator(parsed);
        if (valid) {
          return { files, data: parsed as T };
        } else {
          const errors = this.compiledValidator.errors
            ?.map((e) => `${e.instancePath} ${e.message}`)
            .join(", ") || "Unknown validation error";
          return { files, data: null, error: `Schema validation failed: ${errors}`, rawData };
        }
      }

      return { files, data: null };
    } catch (e) {
      return { files, data: null, error: `Failed to parse result.json: ${(e as Error).message}`, rawData };
    }
  }

  // ===========================================================================
  // EXPLICIT CHECKPOINT
  // ===========================================================================

  /**
   * Create an explicit checkpoint of the current sandbox state.
   *
   * Requires an active sandbox (call run() first).
   *
   * @param options.comment - Optional label for this checkpoint
   */
  async checkpoint(options?: { comment?: string }): Promise<CheckpointInfo> {
    if (!this.storage) {
      throw new Error("Storage not configured. Call .withStorage().");
    }
    if (!this.sandbox) {
      throw new Error("No active sandbox. Call run() first.");
    }

    const result = await createCheckpoint(
      this.sandbox,
      this.storage,
      this.agentConfig.type,
      this.workingDir,
      {
        tag: this.sessionTag,
        model: this.agentConfig.model || this.registry.defaultModel,
        workspaceMode: this.options.workspaceMode || "knowledge",
        comment: options?.comment,
        parentId: this.lastCheckpointId,
      }
    );
    this.lastCheckpointId = result.id;
    return result;
  }

  // ===========================================================================
  // SANDBOX CONTROL
  // ===========================================================================

  /**
   * Get current session (sandbox ID)
   */
  getSession(): string | null {
    return this.sandbox?.sandboxId || this.options.sandboxId || null;
  }

  /**
   * Set session (sandbox ID) to connect to
   *
   * When reconnecting to an existing sandbox, we assume the agent
   * may have already run commands, so we set hasRun=true to use
   * the continue/resume command template instead of first-run.
   */
  async setSession(sandboxId: string): Promise<void> {
    // Interrupt active operation before switching sessions
    if (this.activeCommand) {
      const interrupted = await this.interrupt();
      if (!interrupted) {
        throw new Error(
          "Cannot switch session while an active process is running and could not be interrupted."
        );
      }
    }

    // Close existing session logger (flush pending events)
    if (this.sessionLogger) {
      await this.sessionLogger.close();
      this.sessionLogger = undefined;
    }

    this.options.sandboxId = sandboxId;
    this.sandbox = undefined;
    this.interruptedOperations.clear();
    this.invalidateActiveOperation();
    this.sandboxState = "ready";
    this.agentState = "idle";
    // Assume existing sandbox may have prior runs - use continue command
    this.hasRun = true;
    // Reset lineage — switching sandbox breaks checkpoint chain
    this.lastCheckpointId = undefined;
    // Rotate session tag — new sandbox = new session for spend + observability
    this.sessionTag = generateSessionTag(this.options.sessionTagPrefix || "evolve");
  }

  /**
   * Pause sandbox
   */
  async pause(callbacks?: StreamCallbacks): Promise<void> {
    if (this.sandbox) {
      if (this.activeCommand) {
        await this.interrupt(callbacks);
      }
      await this.sandbox.pause();
      this.sandboxState = "paused";
      this.agentState = "idle";
      this.emitLifecycle(callbacks, "sandbox_pause");
    }
  }

  /**
   * Resume sandbox
   */
  async resume(callbacks?: StreamCallbacks): Promise<void> {
    if (this.sandbox && this.options.sandboxProvider) {
      this.sandbox = await this.options.sandboxProvider.connect(
        this.sandbox.sandboxId
      );
      this.sandboxState = "ready";
      this.agentState = "idle";
      this.emitLifecycle(callbacks, "sandbox_resume");
    }
  }

  /**
   * Interrupt active command without killing the sandbox.
   */
  async interrupt(callbacks?: StreamCallbacks): Promise<boolean> {
    if (!this.activeCommand && !this.activeProcessId) {
      return false;
    }

    const opId = this.activeOperationId;
    const operationKind = this.activeOperationKind;
    let killed = false;

    try {
      if (this.activeCommand) {
        killed = await this.activeCommand.kill();
      } else if (this.sandbox && this.activeProcessId) {
        killed = await this.sandbox.commands.kill(this.activeProcessId);
      }
    } catch {
      killed = false;
    }

    if (!killed) {
      this.sandboxState = "running";
      this.agentState = "running";
      return false;
    }

    if (opId !== null) {
      this.interruptedOperations.add(opId);
    }
    this.invalidateActiveOperation();
    this.sandboxState = "ready";
    this.agentState = "interrupted";

    const reason: LifecycleReason = operationKind === "run"
      ? "run_interrupted"
      : "command_interrupted";
    this.emitLifecycle(callbacks, reason);

    return killed;
  }

  /**
   * Get current runtime status for sandbox and agent.
   */
  status(): SessionStatus {
    return {
      sandboxId: this.getSession(),
      sandbox: this.sandboxState,
      agent: this.agentState,
      activeProcessId: this.activeProcessId,
      hasRun: this.hasRun,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Kill sandbox (terminates all processes)
   */
  async kill(callbacks?: StreamCallbacks): Promise<void> {
    // Close session logger (flush pending events)
    if (this.sessionLogger) {
      await this.sessionLogger.close();
      this.sessionLogger = undefined;
    }

    // Interrupt active operation before killing sandbox
    if (this.activeCommand) {
      await this.interrupt(callbacks);
    }

    // Kill sandbox (terminates all processes inside)
    if (this.sandbox) {
      await this.sandbox.kill();
      this.sandbox = undefined;
    }
    // Session is no longer valid after sandbox termination.
    this.options.sandboxId = undefined;
    this.interruptedOperations.clear();
    this.invalidateActiveOperation();
    this.sandboxState = "stopped";
    this.agentState = "idle";
    this.hasRun = false;
    this.lastCheckpointId = undefined;
    // Rotate session tag so next sandbox gets a fresh session for spend + observability
    this.sessionTag = generateSessionTag(this.options.sessionTagPrefix || "evolve");
    this.emitLifecycle(callbacks, "sandbox_killed");
  }

  /**
   * Get host URL for a port
   */
  async getHost(port: number): Promise<string> {
    const sandbox = await this.getSandbox();
    return sandbox.getHost(port);
  }

  /**
   * Get agent type
   */
  getAgentType(): AgentType {
    return this.agentConfig.type;
  }

  // ===========================================================================
  // OBSERVABILITY
  // ===========================================================================

  /**
   * Get current session tag.
   * Returns null if no active session (before sandbox creation or after kill()).
   * Used for both observability (dashboard traces) and spend tracking (LiteLLM customer-id).
   */
  getSessionTag(): string | null {
    // Only expose the tag when there's an active session (sandbox exists or logger initialized)
    if (!this.sandbox && !this.sessionLogger) return null;
    return this.sessionTag;
  }

  /**
   * Get current session timestamp
   *
   * Returns null if no session has started (run() not called yet).
   */
  getSessionTimestamp(): string | null {
    return this.sessionLogger?.getTimestamp() || null;
  }

  /**
   * Flush pending observability events without closing the session.
   */
  async flushObservability(): Promise<void> {
    await this.sessionLogger?.flush();
  }
}
