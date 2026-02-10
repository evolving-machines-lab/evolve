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
export type AgentType = "claude" | "codex" | "gemini" | "qwen";

/** Agent type constants for use in code */
export const AGENT_TYPES = {
  CLAUDE: "claude",
  CODEX: "codex",
  GEMINI: "gemini",
  QWEN: "qwen",
} as const;

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Workspace mode determines folder structure and system prompt */
export type WorkspaceMode = "knowledge" | "swe";

/** Available skills that can be enabled */
export type SkillName = "pdf" | "dev-browser" | (string & {});

/** Skills configuration for an agent */
export interface SkillsConfig {
  /** Source directory where skills are staged */
  sourceDir: string;
  /** Target directory where skills are copied for this CLI */
  targetDir: string;
  /** CLI flag to enable skills (e.g., "--experimental-skills") */
  enableFlag?: string;
}

/** Reasoning effort for models that support it (Codex only) */
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";  // xhigh = maximum reasoning

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
  /** Reasoning effort for Codex models */
  reasoningEffort?: ReasoningEffort;
  /** Beta headers for Claude (Sonnet 4.5 only) */
  betas?: string[];
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
  betas?: string[];
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

  // Composio integration
  /**
   * Composio Tool Router configuration
   * Set via withComposio() - provides access to 1000+ tools
   */
  composio?: ComposioSetup;

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

  /** Restore from checkpoint ID before running (requires .withStorage()) */
  from?: string;
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

/** Lifecycle event emitted by the runtime */
export interface LifecycleEvent {
  sandboxId: string | null;
  sandbox: SandboxLifecycleState;
  agent: AgentRuntimeState;
  timestamp: string;
  reason: LifecycleReason;
}

/** Snapshot of current runtime status */
export interface SessionStatus {
  sandboxId: string | null;
  sandbox: SandboxLifecycleState;
  agent: AgentRuntimeState;
  activeProcessId: string | null;
  hasRun: boolean;
  timestamp: string;
}

// =============================================================================
// RESPONSES
// =============================================================================

/** Response from run() and executeCommand() */
export interface AgentResponse {
  /** Sandbox ID for session management */
  sandboxId: string;

  /** Exit code of the command */
  exitCode: number;

  /** Standard output */
  stdout: string;

  /** Standard error */
  stderr: string;

  /** Checkpoint info if storage configured and run succeeded (undefined otherwise) */
  checkpoint?: CheckpointInfo;
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
// COMPOSIO INTEGRATION
// =============================================================================

/**
 * Configuration for Composio Tool Router integration
 *
 * Provides access to 1000+ tools (GitHub, Gmail, Slack, etc.) via MCP.
 * Evidence: tool-router/quickstart.mdx
 */
/** Tool filter configuration per toolkit */
export type ToolsFilter =
  | string[]                          // Enable only these tools
  | { enable: string[] }              // Enable only these tools
  | { disable: string[] }             // Disable these tools
  | { tags: string[] };               // Filter by behavior tags

export interface ComposioConfig {
  /**
   * Restrict to specific toolkits
   *
   * @example
   * toolkits: ["github", "gmail", "linear"]
   */
  toolkits?: string[];

  /**
   * Per-toolkit tool filtering
   *
   * @example
   * tools: {
   *   github: ["github_create_issue", "github_list_repos"],
   *   gmail: { disable: ["gmail_delete_email"] },
   *   slack: { tags: ["readOnlyHint"] }
   * }
   */
  tools?: Record<string, ToolsFilter>;

  /**
   * API keys for direct authentication (bypasses OAuth)
   * For tools that support API key auth (e.g., Stripe, OpenAI)
   *
   * @example
   * keys: { stripe: "sk_live_...", openai: "sk-..." }
   */
  keys?: Record<string, string>;

  /**
   * Custom OAuth auth config IDs for white-labeling
   * Created in Composio dashboard
   *
   * @example
   * authConfigs: { github: "ac_your_github_config" }
   */
  authConfigs?: Record<string, string>;
}

/**
 * Composio setup for Tool Router integration
 *
 * Combines user identification with optional configuration.
 */
export interface ComposioSetup {
  /** User's unique identifier for Composio session */
  userId: string;
  /** Optional Composio configuration */
  config?: ComposioConfig;
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
}
