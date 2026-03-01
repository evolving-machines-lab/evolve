/**
 * Evolve Orchestrator
 *
 * Builder pattern for configuring and running agents.
 * Provides event-based streaming and simplified API.
 *
 * Evidence: sdk-rewrite-v3.md Public API Contract section
 */

import { EventEmitter } from "events";
import type { z } from "zod";
import type {
  SandboxProvider,
  McpServerConfig,
  WorkspaceMode,
  FileMap,
  OutputResult,
  SessionStatus,
  LifecycleEvent,
  LifecycleReason,
  AgentRuntimeState,
  SandboxLifecycleState,
  JsonSchema,
  SchemaValidationOptions,
  SkillName,
  ComposioConfig,
  ComposioSetup,
  StorageConfig,
} from "./types";
import { Agent, type AgentConfig, type AgentOptions, type AgentResponse } from "./agent";
import type { OutputEvent } from "./parsers";
import { isZodSchema, resolveAgentConfig, resolveDefaultSandbox } from "./utils";
import { composioHelpers } from "./composio";
import { getGatewayMcpServers, DEFAULT_DASHBOARD_URL } from "./constants";
import { resolveStorageConfig, storage as createStorageClient } from "./storage";
import type { CheckpointInfo, StorageClient } from "./types";

// =============================================================================
// TYPES
// =============================================================================

/**
 * Evolve events
 *
 * Runtime streams:
 * - stdout: Raw NDJSON lines
 * - stderr: Process stderr
 * - content: Parsed OutputEvent
 * - lifecycle: Sandbox/agent lifecycle transitions
 */
export interface EvolveEvents {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  content: (event: OutputEvent) => void;
  lifecycle: (event: LifecycleEvent) => void;
}

export interface EvolveConfig {
  agent?: AgentConfig;
  sandbox?: SandboxProvider;
  workingDirectory?: string;
  workspaceMode?: WorkspaceMode;
  secrets?: Record<string, string>;
  sandboxId?: string;
  systemPrompt?: string;
  context?: FileMap;
  files?: FileMap;
  mcpServers?: Record<string, McpServerConfig>;
  /** Skills to enable (e.g., ["pdf", "dev-browser"]) */
  skills?: SkillName[];
  /** Schema for structured output (Zod or JSON Schema, auto-detected) */
  schema?: z.ZodType<unknown> | JsonSchema;
  /** Validation options for JSON Schema (ignored for Zod) */
  schemaOptions?: SchemaValidationOptions;
  // Observability
  sessionTagPrefix?: string;
  /** Observability metadata for trace grouping (generic key-value, domain-agnostic) */
  observability?: Record<string, unknown>;
  // Composio integration
  /** Composio user ID and config */
  composio?: ComposioSetup;
  // Storage / Checkpointing
  /** Storage configuration for checkpointing */
  storage?: StorageConfig;
}

// =============================================================================
// EVOLVE CLASS
// =============================================================================

/**
 * Evolve orchestrator with builder pattern
 *
 * Usage:
 * ```ts
 * const kit = new Evolve()
 *   .withAgent({ type: "claude", apiKey: "sk-..." })
 *   .withSandbox(e2bProvider);
 *
 * kit.on("content", (event) => console.log(event));
 *
 * await kit.run({ prompt: "Hello" });
 * ```
 */
export class Evolve extends EventEmitter {
  private config: EvolveConfig = {};
  private agent?: Agent;
  private fallbackSandboxState: SandboxLifecycleState = "stopped";
  private fallbackAgentState: AgentRuntimeState = "idle";
  private fallbackHasRun: boolean = false;

  constructor() {
    super();
  }

  // ===========================================================================
  // TYPED EVENT METHODS
  // ===========================================================================

  on<K extends keyof EvolveEvents>(event: K, listener: EvolveEvents[K]): this {
    return super.on(event, listener);
  }

  off<K extends keyof EvolveEvents>(event: K, listener: EvolveEvents[K]): this {
    return super.off(event, listener);
  }

  emit<K extends keyof EvolveEvents>(event: K, ...args: Parameters<EvolveEvents[K]>): boolean {
    return super.emit(event, ...args);
  }

  // ===========================================================================
  // BUILDER METHODS
  // ===========================================================================

  /**
   * Configure agent type and API key.
   * If config is undefined, Evolve resolves agent from env.
   */
  withAgent(config?: AgentConfig): this {
    if (config) {
      this.config.agent = config;
    }
    return this;
  }

  /**
   * Configure sandbox provider
   */
  withSandbox(provider?: SandboxProvider): this {
    this.config.sandbox = provider;
    return this;
  }

  /**
   * Set working directory path
   */
  withWorkingDirectory(path: string): this {
    this.config.workingDirectory = path;
    return this;
  }

  /**
   * Set workspace mode
   * - "knowledge": Creates context/, scripts/, temp/, output/ folders
   * - "swe": Same as knowledge + repo/ folder for code repositories
   */
  withWorkspaceMode(mode: WorkspaceMode): this {
    this.config.workspaceMode = mode;
    return this;
  }

  /**
   * Add environment secrets
   */
  withSecrets(secrets: Record<string, string>): this {
    this.config.secrets = { ...this.config.secrets, ...secrets };
    return this;
  }

  /**
   * Connect to existing session
   */
  withSession(sandboxId: string): this {
    this.config.sandboxId = sandboxId;
    if (!this.agent) {
      this.fallbackSandboxState = "ready";
      this.fallbackAgentState = "idle";
      this.fallbackHasRun = true;
    }
    return this;
  }

  /**
   * Set custom system prompt
   */
  withSystemPrompt(prompt: string): this {
    this.config.systemPrompt = prompt;
    return this;
  }

  /**
   * Add context files (uploaded to context/ folder)
   */
  withContext(files: FileMap): this {
    this.config.context = { ...this.config.context, ...files };
    return this;
  }

  /**
   * Add workspace files (uploaded to working directory)
   */
  withFiles(files: FileMap): this {
    this.config.files = { ...this.config.files, ...files };
    return this;
  }

  /**
   * Configure MCP servers
   */
  withMcpServers(servers: Record<string, McpServerConfig>): this {
    this.config.mcpServers = { ...this.config.mcpServers, ...servers };
    return this;
  }

  /**
   * Enable skills for the agent
   *
   * Skills are specialized capabilities that extend the agent's functionality.
   * Available skills: "pdf", "dev-browser"
   *
   * @example
   * kit.withSkills(["pdf", "dev-browser"])
   */
  withSkills(skills: SkillName[]): this {
    this.config.skills = skills;
    return this;
  }

  /**
   * Set schema for structured output validation
   *
   * Accepts either:
   * - Zod schema: z.object({ ... }) - validated with Zod's safeParse
   * - JSON Schema: { type: "object", properties: { ... } } - validated with Ajv
   *
   * Auto-detected based on presence of .safeParse method.
   *
   * @param schema - Zod schema or JSON Schema object
   * @param options - Validation options for JSON Schema (ignored for Zod)
   *
   * @example
   * // Zod schema
   * kit.withSchema(z.object({ result: z.string() }))
   *
   * // JSON Schema with validation mode
   * kit.withSchema(
   *   { type: "object", properties: { result: { type: "string" } } },
   *   { mode: "loose" }
   * )
   */
  withSchema<T>(
    schema: z.ZodType<T> | JsonSchema,
    options?: SchemaValidationOptions
  ): this {
    this.config.schema = schema;
    if (options) {
      if (isZodSchema(schema)) {
        console.warn("[Evolve] schemaOptions ignored for Zod schemas - use .passthrough(), .strip(), z.coerce instead");
      } else {
        this.config.schemaOptions = options;
      }
    }
    return this;
  }

  /**
   * Set session tag prefix for observability
   */
  withSessionTagPrefix(prefix: string): this {
    this.config.sessionTagPrefix = prefix;
    return this;
  }

  /**
   * @internal Set observability metadata for trace grouping.
   * Used internally by Swarm - not part of public API.
   */
  withObservability(meta: Record<string, unknown>): this {
    this.config.observability = { ...this.config.observability, ...meta };
    return this;
  }

  /**
   * Enable Composio Tool Router for 1000+ tool integrations
   *
   * Provides access to GitHub, Gmail, Slack, Notion, and 1000+ other
   * tools via a single MCP server. Handles authentication automatically.
   *
   * Evidence: tool-router/quickstart.mdx
   *
   * @param userId - Your user's unique identifier
   * @param config - Optional configuration for toolkits, API keys, and auth
   *
   * @example
   * // Basic - all tools, in-chat auth
   * kit.withComposio("user_123")
   *
   * @example
   * // Restrict to specific toolkits
   * kit.withComposio("user_123", { toolkits: ["github", "gmail"] })
   *
   * @example
   * // With API keys for direct auth
   * kit.withComposio("user_123", {
   *   toolkits: ["github", "stripe"],
   *   keys: { stripe: "sk_live_..." }
   * })
   *
   * @example
   * // With white-label OAuth
   * kit.withComposio("user_123", {
   *   authConfigs: { github: "ac_your_oauth_config" }
   * })
   */
  withComposio(userId: string, config?: ComposioConfig): this {
    this.config.composio = { userId, config };
    return this;
  }

  /**
   * Configure storage for checkpoint persistence
   *
   * BYOK mode: provide URL to your S3-compatible bucket.
   * Gateway mode: omit config (uses Evolve-managed storage, requires EVOLVE_API_KEY).
   *
   * @example
   * // BYOK — user's own S3 bucket
   * kit.withStorage({ url: "s3://my-bucket/agent-snapshots/" })
   *
   * // BYOK — Cloudflare R2
   * kit.withStorage({ url: "s3://my-bucket/prefix/", endpoint: "https://acct.r2.cloudflarestorage.com" })
   *
   * // Gateway — Evolve-managed storage
   * kit.withStorage()
   */
  withStorage(config?: StorageConfig): this {
    this.config.storage = config || {};
    return this;
  }

  // ===========================================================================
  // STATIC HELPERS
  // ===========================================================================

  /**
   * Static helpers for Composio auth management
   *
   * Use these in your app's settings UI to manage user connections.
   *
   * Evidence: tool-router/manually-authenticating-users.mdx
   *
   * @example
   * // Get OAuth URL for "Connect GitHub" button
   * const { url } = await Evolve.composio.auth("user_123", "github");
   *
   * @example
   * // Check connection status
   * const status = await Evolve.composio.status("user_123");
   * // { github: true, gmail: false, ... }
   *
   * @example
   * // Check single toolkit
   * const isConnected = await Evolve.composio.status("user_123", "github");
   * // true | false
   */
  static composio = composioHelpers;

  // ===========================================================================
  // AGENT INITIALIZATION
  // ===========================================================================

  /**
   * Initialize agent on first use
   */
  private async initializeAgent(): Promise<void> {
    // Resolve agent config (type defaults to "claude", apiKey from EVOLVE_API_KEY)
    const agentConfig = resolveAgentConfig(this.config.agent);

    // Resolve sandbox provider (from config or env)
    const sandboxProvider = this.config.sandbox ?? await resolveDefaultSandbox();

    // Gateway mode: merge platform defaults (user config takes precedence)
    const gatewayMcpDefaults = !agentConfig.isDirectMode
      ? getGatewayMcpServers(agentConfig.apiKey)
      : {};

    // Resolve storage config if .withStorage() was called
    const resolvedStorage = this.config.storage !== undefined
      ? resolveStorageConfig(
          this.config.storage,
          !agentConfig.isDirectMode,
          DEFAULT_DASHBOARD_URL,
          agentConfig.isDirectMode ? undefined : agentConfig.apiKey
        )
      : undefined;

    const agentOptions: AgentOptions = {
      sandboxProvider,
      secrets: this.config.secrets,
      sandboxId: this.config.sandboxId,
      workingDirectory: this.config.workingDirectory,
      workspaceMode: this.config.workspaceMode,
      systemPrompt: this.config.systemPrompt,
      context: this.config.context,
      files: this.config.files,
      mcpServers: { ...gatewayMcpDefaults, ...this.config.mcpServers },
      skills: this.config.skills,
      schema: this.config.schema,
      schemaOptions: this.config.schemaOptions,
      // Observability
      sessionTagPrefix: this.config.sessionTagPrefix,
      observability: this.config.observability,
      // Composio integration
      composio: this.config.composio,
      // Storage / Checkpointing
      storage: resolvedStorage,
    };

    this.agent = new Agent(agentConfig, agentOptions);
  }

  /**
   * Create stream callbacks based on registered listeners
   */
  private createStreamCallbacks() {
    const hasStdoutListener = this.listenerCount("stdout") > 0;
    const hasStderrListener = this.listenerCount("stderr") > 0;
    const hasContentListener = this.listenerCount("content") > 0;
    const hasLifecycleListener = this.listenerCount("lifecycle") > 0;

    return {
      onStdout: hasStdoutListener
        ? (line: string) => this.emit("stdout", line)
        : undefined,
      onStderr: hasStderrListener
        ? (chunk: string) => this.emit("stderr", chunk)
        : undefined,
      onContent: hasContentListener
        ? (event: OutputEvent) => this.emit("content", event)
        : undefined,
      onLifecycle: hasLifecycleListener
        ? (event: LifecycleEvent) => this.emit("lifecycle", event)
        : undefined,
    };
  }

  private emitLifecycleFromStatus(reason: LifecycleReason): void {
    if (this.listenerCount("lifecycle") === 0) return;
    const status = this.status();
    this.emit("lifecycle", {
      sandboxId: status.sandboxId,
      sandbox: status.sandbox,
      agent: status.agent,
      timestamp: new Date().toISOString(),
      reason,
    });
  }

  // ===========================================================================
  // RUNTIME METHODS
  // ===========================================================================

  /**
   * Run agent with prompt
   *
   * @param from - Restore from checkpoint ID before running (requires .withStorage())
   */
  async run({
    prompt,
    timeoutMs,
    background,
    from,
    checkpointComment,
  }: {
    prompt: string;
    timeoutMs?: number;
    background?: boolean;
    from?: string;
    checkpointComment?: string;
  }): Promise<AgentResponse> {
    // Mutual exclusivity: from + withSession()
    if (from && this.config.sandboxId) {
      throw new Error(
        "Cannot use 'from' with 'withSession()' — restore requires a fresh sandbox."
      );
    }

    if (!this.agent) {
      await this.initializeAgent();
    }

    const callbacks = this.createStreamCallbacks();

    return this.agent!.run({ prompt, timeoutMs, background, from, checkpointComment }, callbacks);
  }

  /**
   * Execute arbitrary command in sandbox
   */
  async executeCommand(
    command: string,
    options: { timeoutMs?: number; background?: boolean } = {}
  ): Promise<AgentResponse> {
    if (!this.agent) {
      await this.initializeAgent();
    }

    const callbacks = this.createStreamCallbacks();

    return this.agent!.executeCommand(command, options, callbacks);
  }

  /**
   * Interrupt active process without killing sandbox.
   */
  async interrupt(): Promise<boolean> {
    if (!this.agent) {
      return false;
    }
    const callbacks = this.createStreamCallbacks();
    return this.agent.interrupt(callbacks);
  }

  /**
   * Upload context files (runtime - immediate upload)
   */
  async uploadContext(files: FileMap): Promise<void> {
    if (!this.agent) {
      await this.initializeAgent();
    }
    return this.agent!.uploadContext(files);
  }

  /**
   * Upload files to workspace (runtime - immediate upload)
   */
  async uploadFiles(files: FileMap): Promise<void> {
    if (!this.agent) {
      await this.initializeAgent();
    }
    return this.agent!.uploadFiles(files);
  }

  /**
   * Get output files from output/ folder with optional schema validation
   *
   * @param recursive - Include files in subdirectories (default: false)
   */
  async getOutputFiles<T = unknown>(recursive = false): Promise<OutputResult<T>> {
    if (!this.agent) {
      throw new Error("Agent not initialized. Call run() first.");
    }
    return this.agent.getOutputFiles<T>(recursive);
  }

  // ===========================================================================
  // CHECKPOINTING
  // ===========================================================================

  /**
   * Create an explicit checkpoint of the current sandbox state.
   *
   * Requires a prior run() call (needs an active sandbox to snapshot).
   *
   * @param options.comment - Optional label for this checkpoint
   */
  async checkpoint(options?: { comment?: string }): Promise<CheckpointInfo> {
    if (!this.agent) {
      throw new Error("Agent not initialized. Call run() first.");
    }
    return this.agent.checkpoint(options);
  }

  /**
   * Resolve gateway credentials from agent config for storage operations.
   */
  private resolveGatewayOverrides(): { gatewayUrl: string; gatewayApiKey: string } | undefined {
    try {
      const agentConfig = resolveAgentConfig(this.config.agent);
      if (!agentConfig.isDirectMode) {
        return { gatewayUrl: DEFAULT_DASHBOARD_URL, gatewayApiKey: agentConfig.apiKey };
      }
    } catch {
      // No agent configured — fall through to env-based resolution
    }
    return undefined;
  }

  /**
   * List checkpoints (requires .withStorage()).
   *
   * Does not require an agent or sandbox — only storage configuration.
   *
   * @param options.limit - Maximum number of checkpoints to return
   * @param options.tag - Filter by session tag (gateway mode: server-side, BYOK: post-filter)
   */
  async listCheckpoints(options?: { limit?: number; tag?: string }): Promise<CheckpointInfo[]> {
    if (this.config.storage === undefined) {
      throw new Error("Storage not configured. Call .withStorage().");
    }
    const s = createStorageClient(this.config.storage, this.resolveGatewayOverrides());
    return s.listCheckpoints(options);
  }

  /**
   * Get a StorageClient bound to this instance's storage configuration.
   * Same API surface as the standalone storage() factory.
   */
  storage(): StorageClient {
    if (this.config.storage === undefined) {
      throw new Error("Storage not configured. Call .withStorage().");
    }
    return createStorageClient(this.config.storage, this.resolveGatewayOverrides());
  }

  // ===========================================================================
  // SESSION MANAGEMENT
  // ===========================================================================

  /**
   * Get current session (sandbox ID)
   */
  getSession(): string | null {
    if (this.agent) {
      return this.agent.getSession();
    }
    return this.config.sandboxId ?? null;
  }

  /**
   * Set session to connect to
   */
  async setSession(sandboxId: string): Promise<void> {
    if (this.agent) {
      await this.agent.setSession(sandboxId);
    } else {
      this.fallbackSandboxState = "ready";
      this.fallbackAgentState = "idle";
      this.fallbackHasRun = true;
    }
    this.config.sandboxId = sandboxId;
  }

  /**
   * Get runtime status for sandbox and agent.
   */
  status(): SessionStatus {
    if (this.agent) {
      return this.agent.status();
    }

    const sandboxId = this.config.sandboxId ?? null;
    return {
      sandboxId,
      sandbox: this.fallbackSandboxState,
      agent: this.fallbackAgentState,
      activeProcessId: null,
      hasRun: this.fallbackHasRun,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Pause sandbox
   */
  async pause(): Promise<void> {
    if (this.agent) {
      const callbacks = this.createStreamCallbacks();
      await this.agent.pause(callbacks);
      return;
    }
    // If agent not initialized but we have session + provider, pause directly
    if (this.config.sandboxId && this.config.sandbox) {
      const sandbox = await this.config.sandbox.connect(this.config.sandboxId);
      await sandbox.pause();
      this.fallbackSandboxState = "paused";
      this.fallbackAgentState = "idle";
      this.emitLifecycleFromStatus("sandbox_pause");
    }
  }

  /**
   * Resume sandbox
   */
  async resume(): Promise<void> {
    if (this.agent) {
      const callbacks = this.createStreamCallbacks();
      await this.agent.resume(callbacks);
      return;
    }
    // If agent not initialized but we have session + provider, connect directly
    if (this.config.sandboxId && this.config.sandbox) {
      await this.config.sandbox.connect(this.config.sandboxId);
      this.fallbackSandboxState = "ready";
      this.fallbackAgentState = "idle";
      this.emitLifecycleFromStatus("sandbox_resume");
    }
  }

  /**
   * Kill sandbox
   */
  async kill(): Promise<void> {
    if (this.agent) {
      const callbacks = this.createStreamCallbacks();
      await this.agent.kill(callbacks);
      this.config.sandboxId = undefined;
      this.fallbackSandboxState = "stopped";
      this.fallbackAgentState = "idle";
      this.fallbackHasRun = false;
      return;
    }
    // If agent not initialized but we have session + provider, kill directly
    if (this.config.sandboxId && this.config.sandbox) {
      const sandbox = await this.config.sandbox.connect(this.config.sandboxId);
      await sandbox.kill();
      this.fallbackSandboxState = "stopped";
      this.fallbackAgentState = "idle";
      this.fallbackHasRun = false;
      this.emitLifecycleFromStatus("sandbox_killed");
      this.config.sandboxId = undefined;
    }
  }

  /**
   * Get host URL for a port
   */
  async getHost(port: number): Promise<string> {
    if (!this.agent) {
      await this.initializeAgent();
    }
    return this.agent!.getHost(port);
  }

  /**
   * Get session tag (for observability)
   *
   * Returns null if no session has started (run() not called yet).
   */
  getSessionTag(): string | null {
    return this.agent?.getSessionTag() || null;
  }

  /**
   * Get session timestamp (for observability)
   *
   * Returns null if no session has started (run() not called yet).
   */
  getSessionTimestamp(): string | null {
    return this.agent?.getSessionTimestamp() || null;
  }

  /**
   * Flush pending observability events without killing sandbox.
   */
  async flushObservability(): Promise<void> {
    await this.agent?.flushObservability();
  }
}
