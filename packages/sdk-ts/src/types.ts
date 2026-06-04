/**
 * Evolve SDK Types
 *
 * Simplified types for the headless CLI agent SDK.
 * Provider-agnostic sandbox abstraction - any provider can implement these.
 */

import type { OutputEvent } from "./parsers/types";

// =============================================================================
// SANDBOX ABSTRACTION (provider-agnostic)
// =============================================================================
//
// These interfaces define the MINIMUM contract the SDK requires from any
// sandbox provider. They are intentionally minimal to support multiple
// providers (E2B, Docker, Fly.io, local, etc.).
//
// Richer features (connect to running process, sendStdin, file streaming,
// presigned URLs, isRunning, getInfo) are available on providers that
// implement them. Access via the provider's native types:
//
//   import { E2BSandbox } from "@evolvingmachines/e2b";
//   const e2b = sandbox as E2BSandbox;
//   await e2b.commands.sendStdin(pid, "input");
//
// =============================================================================

/** Result of a completed sandbox command */
export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Handle to a running background process in sandbox */
export interface SandboxCommandHandle {
  readonly processId: string;
  wait(): Promise<SandboxCommandResult>;
  kill(): Promise<boolean>;
}

/** Information about a running process */
export interface ProcessInfo {
  processId: string;
  cmd: string;
  args: string[];
  envs: Record<string, string>;
  cwd?: string;
  tag?: string;
}

/** Options for command execution */
export interface SandboxRunOptions {
  timeoutMs?: number;
  envs?: Record<string, string>;
  cwd?: string;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

/** Options for spawning background processes in sandbox */
export interface SandboxSpawnOptions extends SandboxRunOptions {
  stdin?: boolean;
}

/** Options for creating a sandbox */
export interface SandboxCreateOptions {
  /** Sandbox image/template ID. Provider uses its default if not specified. */
  image?: string;
  envs?: Record<string, string>;
  metadata?: Record<string, string>;
  timeoutMs?: number;
  workingDirectory?: string;
}

/** Command execution capabilities */
export interface SandboxCommands {
  run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult>;
  spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle>;
  list(): Promise<ProcessInfo[]>;
  kill(processId: string): Promise<boolean>;
}

/** File system operations */
export interface SandboxFiles {
  read(path: string): Promise<string | Uint8Array>;
  write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void>;
  writeBatch(files: Array<{ path: string; data: string | Buffer | ArrayBuffer | Uint8Array }>): Promise<void>;
  makeDir(path: string): Promise<void>;
}

/** Sandbox instance */
export interface SandboxInstance {
  readonly sandboxId: string;
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;
  /** Get host URL for a port */
  getHost(port: number): Promise<string>;
  kill(): Promise<void>;
  pause(): Promise<void>;
}

/** Sandbox lifecycle management - providers implement this */
export interface SandboxProvider {
  /** Provider type identifier (e.g., "e2b") */
  readonly providerType: string;
  /** Human-readable provider name for logging */
  readonly name?: string;
  create(options: SandboxCreateOptions): Promise<SandboxInstance>;
  connect(sandboxId: string, timeoutMs?: number): Promise<SandboxInstance>;
}

// =============================================================================
// AGENT TYPES
// =============================================================================

/** Supported agent types (headless CLI agents only, no ACP) */
export type AgentType = "claude" | "codex" | "gemini" | "qwen" | "kimi" | "opencode" | "droid";

/** Agent type constants for use in code */
export const AGENT_TYPES = {
  CLAUDE: "claude",
  CODEX: "codex",
  GEMINI: "gemini",
  QWEN: "qwen",
  KIMI: "kimi",
  OPENCODE: "opencode",
  DROID: "droid",
} as const;

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Workspace mode determines folder structure and system prompt */
export type WorkspaceMode = "knowledge" | "swe";

/** Available skills that can be enabled */
export type SkillName = "pdf" | "dev-browser" | (string & {});

/** Browser automation providers that can be enabled explicitly */
export type BrowserProvider = "browser-use" | "actionbook" | "agent-browser";

/** Browser providers backed by Evolve-managed browser transport. */
export type ManagedBrowserProvider = "actionbook" | "agent-browser";

/** Actionbook browser configuration. */
export interface ActionbookBrowserConfig {
  provider: "actionbook";
  /** Use Evolve-managed remote browser transport. Defaults to false for object config. */
  remote?: boolean;
}

/** Agent-browser browser configuration. */
export interface AgentBrowserConfig {
  provider: "agent-browser";
  /** Use Evolve-managed remote browser transport. Defaults to false for object config. */
  remote?: boolean;
}

/** Browser automation configuration. */
export type BrowserConfig = BrowserProvider | ActionbookBrowserConfig | AgentBrowserConfig;

/** Saved browser login selector exposed to a run. Empty/omitted means all enabled browser logins. */
export interface BrowserCredentialScopeEntry {
  website: string;
  /** One-word label for the saved credential, such as "qa-admin" or "work"; not the website username or email. */
  accountLabel?: string;
  /** Python bridge wire shape. Prefer accountLabel in TypeScript. */
  account_label?: string;
}

/** Browser login MCP configuration for managed remote agent-browser runs. */
export interface BrowserCredentialsConfig {
  allow?: BrowserCredentialScopeEntry[];
}

/** Marketplace plugin shape for CLIs with explicit plugin install commands. */
export interface MarketplaceAgentPluginConfig {
  /** Marketplace URL/source to register in the sandbox user profile */
  marketplace: string;
  /** Plugin identifier, usually plugin@marketplace */
  plugin: string;
}

/** Gemini extension install shape. */
export interface GeminiAgentPluginConfig {
  /** GitHub URL or local path for the extension */
  source: string;
  /** Optional git ref to install */
  ref?: string;
  /** Enable extension auto-update */
  autoUpdate?: boolean;
  /** Enable pre-release versions */
  preRelease?: boolean;
  /** Skip extension settings prompts during install */
  skipSettings?: boolean;
}

/** Codex marketplace registration shape. */
export interface CodexAgentPluginConfig {
  /** Marketplace source to register */
  marketplace: string;
  /** Optional git ref to pin */
  ref?: string;
  /** Optional sparse checkout paths for Git-backed marketplaces */
  sparse?: string[];
}

/** Agent plugin/extension config. Shape is validated against the selected agent at runtime. */
export type AgentPluginConfig =
  | MarketplaceAgentPluginConfig
  | GeminiAgentPluginConfig
  | CodexAgentPluginConfig;

/** Skills configuration for an agent */
export interface SkillsConfig {
  /** Source directory where skills are staged */
  sourceDir: string;
  /** Target directory where skills are copied for this CLI */
  targetDir: string;
}

/** Reasoning effort for CLIs/models that support it; valid values vary by model. */
export type ReasoningEffort =
  | "off"
  | "none"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "thinking"
  | "no-thinking";

/** MCP Server Configuration */
export interface McpServerConfig {
  // STDIO transport (most common)
  command?: string;
  args?: string[];
  cwd?: string;

  // SSE/HTTP transport
  url?: string;

  // Common fields
  env?: Record<string, string>;
  headers?: Record<string, string>;
  bearerTokenEnvVar?: string;
  httpHeaders?: Record<string, string>;
  envHttpHeaders?: Record<string, string>;
  envVars?: string[];

  // Transport type - auto-detected if omitted
  type?: "stdio" | "sse" | "http";
}

/** File map for uploads/downloads: { "filename.txt": content } */
export type FileMap = Record<string, string | Buffer | ArrayBuffer | Uint8Array>;

// =============================================================================
// SCHEMA VALIDATION
// =============================================================================

/**
 * JSON Schema object (draft-07 compatible)
 *
 * Use this when you want to pass a raw JSON Schema instead of a Zod schema.
 * JSON Schema allows runtime validation modes via SchemaValidationOptions.
 */
export type JsonSchema = Record<string, unknown>;

/**
 * Validation mode presets for JSON Schema validation
 *
 * - strict: Exact type matching, fail on any mismatch, no defaults filled
 * - loose: Aggressive coercion (string↔number, null→empty values), fill defaults (default)
 *
 * Null handling (when schema expects string/number/boolean):
 * - strict: Validation fails
 * - loose: null→"" (string), null→0 (number), null→false (boolean)
 *
 * Note: These modes only apply to JSON Schema. Zod schemas define their own
 * strictness via .passthrough(), .strip(), z.coerce, etc.
 */
export type ValidationMode = "strict" | "loose";

/**
 * Options for JSON Schema validation (Ajv options)
 *
 * Either use a preset mode or provide individual options.
 * Individual options override the preset if both provided.
 */
export interface SchemaValidationOptions {
  /** Preset validation mode (applied first, then individual options override). Default: "loose" */
  mode?: ValidationMode;

  /** Coerce types. false=none, true=basic (string↔number), "array"=aggressive (incl. null→empty). Default: false */
  coerceTypes?: boolean | "array";

  /** Remove properties not in schema. true | 'all' | 'failing'. Default: false */
  removeAdditional?: boolean | "all" | "failing";

  /** Fill in default values from schema. Default: true */
  useDefaults?: boolean;

  /** Collect all errors vs stop at first. Default: true */
  allErrors?: boolean;
}

/**
 * Validation mode preset definitions
 */
export const VALIDATION_PRESETS: Record<ValidationMode, Required<Omit<SchemaValidationOptions, "mode">>> = {
  strict: {
    coerceTypes: false,
    removeAdditional: false,
    useDefaults: false,
    allErrors: true,
  },
  loose: {
    coerceTypes: "array",
    removeAdditional: false,
    useDefaults: true,
    allErrors: true,
  },
};

// =============================================================================
// AGENT CONFIGURATION
// =============================================================================

/** Configuration passed to withAgent() */
export interface AgentConfig {
  /** Agent type (default: "claude") */
  type?: AgentType;
  /** Evolve API key for gateway mode (default: EVOLVE_API_KEY env var) */
  apiKey?: string;
  /** Provider API key for direct mode / BYOK (default: provider env var) */
  providerApiKey?: string;
  /** OAuth token for Claude Max subscription (default: CLAUDE_CODE_OAUTH_TOKEN env var) */
  oauthToken?: string;
  /** Provider base URL for direct mode (default: provider env var or registry default) */
  providerBaseUrl?: string;
  /** Model to use (optional, uses agent's default if omitted) */
  model?: string;
  /** Reasoning effort for models that support it */
  reasoningEffort?: ReasoningEffort;
}

/** Resolved agent config (output of resolution, not an extension of input) */
export interface ResolvedAgentConfig {
  type: AgentType;
  apiKey: string;
  baseUrl?: string;
  isDirectMode: boolean;
  isOAuth?: boolean;
  /** File content for file-based OAuth (Codex) */
  oauthFileContent?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

/** Options for Agent constructor */
export interface AgentOptions {
  /** Sandbox provider (e.g., E2B) */
  sandboxProvider?: SandboxProvider;
  /** Additional environment secrets */
  secrets?: Record<string, string>;
  /** Existing sandbox ID to connect to */
  sandboxId?: string;
  /** Working directory path */
  workingDirectory?: string;
  /** Workspace mode */
  workspaceMode?: WorkspaceMode;
  /** Custom system prompt (appended to workspace template in both modes) */
  systemPrompt?: string;
  /** Context files (uploaded to context/ folder) */
  context?: FileMap;
  /** Workspace files (uploaded to working directory) */
  files?: FileMap;
  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig>;
  /** Runtime browser prompt fragment appended to the agent system prompt */
  browserPrompt?: string;
  /** Evolve-managed browser transport for browser automation */
  managedBrowser?: {
    provider: ManagedBrowserProvider;
    apiKey: string;
    dashboardUrl?: string;
  };
  /** Run-scoped browser login MCP setup. Requires managed remote agent-browser. */
  browserCredentials?: {
    apiKey: string;
    dashboardUrl?: string;
    config?: BrowserCredentialsConfig;
  };
  /** Evolve-managed app integrations */
  integrations?: IntegrationsSetup & {
    apiKey: string;
    dashboardUrl?: string;
  };
  /** Plugins/extensions to install in the sandbox user profile before first run */
  plugins?: AgentPluginConfig[];
  /** Skills to enable (e.g., ["pdf", "dev-browser"]) */
  skills?: SkillName[];

  /**
   * Schema for structured output validation
   *
   * Accepts either:
   * - Zod schema: z.object({ ... }) - validated with Zod's safeParse
   * - JSON Schema: { type: "object", properties: { ... } } - validated with Ajv
   *
   * Auto-detected based on presence of .safeParse method.
   */
  schema?: import("zod").ZodType<unknown> | JsonSchema;

  /**
   * Validation options for JSON Schema (ignored for Zod schemas)
   *
   * Use preset modes or individual Ajv options.
   *
   * @example
   * // Preset mode
   * schemaOptions: { mode: 'loose' }
   *
   * // Individual options
   * schemaOptions: { coerceTypes: true, useDefaults: true }
   */
  schemaOptions?: SchemaValidationOptions;

  // Observability options
  /** Session tag prefix (default: "evolve") */
  sessionTagPrefix?: string;
  /** Observability metadata for trace grouping (generic key-value, domain-agnostic) */
  observability?: Record<string, unknown>;

  // Storage / Checkpointing
  /** Resolved storage configuration (set via Evolve.withStorage()) */
  storage?: ResolvedStorageConfig;
}

// =============================================================================
// RUNTIME OPTIONS
// =============================================================================

/** Options for run() */
export interface RunOptions {
  /** The prompt to send to the agent */
  prompt: string;

  /** Timeout in milliseconds (default: 1 hour) */
  timeoutMs?: number;

  /** Run in background (returns immediately, process continues) */
  background?: boolean;

  /** Restore from checkpoint ID or "latest" before running (requires .withStorage()) */
  from?: string;

  /** Optional comment for the auto-checkpoint created after this run */
  checkpointComment?: string;
}

/** Options for executeCommand() */
export interface ExecuteCommandOptions {
  /** Timeout in milliseconds (default: 1 hour) */
  timeoutMs?: number;

  /** Run in background (default: false) */
  background?: boolean;
}

// =============================================================================
// SESSION RUNTIME
// =============================================================================

/** High-level sandbox lifecycle state */
export type SandboxLifecycleState =
  | "booting"
  | "error"
  | "ready"
  | "running"
  | "paused"
  | "stopped";

/** High-level agent runtime state */
export type AgentRuntimeState = "idle" | "running" | "interrupted" | "error";

/** Lifecycle transition reason */
export type LifecycleReason =
  | "browser_ready"
  | "sandbox_boot"
  | "sandbox_connected"
  | "sandbox_ready"
  | "sandbox_pause"
  | "sandbox_resume"
  | "sandbox_killed"
  | "sandbox_error"
  | "run_start"
  | "run_complete"
  | "run_interrupted"
  | "run_failed"
  | "run_background_complete"
  | "run_background_failed"
  | "command_start"
  | "command_complete"
  | "command_interrupted"
  | "command_failed"
  | "command_background_complete"
  | "command_background_failed";

/** Browser runtime info exposed to host applications. */
export interface BrowserRuntimeInfo {
  liveUrl: string;
  /** Dashboard session ID for trace/replay APIs, present for managed browsers. */
  sessionId?: string;
  /** Session tag for checkpoint correlation, present for managed browsers. */
  sessionTag?: string;
}

/** Lifecycle event emitted by the runtime */
export interface LifecycleEvent {
  sandboxId: string | null;
  sandbox: SandboxLifecycleState;
  agent: AgentRuntimeState;
  timestamp: string;
  reason: LifecycleReason;
  browser?: BrowserRuntimeInfo;
}

/** Snapshot of current runtime status */
export interface SessionStatus {
  sandboxId: string | null;
  sandbox: SandboxLifecycleState;
  agent: AgentRuntimeState;
  activeProcessId: string | null;
  hasRun: boolean;
  timestamp: string;
  browser?: BrowserRuntimeInfo;
}

// =============================================================================
// RESPONSES
// =============================================================================

/** Response from run() and executeCommand() */
export interface AgentResponse {
  /** Sandbox ID for session management */
  sandboxId: string;

  /** Dashboard session ID for trace/replay APIs, present in gateway mode when known. */
  sessionId?: string;

  /** Managed browser runtime info, present when a remote browser is configured. */
  browser?: Pick<BrowserRuntimeInfo, "liveUrl">;

  /** Run ID for spend/cost attribution (present for run(), undefined for executeCommand()) */
  runId?: string;

  /** Exit code of the command */
  exitCode: number;

  /** Standard output */
  stdout: string;

  /** Standard error */
  stderr: string;

  /** Checkpoint info if storage configured and run succeeded (undefined otherwise) */
  checkpoint?: CheckpointInfo;
}

// =============================================================================
// COST TYPES
// =============================================================================

/** Cost breakdown for a single run() invocation */
export interface RunCost {
  /** Run ID matching AgentResponse.runId */
  runId: string;
  /** 1-based chronological position in session */
  index: number;
  /** Total cost in USD (includes platform margin) */
  cost: number;
  /** Token counts */
  tokens: { prompt: number; completion: number };
  /** Model used (e.g., "claude-opus-4-8"). Last observed model if multiple models used in a run. */
  model: string;
  /** Number of LLM API requests in this run */
  requests: number;
  /** ISO timestamp when this data was fetched */
  asOf: string;
  /** False if recent LLM calls may still be batching (~60s delay) */
  isComplete: boolean;
  /** True if spend log pagination was capped — totals may be understated */
  truncated: boolean;
}

/** Cost breakdown for an entire agent session (all runs) */
export interface SessionCost {
  /** Session tag matching agent.getSessionTag() */
  sessionTag: string;
  /** Total cost across all runs in USD */
  totalCost: number;
  /** Aggregate token counts */
  totalTokens: { prompt: number; completion: number };
  /** Per-run breakdown, chronological order */
  runs: RunCost[];
  /** ISO timestamp when this data was fetched */
  asOf: string;
  /** False if session is still active or recently ended */
  isComplete: boolean;
  /** True if spend log pagination was capped — totals may be understated */
  truncated: boolean;
}

/** Result from getOutputFiles() with optional schema validation */
export interface OutputResult<T = unknown> {
  /** Output files from output/ folder */
  files: FileMap;
  /** Parsed and validated result.json data (null if no schema or validation failed) */
  data: T | null;
  /** Validation or parse error message, if any */
  error?: string;
  /** Raw result.json string when parse or validation failed (for debugging) */
  rawData?: string;
}

// =============================================================================
// STREAMING
// =============================================================================

/** Callbacks for streaming output */
export interface StreamCallbacks {
  /** Called for each stdout chunk */
  onStdout?: (data: string) => void;

  /** Called for each stderr chunk */
  onStderr?: (data: string) => void;

  /** Called for each parsed content event */
  onContent?: (event: OutputEvent) => void;

  /** Called for sandbox/agent lifecycle transitions */
  onLifecycle?: (event: LifecycleEvent) => void;
}

// =============================================================================
// MANAGED INTEGRATIONS
// =============================================================================

/**
 * Configuration for managed integrations.
 */
/** Tool filter configuration per app */
export type IntegrationToolsFilter =
  | string[]                            // Enable only these tools
  | { enable: string[] }              // Enable only these tools
  | { disable: string[] }             // Disable these tools
  | { tags: string[] };               // Filter by behavior tags

export interface IntegrationsConfig {
  /**
   * Apps to expose to the agent.
   *
   * @example
   * apps: ["github", "gmail", "linear"]
   */
  apps: string[];

  /**
   * Per-app tool filtering.
   *
   * @example
   * tools: {
   *   github: { enable: ["github_create_issue", "github_list_repos"] },
   *   gmail: { disable: ["gmail_delete_email"] },
   *   slack: { tags: ["readOnlyHint"] }
   * }
   */
  tools?: Record<string, IntegrationToolsFilter>;

  /**
   * Pin specific connected accounts by account ID or account label.
   */
  accounts?: Record<string, string[]>;

  /**
   * API keys for apps that use API-key auth.
   * Requires a matching authConfigs entry for each app.
   */
  keys?: Record<string, string>;

  /**
   * Custom auth config IDs per app.
   */
  authConfigs?: Record<string, string>;
}

/**
 * Managed integrations setup.
 */
export interface IntegrationsSetup extends IntegrationsConfig {
  /**
   * Integration user ID. Use "root" for dashboard-owned/private accounts,
   * or your app's stable end-user ID for per-user accounts.
   */
  userId: string;
}

// =============================================================================
// STORAGE & CHECKPOINTING
// =============================================================================

/**
 * Storage configuration for .withStorage()
 *
 * BYOK mode: provide url (e.g., "s3://my-bucket/prefix/")
 * Gateway mode: omit url (uses Evolve-managed storage)
 *
 * @example
 * // BYOK — user's own S3 bucket
 * .withStorage({ url: "s3://my-bucket/agent-snapshots/" })
 *
 * // BYOK — Cloudflare R2
 * .withStorage({ url: "s3://my-bucket/prefix/", endpoint: "https://acct.r2.cloudflarestorage.com" })
 *
 * // Gateway — Evolve-managed storage
 * .withStorage()
 */
export interface StorageConfig {
  /** S3 URL: "s3://bucket/prefix" or "https://endpoint/bucket/prefix" */
  url?: string;
  /** Explicit bucket name (overrides URL parsing) */
  bucket?: string;
  /** Key prefix (overrides URL parsing) */
  prefix?: string;
  /** AWS region (default from env or us-east-1) */
  region?: string;
  /** Custom S3 endpoint (R2, MinIO, GCS) */
  endpoint?: string;
  /** Explicit credentials (default: AWS SDK credential chain) */
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

/** Resolved storage configuration (internal) */
export interface ResolvedStorageConfig {
  bucket: string;
  prefix: string;
  region: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
  mode: "byok" | "gateway";
  gatewayUrl?: string;
  gatewayApiKey?: string;
}

/**
 * Checkpoint info returned after a successful run
 *
 * Pass `checkpoint.id` as `from` to restore into a fresh sandbox.
 */
export interface CheckpointInfo {
  /** Checkpoint ID — pass as `from` to restore */
  id: string;
  /** SHA-256 of tar.gz — integrity verification */
  hash: string;
  /** Session tag at checkpoint time — lineage tracking */
  tag: string;
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Archive size in bytes */
  sizeBytes?: number;
  /** Agent type that produced this checkpoint */
  agentType?: string;
  /** Model that produced this checkpoint */
  model?: string;
  /** Workspace mode used when checkpoint was created */
  workspaceMode?: string;
  /** Parent checkpoint ID — the checkpoint this was restored from (lineage tracking) */
  parentId?: string;
  /** User-provided label for this checkpoint */
  comment?: string;
}

// =============================================================================
// STORAGE CLIENT (standalone checkpoint access)
// =============================================================================

/** Options for StorageClient.downloadCheckpoint() */
export interface DownloadCheckpointOptions {
  /** Local directory to save to (default: current working directory) */
  to?: string;
  /** Extract the archive (default: true). If false, saves the raw .tar.gz file. */
  extract?: boolean;
}

/** Options for StorageClient.downloadFiles() */
export interface DownloadFilesOptions {
  /** Specific file paths to extract (relative to archive root, e.g., "workspace/output/result.json") */
  files?: string[];
  /** Glob patterns to match files (e.g., ["workspace/output/*.json"]) */
  glob?: string[];
  /** Local directory to save files to. If omitted, files are returned in-memory only. */
  to?: string;
}

/**
 * Storage client for browsing and fetching checkpoints without an Evolve instance.
 *
 * @example
 * const s = storage({ url: "s3://my-bucket/prefix/" });
 * const checkpoints = await s.listCheckpoints({ tag: "poker-agent" });
 * const files = await s.downloadFiles("latest", { glob: ["workspace/output/*.json"] });
 */
export interface StorageClient {
  /** List checkpoints with optional filtering */
  listCheckpoints(options?: { limit?: number; tag?: string }): Promise<CheckpointInfo[]>;
  /** Get a specific checkpoint's metadata by ID */
  getCheckpoint(id: string): Promise<CheckpointInfo>;
  /** Download an entire checkpoint archive. Returns the output path. */
  downloadCheckpoint(idOrLatest: string, options?: DownloadCheckpointOptions): Promise<string>;
  /** Download files from a checkpoint as a FileMap. */
  downloadFiles(idOrLatest: string, options?: DownloadFilesOptions): Promise<FileMap>;
}
