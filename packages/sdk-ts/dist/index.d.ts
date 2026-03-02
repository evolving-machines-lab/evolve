import * as zod from 'zod';
import { z } from 'zod';
import { EventEmitter } from 'events';
export { E2BConfig, E2BProvider, createE2BProvider } from '@evolvingmachines/e2b';
export { DaytonaConfig, DaytonaProvider, createDaytonaProvider } from '@evolvingmachines/daytona';
export { ModalConfig, ModalProvider, createModalProvider } from '@evolvingmachines/modal';

/**
 * ACP-inspired output types for unified agent event streaming.
 * These types are independent of @agentclientprotocol/sdk.
 *
 * ACP schema reference:
 *   MANUS-API/KNOWLEDGE/acp-typescript-sdk/src/schema/types.gen.ts
 *   (SessionUpdate, ContentBlock, ImageContent, TextContent, ToolCall, ToolCallUpdate, Plan)
 *
 * INTERNAL REFERENCE - JSDoc stripped from published package.
 *
 * @example Event Flow
 * ```
 * agent_message_chunk  → Text/image streaming from agent
 * agent_thought_chunk  → Reasoning (Codex) or thinking (Claude)
 * user_message_chunk   → User message echo (Gemini)
 * tool_call            → Tool started (status: pending/in_progress)
 * tool_call_update     → Tool finished (status: completed/failed)
 * plan                 → TodoWrite updates
 * ```
 *
 * @example UI Integration
 * ```ts
 * evolve.on('content', (event: OutputEvent) => {
 *   switch (event.update.sessionUpdate) {
 *     case 'agent_message_chunk':
 *       appendToChat(event.update.content);
 *       break;
 *     case 'tool_call':
 *       addToolCard(event.update.toolCallId, event.update.title);
 *       break;
 *     case 'tool_call_update':
 *       updateToolCard(event.update.toolCallId, event.update.status);
 *       break;
 *   }
 * });
 * ```
 */
/**
 * Tool operation category for UI grouping/icons.
 *
 * | Kind | Tools | Icon suggestion |
 * |------|-------|-----------------|
 * | read | Read, NotebookRead | 📄 |
 * | edit | Edit, Write, NotebookEdit | ✏️ |
 * | delete | (future) | 🗑️ |
 * | move | (future) | 📦 |
 * | search | Glob, Grep, LS | 🔍 |
 * | execute | Bash, BashOutput, KillShell | ⚡ |
 * | think | Task (subagent) | 🧠 |
 * | fetch | WebFetch, WebSearch | 🌐 |
 * | switch_mode | ExitPlanMode | 🔀 |
 * | other | MCP tools, unknown | ❓ |
 */
type ToolKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "switch_mode" | "other";
/**
 * Tool execution lifecycle.
 *
 * Flow: pending → in_progress → completed|failed
 *
 * - pending: Tool call received, not yet executing
 * - in_progress: Tool is executing (Codex command_execution)
 * - completed: Tool finished successfully
 * - failed: Tool errored (check content for error message)
 */
type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
/**
 * Plan/Todo item status.
 */
type PlanEntryStatus = "pending" | "in_progress" | "completed";
/**
 * Text content block.
 */
interface TextContent {
    type: "text";
    text: string;
}
/**
 * Image content block (base64 or URL).
 */
interface ImageContent {
    type: "image";
    /** Base64-encoded image data */
    data: string;
    /** MIME type (e.g., "image/png") */
    mimeType: string;
    /** Optional URL if image is remote */
    uri?: string;
}
/**
 * Diff content for file edits.
 */
interface DiffContent {
    type: "diff";
    /** File path being edited */
    path: string;
    /** Original text (null for new files) */
    oldText: string | null;
    /** New text after edit */
    newText: string;
}
/**
 * Content that can appear in messages.
 */
type ContentBlock = TextContent | ImageContent;
/**
 * Content attached to tool calls.
 * Either wrapped content or a diff.
 */
type ToolCallContent = {
    type: "content";
    content: ContentBlock;
} | DiffContent;
/**
 * File location affected by a tool call.
 */
interface ToolCallLocation {
    /** Absolute file path */
    path: string;
    /** Line number (0-indexed for Read offset) */
    line?: number;
}
/**
 * Todo/plan entry from TodoWrite.
 */
interface PlanEntry {
    /** Task description */
    content: string;
    /** Current status */
    status: PlanEntryStatus;
    /** Priority level */
    priority: "high" | "medium" | "low";
}
/**
 * All possible session update types.
 * Discriminated union on `sessionUpdate` field.
 */
type SessionUpdate = AgentMessageChunk | AgentThoughtChunk | UserMessageChunk | ToolCall | ToolCallUpdate | Plan;
/**
 * Streaming text/image from agent.
 * May arrive in multiple chunks - concatenate text.
 */
interface AgentMessageChunk {
    sessionUpdate: "agent_message_chunk";
    content: ContentBlock;
}
/**
 * Agent reasoning/thinking (not shown to end user by default).
 * - Codex: "reasoning" item type
 * - Claude: "thinking" content block
 */
interface AgentThoughtChunk {
    sessionUpdate: "agent_thought_chunk";
    content: ContentBlock;
}
/**
 * User message echo (primarily from Gemini).
 */
interface UserMessageChunk {
    sessionUpdate: "user_message_chunk";
    content: ContentBlock;
}
/**
 * Tool call started.
 *
 * Match with ToolCallUpdate via `toolCallId`.
 *
 * @example Claude Read tool
 * ```json
 * {
 *   "sessionUpdate": "tool_call",
 *   "toolCallId": "toolu_01ABC...",
 *   "title": "Read /src/index.ts (1 - 100)",
 *   "kind": "read",
 *   "status": "pending",
 *   "locations": [{ "path": "/src/index.ts", "line": 0 }]
 * }
 * ```
 */
interface ToolCall {
    sessionUpdate: "tool_call";
    /** Unique ID to match with ToolCallUpdate */
    toolCallId: string;
    /** Human-readable title (e.g., "`npm install`", "Read /path/file.ts") */
    title: string;
    /** Tool category for UI grouping */
    kind: ToolKind;
    /** Execution status */
    status: ToolCallStatus;
    /** Original tool input parameters */
    rawInput?: unknown;
    /** Diff for edits, description for commands */
    content?: ToolCallContent[];
    /** File paths affected */
    locations?: ToolCallLocation[];
}
/**
 * Tool call completed/failed.
 *
 * Match with ToolCall via `toolCallId`.
 *
 * @example Successful completion
 * ```json
 * {
 *   "sessionUpdate": "tool_call_update",
 *   "toolCallId": "toolu_01ABC...",
 *   "status": "completed",
 *   "content": [{ "type": "content", "content": { "type": "text", "text": "..." } }]
 * }
 * ```
 *
 * @example Failed tool
 * ```json
 * {
 *   "sessionUpdate": "tool_call_update",
 *   "toolCallId": "toolu_01ABC...",
 *   "status": "failed",
 *   "content": [{ "type": "content", "content": { "type": "text", "text": "```\nError: ...\n```" } }]
 * }
 * ```
 *
 * @example Browser-Use MCP tool response
 * The browser-use MCP tool returns a JSON string in content[].content.text:
 * ```json
 * {
 *   "sessionUpdate": "tool_call_update",
 *   "toolCallId": "...",
 *   "status": "completed",
 *   "content": [{
 *     "type": "content",
 *     "content": {
 *       "type": "text",
 *       "text": "{\"live_url\":\"https://...\",\"screenshot_url\":\"https://...\",\"steps\":[{\"screenshot_url\":\"https://...\"}]}"
 *     }
 *   }]
 * }
 * ```
 * The `text` field contains a JSON string with:
 * - `live_url`: URL for live browser view (VNC/noVNC)
 * - `screenshot_url`: URL for screenshot image
 * - `steps[].screenshot_url`: Alternative location for screenshots
 */
interface ToolCallUpdate {
    sessionUpdate: "tool_call_update";
    /** Matches ToolCall.toolCallId */
    toolCallId: string;
    /** Final status */
    status?: ToolCallStatus;
    /** Updated title (e.g., "Exited Plan Mode") */
    title?: string;
    /** Output content or error message */
    content?: ToolCallContent[];
    /** Updated locations (rare) */
    locations?: ToolCallLocation[];
}
/**
 * Todo list update from TodoWrite tool.
 * Replaces entire todo list on each update.
 */
interface Plan {
    sessionUpdate: "plan";
    /** All current plan entries */
    entries: PlanEntry[];
}
/**
 * Top-level event emitted by Evolve 'content' event.
 *
 * @example
 * ```ts
 * evolve.on('content', (event: OutputEvent) => {
 *   console.log(event.sessionId, event.update.sessionUpdate);
 * });
 * ```
 */
interface OutputEvent {
    /** Session ID (from agent, may be undefined) */
    sessionId?: string;
    /** The session update payload */
    update: SessionUpdate;
}

/** Result of a completed sandbox command */
interface SandboxCommandResult {
    exitCode: number;
    stdout: string;
    stderr: string;
}
/** Handle to a running background process in sandbox */
interface SandboxCommandHandle {
    readonly processId: string;
    wait(): Promise<SandboxCommandResult>;
    kill(): Promise<boolean>;
}
/** Information about a running process */
interface ProcessInfo {
    processId: string;
    cmd: string;
    args: string[];
    envs: Record<string, string>;
    cwd?: string;
    tag?: string;
}
/** Options for command execution */
interface SandboxRunOptions {
    timeoutMs?: number;
    envs?: Record<string, string>;
    cwd?: string;
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
}
/** Options for spawning background processes in sandbox */
interface SandboxSpawnOptions extends SandboxRunOptions {
    stdin?: boolean;
}
/** Options for creating a sandbox */
interface SandboxCreateOptions {
    /** Sandbox image/template ID. Provider uses its default if not specified. */
    image?: string;
    envs?: Record<string, string>;
    metadata?: Record<string, string>;
    timeoutMs?: number;
    workingDirectory?: string;
}
/** Command execution capabilities */
interface SandboxCommands {
    run(command: string, options?: SandboxRunOptions): Promise<SandboxCommandResult>;
    spawn(command: string, options?: SandboxSpawnOptions): Promise<SandboxCommandHandle>;
    list(): Promise<ProcessInfo[]>;
    kill(processId: string): Promise<boolean>;
}
/** File system operations */
interface SandboxFiles {
    read(path: string): Promise<string | Uint8Array>;
    write(path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void>;
    writeBatch(files: Array<{
        path: string;
        data: string | Buffer | ArrayBuffer | Uint8Array;
    }>): Promise<void>;
    makeDir(path: string): Promise<void>;
}
/** Sandbox instance */
interface SandboxInstance {
    readonly sandboxId: string;
    readonly commands: SandboxCommands;
    readonly files: SandboxFiles;
    /** Get host URL for a port */
    getHost(port: number): Promise<string>;
    kill(): Promise<void>;
    pause(): Promise<void>;
}
/** Sandbox lifecycle management - providers implement this */
interface SandboxProvider {
    /** Provider type identifier (e.g., "e2b") */
    readonly providerType: string;
    /** Human-readable provider name for logging */
    readonly name?: string;
    create(options: SandboxCreateOptions): Promise<SandboxInstance>;
    connect(sandboxId: string, timeoutMs?: number): Promise<SandboxInstance>;
}
/** Supported agent types (headless CLI agents only, no ACP) */
type AgentType = "claude" | "codex" | "gemini" | "qwen" | "kimi" | "opencode";
/** Agent type constants for use in code */
declare const AGENT_TYPES: {
    readonly CLAUDE: "claude";
    readonly CODEX: "codex";
    readonly GEMINI: "gemini";
    readonly QWEN: "qwen";
    readonly KIMI: "kimi";
    readonly OPENCODE: "opencode";
};
/** Workspace mode determines folder structure and system prompt */
type WorkspaceMode = "knowledge" | "swe";
/** Available skills that can be enabled */
type SkillName = "pdf" | "dev-browser" | (string & {});
/** Skills configuration for an agent */
interface SkillsConfig {
    /** Source directory where skills are staged */
    sourceDir: string;
    /** Target directory where skills are copied for this CLI */
    targetDir: string;
    /** CLI flag to enable skills (e.g., "--experimental-skills") */
    enableFlag?: string;
}
/** Reasoning effort for models that support it (Codex only) */
type ReasoningEffort = "low" | "medium" | "high" | "xhigh";
/** MCP Server Configuration */
interface McpServerConfig {
    command?: string;
    args?: string[];
    cwd?: string;
    url?: string;
    env?: Record<string, string>;
    headers?: Record<string, string>;
    bearerTokenEnvVar?: string;
    httpHeaders?: Record<string, string>;
    envHttpHeaders?: Record<string, string>;
    envVars?: string[];
    type?: "stdio" | "sse" | "http";
}
/** File map for uploads/downloads: { "filename.txt": content } */
type FileMap = Record<string, string | Buffer | ArrayBuffer | Uint8Array>;
/**
 * JSON Schema object (draft-07 compatible)
 *
 * Use this when you want to pass a raw JSON Schema instead of a Zod schema.
 * JSON Schema allows runtime validation modes via SchemaValidationOptions.
 */
type JsonSchema = Record<string, unknown>;
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
type ValidationMode = "strict" | "loose";
/**
 * Options for JSON Schema validation (Ajv options)
 *
 * Either use a preset mode or provide individual options.
 * Individual options override the preset if both provided.
 */
interface SchemaValidationOptions {
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
declare const VALIDATION_PRESETS: Record<ValidationMode, Required<Omit<SchemaValidationOptions, "mode">>>;
/** Configuration passed to withAgent() */
interface AgentConfig {
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
}
/** Resolved agent config (output of resolution, not an extension of input) */
interface ResolvedAgentConfig {
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
interface AgentOptions {
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
    schema?: zod.ZodType<unknown> | JsonSchema;
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
    /** Session tag prefix (default: "evolve") */
    sessionTagPrefix?: string;
    /** Observability metadata for trace grouping (generic key-value, domain-agnostic) */
    observability?: Record<string, unknown>;
    /**
     * Composio Tool Router configuration
     * Set via withComposio() - provides access to 1000+ tools
     */
    composio?: ComposioSetup;
    /** Resolved storage configuration (set via Evolve.withStorage()) */
    storage?: ResolvedStorageConfig;
}
/** Options for run() */
interface RunOptions {
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
interface ExecuteCommandOptions {
    /** Timeout in milliseconds (default: 1 hour) */
    timeoutMs?: number;
    /** Run in background (default: false) */
    background?: boolean;
}
/** High-level sandbox lifecycle state */
type SandboxLifecycleState = "booting" | "error" | "ready" | "running" | "paused" | "stopped";
/** High-level agent runtime state */
type AgentRuntimeState = "idle" | "running" | "interrupted" | "error";
/** Lifecycle transition reason */
type LifecycleReason = "sandbox_boot" | "sandbox_connected" | "sandbox_ready" | "sandbox_pause" | "sandbox_resume" | "sandbox_killed" | "sandbox_error" | "run_start" | "run_complete" | "run_interrupted" | "run_failed" | "run_background_complete" | "run_background_failed" | "command_start" | "command_complete" | "command_interrupted" | "command_failed" | "command_background_complete" | "command_background_failed";
/** Lifecycle event emitted by the runtime */
interface LifecycleEvent {
    sandboxId: string | null;
    sandbox: SandboxLifecycleState;
    agent: AgentRuntimeState;
    timestamp: string;
    reason: LifecycleReason;
}
/** Snapshot of current runtime status */
interface SessionStatus {
    sandboxId: string | null;
    sandbox: SandboxLifecycleState;
    agent: AgentRuntimeState;
    activeProcessId: string | null;
    hasRun: boolean;
    timestamp: string;
}
/** Response from run() and executeCommand() */
interface AgentResponse {
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
interface OutputResult<T = unknown> {
    /** Output files from output/ folder */
    files: FileMap;
    /** Parsed and validated result.json data (null if no schema or validation failed) */
    data: T | null;
    /** Validation or parse error message, if any */
    error?: string;
    /** Raw result.json string when parse or validation failed (for debugging) */
    rawData?: string;
}
/** Callbacks for streaming output */
interface StreamCallbacks {
    /** Called for each stdout chunk */
    onStdout?: (data: string) => void;
    /** Called for each stderr chunk */
    onStderr?: (data: string) => void;
    /** Called for each parsed content event */
    onContent?: (event: OutputEvent) => void;
    /** Called for sandbox/agent lifecycle transitions */
    onLifecycle?: (event: LifecycleEvent) => void;
}
/**
 * Configuration for Composio Tool Router integration
 *
 * Provides access to 1000+ tools (GitHub, Gmail, Slack, etc.) via MCP.
 * Evidence: tool-router/quickstart.mdx
 */
/** Tool filter configuration per toolkit */
type ToolsFilter = string[] | {
    enable: string[];
} | {
    disable: string[];
} | {
    tags: string[];
};
interface ComposioConfig {
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
interface ComposioSetup {
    /** User's unique identifier for Composio session */
    userId: string;
    /** Optional Composio configuration */
    config?: ComposioConfig;
}
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
interface StorageConfig {
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
interface ResolvedStorageConfig {
    bucket: string;
    prefix: string;
    region: string;
    endpoint?: string;
    credentials?: {
        accessKeyId: string;
        secretAccessKey: string;
    };
    mode: "byok" | "gateway";
    gatewayUrl?: string;
    gatewayApiKey?: string;
}
/**
 * Checkpoint info returned after a successful run
 *
 * Pass `checkpoint.id` as `from` to restore into a fresh sandbox.
 */
interface CheckpointInfo {
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
/** Options for StorageClient.downloadCheckpoint() */
interface DownloadCheckpointOptions {
    /** Local directory to save to (default: current working directory) */
    to?: string;
    /** Extract the archive (default: true). If false, saves the raw .tar.gz file. */
    extract?: boolean;
}
/** Options for StorageClient.downloadFiles() */
interface DownloadFilesOptions {
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
interface StorageClient {
    /** List checkpoints with optional filtering */
    listCheckpoints(options?: {
        limit?: number;
        tag?: string;
    }): Promise<CheckpointInfo[]>;
    /** Get a specific checkpoint's metadata by ID */
    getCheckpoint(id: string): Promise<CheckpointInfo>;
    /** Download an entire checkpoint archive. Returns the output path. */
    downloadCheckpoint(idOrLatest: string, options?: DownloadCheckpointOptions): Promise<string>;
    /** Download files from a checkpoint as a FileMap. */
    downloadFiles(idOrLatest: string, options?: DownloadFilesOptions): Promise<FileMap>;
}

/**
 * Composio Auth Helpers
 *
 * Helper functions for managing Composio authentication in your app's UI.
 * Evidence: tool-router/manually-authenticating-users.mdx
 */
/**
 * Result from getAuthUrl()
 */
interface ComposioAuthResult {
    /** OAuth/Connect Link URL to redirect user to */
    url: string;
    /** Connection request ID for tracking */
    connectionId: string;
}
/**
 * Connection status for a toolkit
 */
interface ComposioConnectionStatus {
    /** Toolkit slug (e.g., "github", "gmail") */
    toolkit: string;
    /** Whether the user has an active connection */
    connected: boolean;
    /** Connected account ID if connected */
    accountId?: string;
}
/**
 * Get OAuth URL for a toolkit
 *
 * Returns a Connect Link URL that you can show in your app's UI.
 * User completes OAuth, then is redirected back to your app.
 *
 * @param userId - User's unique identifier
 * @param toolkit - Toolkit slug (e.g., "github", "gmail")
 * @returns Auth URL and connection ID
 *
 * @example
 * const { url } = await getAuthUrl("user_123", "github");
 * // Show button: <a href={url}>Connect GitHub</a>
 */
declare function getAuthUrl(userId: string, toolkit: string): Promise<ComposioAuthResult>;
/**
 * Get connection status for a user
 *
 * @param userId - User's unique identifier
 * @param toolkit - Optional toolkit slug to check specific connection
 * @returns Status map for all toolkits, or boolean if toolkit specified
 *
 * @example
 * // Get all connections
 * const status = await getStatus("user_123");
 * // { github: true, gmail: false, slack: true }
 *
 * @example
 * // Check single toolkit
 * const isConnected = await getStatus("user_123", "github");
 * // true
 */
declare function getStatus(userId: string, toolkit?: string): Promise<Record<string, boolean> | boolean>;
/**
 * Get detailed connection info for a user
 *
 * Returns array of connections with account IDs.
 * More detailed than getStatus() - use when you need account IDs.
 *
 * @param userId - User's unique identifier
 * @returns Array of connection statuses
 *
 * @example
 * const connections = await getConnections("user_123");
 * // [{ toolkit: "github", connected: true, accountId: "ca_..." }, ...]
 */
declare function getConnections(userId: string): Promise<ComposioConnectionStatus[]>;

/**
 * Unified Agent Implementation
 *
 * Single Agent class that uses registry lookup for agent-specific behavior.
 * All agent differences are data (in registry), not code.
 *
 * Evidence: sdk-rewrite-v3.md Design Decisions section
 */

/**
 * Unified Agent class
 *
 * Uses registry lookup for agent-specific behavior.
 * Tracks hasRun state for continue flag handling.
 */
declare class Agent {
    private agentConfig;
    private options;
    private sandbox?;
    private hasRun;
    private readonly workingDir;
    private lastRunTimestamp?;
    private readonly registry;
    private sessionLogger?;
    private activeCommand?;
    private activeProcessId;
    private activeOperationId;
    private activeOperationKind;
    private nextOperationId;
    private interruptedOperations;
    private sandboxState;
    private agentState;
    private readonly skills?;
    private readonly storage?;
    private lastCheckpointId?;
    private readonly zodSchema?;
    private readonly jsonSchema?;
    private readonly schemaOptions?;
    private readonly compiledValidator?;
    constructor(agentConfig: ResolvedAgentConfig, options?: AgentOptions);
    private emitLifecycle;
    private invalidateActiveOperation;
    private beginOperation;
    private finalizeOperation;
    private watchBackgroundOperation;
    /**
     * Create Ajv validator instance with configured options
     */
    private createAjvValidator;
    /**
     * Get or create sandbox instance
     */
    getSandbox(callbacks?: StreamCallbacks): Promise<SandboxInstance>;
    /**
     * Build environment variables for sandbox
     */
    private buildEnvironmentVariables;
    /**
     * Agent-specific authentication setup
     */
    private setupAgentAuth;
    /**
     * Setup workspace structure and files
     *
     * @param opts.skipSystemPrompt - When true, skip writing the system prompt file.
     *   Used on restore from checkpoint: the tar already contains the correct file.
     */
    private setupWorkspace;
    /**
     * Setup skills for the agent
     *
     * Copies selected skills from source (~/.evolve/skills/) to CLI-specific directory.
     * All CLIs use the same pattern: skills are auto-discovered from their target directory.
     */
    private setupSkills;
    /**
     * Upload context files to context/ folder
     */
    private uploadContextFiles;
    /**
     * Upload workspace files to working directory
     */
    private uploadWorkspaceFiles;
    /**
     * Build the CLI command for running the agent
     */
    private buildCommand;
    /**
     * Run agent with prompt
     *
     * Streams output via callbacks, returns final response.
     */
    run(options: RunOptions, callbacks?: StreamCallbacks): Promise<AgentResponse>;
    /**
     * Execute arbitrary command in sandbox
     */
    executeCommand(command: string, options?: ExecuteCommandOptions, callbacks?: StreamCallbacks): Promise<AgentResponse>;
    /**
     * Upload context files (to context/ folder)
     */
    uploadContext(files: FileMap): Promise<void>;
    /**
     * Upload files to working directory
     */
    uploadFiles(files: FileMap): Promise<void>;
    /**
     * Get output files from output/ folder with optional schema validation
     *
     * Returns files modified after the last run() call.
     * If schema was provided, validates result.json and returns typed data.
     *
     * @param recursive - Include files in subdirectories (default: false)
     */
    getOutputFiles<T = unknown>(recursive?: boolean): Promise<OutputResult<T>>;
    /**
     * Create an explicit checkpoint of the current sandbox state.
     *
     * Requires an active sandbox (call run() first).
     *
     * @param options.comment - Optional label for this checkpoint
     */
    checkpoint(options?: {
        comment?: string;
    }): Promise<CheckpointInfo>;
    /**
     * Get current session (sandbox ID)
     */
    getSession(): string | null;
    /**
     * Set session (sandbox ID) to connect to
     *
     * When reconnecting to an existing sandbox, we assume the agent
     * may have already run commands, so we set hasRun=true to use
     * the continue/resume command template instead of first-run.
     */
    setSession(sandboxId: string): Promise<void>;
    /**
     * Pause sandbox
     */
    pause(callbacks?: StreamCallbacks): Promise<void>;
    /**
     * Resume sandbox
     */
    resume(callbacks?: StreamCallbacks): Promise<void>;
    /**
     * Interrupt active command without killing the sandbox.
     */
    interrupt(callbacks?: StreamCallbacks): Promise<boolean>;
    /**
     * Get current runtime status for sandbox and agent.
     */
    status(): SessionStatus;
    /**
     * Kill sandbox (terminates all processes)
     */
    kill(callbacks?: StreamCallbacks): Promise<void>;
    /**
     * Get host URL for a port
     */
    getHost(port: number): Promise<string>;
    /**
     * Get agent type
     */
    getAgentType(): AgentType;
    /**
     * Get current session tag
     *
     * Returns null if no session has started (run() not called yet).
     */
    getSessionTag(): string | null;
    /**
     * Get current session timestamp
     *
     * Returns null if no session has started (run() not called yet).
     */
    getSessionTimestamp(): string | null;
    /**
     * Flush pending observability events without closing the session.
     */
    flushObservability(): Promise<void>;
}

/**
 * Claude JSONL → ACP-style events parser.
 *
 * Native schema source (@anthropic-ai/claude-agent-sdk):
 *   MANUS-API/KNOWLEDGE/claude-agent-sdk/cc_sdk_typescript.md
 *   (SDKMessage, SDKAssistantMessage, SDKPartialAssistantMessage, Tool Input/Output types)
 *
 * Conversion logic reference:
 *   MANUS-API/KNOWLEDGE/claude-code-acp/src/tools.ts
 *   (toolInfoFromToolUse, toolUpdateFromToolResult)
 *
 * ACP output schema:
 *   MANUS-API/KNOWLEDGE/acp-typescript-sdk/src/schema/types.gen.ts
 */

/**
 * Create a Claude parser instance with its own isolated cache.
 * Each Evolve instance should create its own parser for proper isolation.
 */
declare function createClaudeParser(): (jsonLine: string) => OutputEvent[] | null;

/**
 * Codex JSONL → ACP-style events parser.
 *
 * Native schema: codex-rs/exec/src/exec_events.rs
 *   - ThreadEvent: thread.started, turn.started, turn.completed, item.started, item.updated, item.completed
 *   - ThreadItemDetails: AgentMessage, Reasoning, CommandExecution, FileChange, McpToolCall, WebSearch, TodoList, Error
 *
 * ACP output: acp-typescript-sdk/src/schema/types.gen.ts
 *   - SessionUpdate: agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update, plan
 *
 * Event mapping:
 *   reasoning         → agent_thought_chunk  (exec_events.rs:134 ReasoningItem { text })
 *   agent_message     → agent_message_chunk  (exec_events.rs:129 AgentMessageItem { text })
 *   mcp_tool_call     → tool_call/update     (exec_events.rs:215 McpToolCallItem)
 *   command_execution → tool_call/update     (exec_events.rs:151 CommandExecutionItem)
 *   file_change       → tool_call            (exec_events.rs:176 FileChangeItem)
 *   todo_list         → plan                 (exec_events.rs:245 TodoListItem { items: TodoItem[] })
 *   web_search        → tool_call            (exec_events.rs:227 WebSearchItem { query })
 */

/**
 * Create a Codex parser instance.
 */
declare function createCodexParser(): (jsonLine: string) => OutputEvent[] | null;

/**
 * Gemini JSONL → ACP-style events parser.
 *
 * Native schema (gemini --output-format stream-json):
 *   gemini-cli/packages/core/src/output/types.ts
 *
 * Gemini events (types.ts:29-36 JsonStreamEventType):
 * - "init"        → types.ts:43-47 InitEvent { session_id, model }
 * - "message"     → types.ts:49-54 MessageEvent { role, content, delta? }
 * - "tool_use"    → types.ts:56-61 ToolUseEvent { tool_name, tool_id, parameters }
 * - "tool_result" → types.ts:63-72 ToolResultEvent { tool_id, status, output?, error? }
 * - "error"       → types.ts:74-78 ErrorEvent { severity, message }
 * - "result"      → types.ts:91-99 ResultEvent { status, error?, stats? }
 *
 * ACP output: acp-typescript-sdk/src/schema/types.gen.ts:2449-2464
 */

/**
 * Create a Gemini parser instance.
 */
declare function createGeminiParser(): (jsonLine: string) => OutputEvent[] | null;

/**
 * Qwen NDJSON → ACP-style events parser.
 *
 * Native schema: KNOWLEDGE/qwen-code/packages/sdk-typescript/src/types/protocol.ts
 * ACP schema: KNOWLEDGE/acp-typescript-sdk/src/schema/types.gen.ts
 *
 * Qwen NDJSON message types (protocol.ts:428-433):
 * - type: "assistant"    → SDKAssistantMessage (protocol.ts:102-108)
 * - type: "stream_event" → SDKPartialAssistantMessage (protocol.ts:225-231)
 * - type: "user"         → SDKUserMessage (protocol.ts:93-100)
 * - type: "system"       → SDKSystemMessage (skipped)
 * - type: "result"       → SDKResultMessage (skipped)
 *
 * ContentBlock types (protocol.ts:72-76):
 * - TextBlock (protocol.ts:43-48): { type: 'text', text: string }
 * - ThinkingBlock (protocol.ts:49-54): { type: 'thinking', thinking: string }
 * - ToolUseBlock (protocol.ts:56-62): { type: 'tool_use', id, name, input }
 * - ToolResultBlock (protocol.ts:64-70): { type: 'tool_result', tool_use_id, content?, is_error? }
 *
 * StreamEvent types (protocol.ts:218-223):
 * - message_start, content_block_start, content_block_delta, content_block_stop, message_stop
 */

/**
 * Stateless parser function (creates new parser per call).
 * Use createQwenParser() for stateful streaming parsing.
 *
 * @param line - Single line of NDJSON from qwen CLI
 * @returns Array of OutputEvent objects, or null if line couldn't be parsed
 */
declare function parseQwenOutput(line: string): OutputEvent[] | null;

/**
 * Unified Parser Entry Point
 *
 * Routes NDJSON lines to the appropriate agent-specific parser.
 * Simple line-based parsing - no buffering needed since CLIs output complete JSON per line.
 */

/** Parser function type */
type AgentParser = (jsonLine: string) => OutputEvent[] | null;
/**
 * Create a parser instance for the given agent type.
 * Each Evolve instance should create its own parser for proper isolation.
 *
 * @param agentType - The agent type to create a parser for
 * @returns Parser function that takes NDJSON lines and returns OutputEvents
 */
declare function createAgentParser(agentType: AgentType): AgentParser;
/**
 * Parse a single NDJSON line from any agent (creates new parser per call - use createAgentParser for efficiency)
 *
 * @param agentType - The agent type to parse for
 * @param line - Single line of NDJSON output
 * @returns Array of OutputEvent objects, or null if line couldn't be parsed
 */
declare function parseNdjsonLine(agentType: AgentType, line: string): OutputEvent[] | null;
/**
 * Parse multiple NDJSON lines (convenience wrapper)
 *
 * @param agentType - The agent type to parse for
 * @param output - Multi-line NDJSON output
 * @returns Array of all parsed OutputEvent objects
 */
declare function parseNdjsonOutput(agentType: AgentType, output: string): OutputEvent[];

/**
 * Evolve events
 *
 * Runtime streams:
 * - stdout: Raw NDJSON lines
 * - stderr: Process stderr
 * - content: Parsed OutputEvent
 * - lifecycle: Sandbox/agent lifecycle transitions
 */
interface EvolveEvents {
    stdout: (chunk: string) => void;
    stderr: (chunk: string) => void;
    content: (event: OutputEvent) => void;
    lifecycle: (event: LifecycleEvent) => void;
}
interface EvolveConfig {
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
    sessionTagPrefix?: string;
    /** Observability metadata for trace grouping (generic key-value, domain-agnostic) */
    observability?: Record<string, unknown>;
    /** Composio user ID and config */
    composio?: ComposioSetup;
    /** Storage configuration for checkpointing */
    storage?: StorageConfig;
}
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
declare class Evolve extends EventEmitter {
    private config;
    private agent?;
    private fallbackSandboxState;
    private fallbackAgentState;
    private fallbackHasRun;
    constructor();
    on<K extends keyof EvolveEvents>(event: K, listener: EvolveEvents[K]): this;
    off<K extends keyof EvolveEvents>(event: K, listener: EvolveEvents[K]): this;
    emit<K extends keyof EvolveEvents>(event: K, ...args: Parameters<EvolveEvents[K]>): boolean;
    /**
     * Configure agent type and API key.
     * If config is undefined, Evolve resolves agent from env.
     */
    withAgent(config?: AgentConfig): this;
    /**
     * Configure sandbox provider
     */
    withSandbox(provider?: SandboxProvider): this;
    /**
     * Set working directory path
     */
    withWorkingDirectory(path: string): this;
    /**
     * Set workspace mode
     * - "knowledge": Creates context/, scripts/, temp/, output/ folders
     * - "swe": Same as knowledge + repo/ folder for code repositories
     */
    withWorkspaceMode(mode: WorkspaceMode): this;
    /**
     * Add environment secrets
     */
    withSecrets(secrets: Record<string, string>): this;
    /**
     * Connect to existing session
     */
    withSession(sandboxId: string): this;
    /**
     * Set custom system prompt
     */
    withSystemPrompt(prompt: string): this;
    /**
     * Add context files (uploaded to context/ folder)
     */
    withContext(files: FileMap): this;
    /**
     * Add workspace files (uploaded to working directory)
     */
    withFiles(files: FileMap): this;
    /**
     * Configure MCP servers
     */
    withMcpServers(servers: Record<string, McpServerConfig>): this;
    /**
     * Enable skills for the agent
     *
     * Skills are specialized capabilities that extend the agent's functionality.
     * Available skills: "pdf", "dev-browser"
     *
     * @example
     * kit.withSkills(["pdf", "dev-browser"])
     */
    withSkills(skills: SkillName[]): this;
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
    withSchema<T>(schema: z.ZodType<T> | JsonSchema, options?: SchemaValidationOptions): this;
    /**
     * Set session tag prefix for observability
     */
    withSessionTagPrefix(prefix: string): this;
    /**
     * @internal Set observability metadata for trace grouping.
     * Used internally by Swarm - not part of public API.
     */
    withObservability(meta: Record<string, unknown>): this;
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
    withComposio(userId: string, config?: ComposioConfig): this;
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
    withStorage(config?: StorageConfig): this;
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
    static composio: {
        auth: typeof getAuthUrl;
        status: typeof getStatus;
        connections: typeof getConnections;
    };
    /**
     * Initialize agent on first use
     */
    private initializeAgent;
    /**
     * Create stream callbacks based on registered listeners
     */
    private createStreamCallbacks;
    private emitLifecycleFromStatus;
    /**
     * Run agent with prompt
     *
     * @param from - Restore from checkpoint ID before running (requires .withStorage())
     */
    run({ prompt, timeoutMs, background, from, checkpointComment, }: {
        prompt: string;
        timeoutMs?: number;
        background?: boolean;
        from?: string;
        checkpointComment?: string;
    }): Promise<AgentResponse>;
    /**
     * Execute arbitrary command in sandbox
     */
    executeCommand(command: string, options?: {
        timeoutMs?: number;
        background?: boolean;
    }): Promise<AgentResponse>;
    /**
     * Interrupt active process without killing sandbox.
     */
    interrupt(): Promise<boolean>;
    /**
     * Upload context files (runtime - immediate upload)
     */
    uploadContext(files: FileMap): Promise<void>;
    /**
     * Upload files to workspace (runtime - immediate upload)
     */
    uploadFiles(files: FileMap): Promise<void>;
    /**
     * Get output files from output/ folder with optional schema validation
     *
     * @param recursive - Include files in subdirectories (default: false)
     */
    getOutputFiles<T = unknown>(recursive?: boolean): Promise<OutputResult<T>>;
    /**
     * Create an explicit checkpoint of the current sandbox state.
     *
     * Requires a prior run() call (needs an active sandbox to snapshot).
     *
     * @param options.comment - Optional label for this checkpoint
     */
    checkpoint(options?: {
        comment?: string;
    }): Promise<CheckpointInfo>;
    private _cachedGatewayOverrides;
    /**
     * Resolve gateway credentials from agent config for storage operations.
     * Memoized — agent config is immutable after .withAgent().
     */
    private resolveGatewayOverrides;
    /**
     * List checkpoints (requires .withStorage()).
     *
     * Does not require an agent or sandbox — only storage configuration.
     *
     * @param options.limit - Maximum number of checkpoints to return
     * @param options.tag - Filter by session tag (gateway mode: server-side, BYOK: post-filter)
     */
    listCheckpoints(options?: {
        limit?: number;
        tag?: string;
    }): Promise<CheckpointInfo[]>;
    /**
     * Get a StorageClient bound to this instance's storage configuration.
     * Same API surface as the standalone storage() factory.
     */
    storage(): StorageClient;
    /**
     * Get current session (sandbox ID)
     */
    getSession(): string | null;
    /**
     * Set session to connect to
     */
    setSession(sandboxId: string): Promise<void>;
    /**
     * Get runtime status for sandbox and agent.
     */
    status(): SessionStatus;
    /**
     * Pause sandbox
     */
    pause(): Promise<void>;
    /**
     * Resume sandbox
     */
    resume(): Promise<void>;
    /**
     * Kill sandbox
     */
    kill(): Promise<void>;
    /**
     * Get host URL for a port
     */
    getHost(port: number): Promise<string>;
    /**
     * Get session tag (for observability)
     *
     * Returns null if no session has started (run() not called yet).
     */
    getSessionTag(): string | null;
    /**
     * Get session timestamp (for observability)
     *
     * Returns null if no session has started (run() not called yet).
     */
    getSessionTimestamp(): string | null;
    /**
     * Flush pending observability events without killing sandbox.
     */
    flushObservability(): Promise<void>;
}

/**
 * Retry Utility
 *
 * Generic retry with exponential backoff for Swarm operations.
 * Works with any result type that has a status field.
 * Retries on error status by default, with customizable retry conditions.
 */
/** Any result with a status field (SwarmResult, ReduceResult, etc.) */
interface RetryableResult {
    status: "success" | "error" | "filtered";
    error?: string;
}
/**
 * Per-item retry configuration.
 *
 * @example
 * ```typescript
 * // Basic retry on error
 * { maxAttempts: 3 }
 *
 * // With exponential backoff
 * { maxAttempts: 3, backoffMs: 1000, backoffMultiplier: 2 }
 *
 * // Custom retry condition (when using typed RetryConfig<SwarmResult<T>>)
 * { maxAttempts: 3, retryOn: (r) => r.status === "error" || r.error?.includes("timeout") }
 *
 * // With retry callback for observability
 * { maxAttempts: 3, onItemRetry: (idx, attempt, error) => console.log(`Item ${idx} retry ${attempt}: ${error}`) }
 * ```
 */
interface RetryConfig<TResult extends RetryableResult = RetryableResult> {
    /** Maximum retry attempts (default: 3) */
    maxAttempts?: number;
    /** Initial backoff in ms (default: 1000) */
    backoffMs?: number;
    /** Exponential backoff multiplier (default: 2) */
    backoffMultiplier?: number;
    /** Custom retry condition (default: status === "error") */
    retryOn?: (result: TResult) => boolean;
    /** Callback invoked before each item retry attempt */
    onItemRetry?: OnItemRetryCallback;
}
/** Callback for item retry events */
type OnItemRetryCallback = (itemIndex: number, attempt: number, error: string) => void;
/**
 * Execute a function with retry and exponential backoff.
 *
 * Works with any result type that has a `status` field (SwarmResult, ReduceResult, etc.).
 *
 * @param fn - Function that receives attempt number (1-based) and returns a result
 * @param config - Retry configuration (includes optional onRetry callback)
 * @param itemIndex - Item index for callback (default: 0, used for reduce)
 * @returns Result from the function
 *
 * @example
 * ```typescript
 * const result = await executeWithRetry(
 *   (attempt) => this.executeMapItem(item, prompt, index, operationId, params, timeout, attempt),
 *   { maxAttempts: 3, backoffMs: 1000, onItemRetry: (idx, attempt, error) => console.log(`Item ${idx} retry ${attempt}: ${error}`) },
 *   index
 * );
 * ```
 */
declare function executeWithRetry<TResult extends RetryableResult>(fn: (attempt: number) => Promise<TResult>, config?: RetryConfig<TResult>, itemIndex?: number): Promise<TResult>;

/**
 * Swarm Abstractions - Type Definitions
 *
 * Functional programming for AI agents.
 * map, filter, reduce, bestOf - with AI reasoning.
 */

declare const SWARM_RESULT_BRAND: unique symbol;
/** Agent override for method options (apiKey inherited from Swarm instance) */
interface AgentOverride {
    type: AgentType;
    model?: string;
    reasoningEffort?: ReasoningEffort;
}
interface SwarmConfig {
    /** Default agent for all operations (defaults to env resolution) */
    agent?: AgentConfig;
    /** Sandbox provider (defaults to E2B via E2B_API_KEY env var) */
    sandbox?: SandboxProvider;
    /** User prefix for worker tags */
    tag?: string;
    /** Max parallel sandboxes globally (default: 4) */
    concurrency?: number;
    /** Per-worker timeout in ms (default: 1 hour) */
    timeoutMs?: number;
    /** Workspace mode (default: SDK default 'knowledge') */
    workspaceMode?: WorkspaceMode;
    /** Default retry configuration for all operations (per-operation config takes precedence) */
    retry?: RetryConfig;
    /** Default MCP servers for all operations (per-operation config takes precedence) */
    mcpServers?: Record<string, McpServerConfig>;
    /** Default skills for all operations (per-operation config takes precedence) */
    skills?: SkillName[];
    /** Default Composio configuration for all operations (per-operation config takes precedence) */
    composio?: ComposioSetup;
}
/** Callback for bestOf candidate completion */
type OnCandidateCompleteCallback = (itemIndex: number, candidateIndex: number, status: "success" | "error") => void;
/** Callback for bestOf judge completion */
type OnJudgeCompleteCallback = (itemIndex: number, winnerIndex: number, reasoning: string) => void;
interface BestOfConfig {
    /** Number of candidates (>= 2). Required if taskAgents omitted, else inferred from taskAgents.length */
    n?: number;
    /** Evaluation criteria for judge */
    judgeCriteria: string;
    /** Optional: agents for each candidate. If provided, n defaults to taskAgents.length */
    taskAgents?: AgentOverride[];
    /** Optional: override agent for judge */
    judgeAgent?: AgentOverride;
    /** MCP servers for candidates (defaults to operation mcpServers) */
    mcpServers?: Record<string, McpServerConfig>;
    /** MCP servers for judge (defaults to mcpServers) */
    judgeMcpServers?: Record<string, McpServerConfig>;
    /** Skills for candidates (defaults to operation skills) */
    skills?: SkillName[];
    /** Skills for judge (defaults to skills) */
    judgeSkills?: SkillName[];
    /** Composio config for candidates (defaults to operation composio) */
    composio?: ComposioSetup;
    /** Composio config for judge (defaults to composio) */
    judgeComposio?: ComposioSetup;
    /** Callback when a candidate completes */
    onCandidateComplete?: OnCandidateCompleteCallback;
    /** Callback when judge completes */
    onJudgeComplete?: OnJudgeCompleteCallback;
}
/** Callback for verify worker completion (before verification runs) */
type OnWorkerCompleteCallback = (itemIndex: number, attempt: number, status: "success" | "error") => void;
/** Callback for verifier completion */
type OnVerifierCompleteCallback = (itemIndex: number, attempt: number, passed: boolean, feedback?: string) => void;
interface VerifyConfig {
    /** Verification criteria - what the output must satisfy */
    criteria: string;
    /** Maximum attempts with feedback (default: 3). Includes initial attempt. */
    maxAttempts?: number;
    /** Optional: override agent for verifier */
    verifierAgent?: AgentOverride;
    /** MCP servers for verifier (defaults to operation mcpServers) */
    verifierMcpServers?: Record<string, McpServerConfig>;
    /** Skills for verifier (defaults to operation skills) */
    verifierSkills?: SkillName[];
    /** Composio config for verifier (defaults to operation composio) */
    verifierComposio?: ComposioSetup;
    /** Callback invoked after each worker completion (before verification) */
    onWorkerComplete?: OnWorkerCompleteCallback;
    /** Callback invoked after each verifier completion */
    onVerifierComplete?: OnVerifierCompleteCallback;
}
type OperationType = "map" | "filter" | "reduce" | "bestof-cand" | "bestof-judge" | "verify";
interface BaseMeta {
    /** Unique identifier for this operation (map/filter/reduce/bestOf call) */
    operationId: string;
    operation: OperationType;
    tag: string;
    sandboxId: string;
    /** Swarm name (from Swarm.config.tag) - identifies the swarm instance */
    swarmName?: string;
    /** Operation name (from params.name) - user-defined label for this operation */
    operationName?: string;
    /** Error retry number (1, 2, 3...) - only present when retrying after error */
    errorRetry?: number;
    /** Verify retry number (1, 2, 3...) - only present when retrying after verify failure */
    verifyRetry?: number;
    /** Candidate index (0, 1, 2...) - only present for bestOf candidates */
    candidateIndex?: number;
    /** Pipeline run identifier - only present when run via Pipeline */
    pipelineRunId?: string;
    /** Pipeline step index - only present when run via Pipeline */
    pipelineStepIndex?: number;
}
interface IndexedMeta extends BaseMeta {
    /** Item index in the batch (0, 1, 2...) */
    itemIndex: number;
}
interface ReduceMeta extends BaseMeta {
    inputCount: number;
    inputIndices: number[];
}
interface JudgeMeta extends BaseMeta {
    candidateCount: number;
}
interface VerifyMeta extends BaseMeta {
    /** Total verification attempts made */
    attempts: number;
}
/**
 * Result from a single worker (map, filter, bestof candidate).
 *
 * Status meanings:
 * - "success": Positive outcome (agent succeeded / condition passed)
 * - "filtered": Neutral outcome (evaluated but didn't pass condition) - filter only
 * - "error": Negative outcome (agent error)
 *
 * @typeParam T - Data type. Defaults to FileMap when no schema provided.
 */
interface SwarmResult<T = FileMap> {
    readonly [SWARM_RESULT_BRAND]: true;
    status: "success" | "filtered" | "error";
    /** Parsed result.json if schema provided, else FileMap. Null if failed. */
    data: T | null;
    /** Output files (map/bestof) or original input files (filter) */
    files: FileMap;
    meta: IndexedMeta;
    error?: string;
    /** Raw result.json string when parse or validation failed (for debugging) */
    rawData?: string;
    /** Present when map used bestOf option. Matches BestOfResult structure (minus winner). */
    bestOf?: {
        winnerIndex: number;
        judgeReasoning: string;
        judgeMeta: JudgeMeta;
        candidates: SwarmResult<T>[];
    };
    /** Present when verify option was used. Contains verification outcome. */
    verify?: VerifyInfo;
}
/**
 * List of SwarmResults with helper properties.
 * Extends Array so all normal array operations work.
 *
 * Getters:
 * - `.success` - items with positive outcome
 * - `.filtered` - items that didn't pass condition (filter only)
 * - `.error` - items that encountered errors
 *
 * Chaining examples:
 * - `swarm.reduce(results.success, ...)` - forward only successful
 * - `swarm.reduce([...results.success, ...results.filtered], ...)` - forward all evaluated
 */
declare class SwarmResultList<T = FileMap> extends Array<SwarmResult<T>> {
    /** Returns items with status "success" */
    get success(): SwarmResult<T>[];
    /** Returns items with status "filtered" (didn't pass condition) */
    get filtered(): SwarmResult<T>[];
    /** Returns items with status "error" */
    get error(): SwarmResult<T>[];
    static from<T>(results: SwarmResult<T>[]): SwarmResultList<T>;
}
/**
 * Result from reduce operation.
 *
 * @typeParam T - Data type. Defaults to FileMap when no schema provided.
 */
interface ReduceResult<T = FileMap> {
    status: "success" | "error";
    data: T | null;
    files: FileMap;
    meta: ReduceMeta;
    error?: string;
    /** Raw result.json string when parse or validation failed (for debugging) */
    rawData?: string;
    /** Present when verify option was used. Contains verification outcome. */
    verify?: VerifyInfo;
}
/**
 * Result from bestOf operation.
 *
 * @typeParam T - Data type for candidates.
 */
interface BestOfResult<T = FileMap> {
    winner: SwarmResult<T>;
    winnerIndex: number;
    judgeReasoning: string;
    judgeMeta: JudgeMeta;
    candidates: SwarmResult<T>[];
}
/** Fixed schema for bestOf judge output */
interface JudgeDecision {
    winner: number;
    reasoning: string;
}
/** Fixed schema for verify output */
interface VerifyDecision {
    passed: boolean;
    reasoning: string;
    feedback?: string;
}
/** Verification info attached to results when verify option used */
interface VerifyInfo {
    passed: boolean;
    reasoning: string;
    verifyMeta: VerifyMeta;
    attempts: number;
}
type ItemInput = FileMap | SwarmResult<unknown>;
type PromptFn = (files: FileMap, index: number) => string;
type Prompt = string | PromptFn;
/** @internal Pipeline context for observability (set by Pipeline, not user) */
interface PipelineContext {
    pipelineRunId: string;
    pipelineStepIndex: number;
}
/** Parameters for map operation */
interface MapParams<T> {
    /** Items to process (FileMaps or SwarmResults from previous operation) */
    items: ItemInput[];
    /** Task prompt (string or function(files, index) -> string) */
    prompt: Prompt;
    /** Optional operation name for observability */
    name?: string;
    /** Optional system prompt */
    systemPrompt?: string;
    /** @internal Pipeline context (set by Pipeline, not user) */
    _pipelineContext?: PipelineContext;
    /** Schema for structured output (Zod or JSON Schema) */
    schema?: z.ZodType<T> | JsonSchema;
    /** Validation options for JSON Schema (ignored for Zod) */
    schemaOptions?: SchemaValidationOptions;
    /** Optional agent override */
    agent?: AgentOverride;
    /** MCP servers override (replaces swarm default) */
    mcpServers?: Record<string, McpServerConfig>;
    /** Skills override (replaces swarm default) */
    skills?: SkillName[];
    /** Composio override (replaces swarm default) */
    composio?: ComposioSetup;
    /** Optional bestOf configuration for N candidates + judge (mutually exclusive with verify) */
    bestOf?: BestOfConfig;
    /** Optional verify configuration for LLM-as-judge quality verification with retry (mutually exclusive with bestOf) */
    verify?: VerifyConfig;
    /** Per-item retry configuration. Typed to allow retryOn access to SwarmResult fields. */
    retry?: RetryConfig<SwarmResult<T>>;
    /** Optional timeout in ms */
    timeoutMs?: number;
}
/** Parameters for filter operation */
interface FilterParams<T> {
    /** Items to filter (FileMaps or SwarmResults from previous operation) */
    items: ItemInput[];
    /** Evaluation prompt - describe what to assess and how (agent outputs result.json) */
    prompt: string;
    /** Optional operation name for observability */
    name?: string;
    /** @internal Pipeline context (set by Pipeline, not user) */
    _pipelineContext?: PipelineContext;
    /** Schema for structured output (Zod or JSON Schema) */
    schema: z.ZodType<T> | JsonSchema;
    /** Validation options for JSON Schema (ignored for Zod) */
    schemaOptions?: SchemaValidationOptions;
    /** Local condition function to determine pass/fail */
    condition: (data: T) => boolean;
    /** Optional system prompt */
    systemPrompt?: string;
    /** Optional agent override */
    agent?: AgentOverride;
    /** MCP servers override (replaces swarm default) */
    mcpServers?: Record<string, McpServerConfig>;
    /** Skills override (replaces swarm default) */
    skills?: SkillName[];
    /** Composio override (replaces swarm default) */
    composio?: ComposioSetup;
    /** Optional verify configuration for LLM-as-judge quality verification with retry */
    verify?: VerifyConfig;
    /** Per-item retry configuration. Typed to allow retryOn access to SwarmResult fields. */
    retry?: RetryConfig<SwarmResult<T>>;
    /** Optional timeout in ms */
    timeoutMs?: number;
}
/** Parameters for reduce operation */
interface ReduceParams<T> {
    /** Items to reduce (FileMaps or SwarmResults from previous operation) */
    items: ItemInput[];
    /** Synthesis prompt */
    prompt: string;
    /** Optional operation name for observability */
    name?: string;
    /** Optional system prompt */
    systemPrompt?: string;
    /** @internal Pipeline context (set by Pipeline, not user) */
    _pipelineContext?: PipelineContext;
    /** Schema for structured output (Zod or JSON Schema) */
    schema?: z.ZodType<T> | JsonSchema;
    /** Validation options for JSON Schema (ignored for Zod) */
    schemaOptions?: SchemaValidationOptions;
    /** Optional agent override */
    agent?: AgentOverride;
    /** MCP servers override (replaces swarm default) */
    mcpServers?: Record<string, McpServerConfig>;
    /** Skills override (replaces swarm default) */
    skills?: SkillName[];
    /** Composio override (replaces swarm default) */
    composio?: ComposioSetup;
    /** Optional verify configuration for LLM-as-judge quality verification with retry */
    verify?: VerifyConfig;
    /** Retry configuration (retries entire reduce on error). Typed to allow retryOn access to ReduceResult fields. */
    retry?: RetryConfig<ReduceResult<T>>;
    /** Optional timeout in ms */
    timeoutMs?: number;
}
/** Parameters for bestOf operation */
interface BestOfParams<T> {
    /** Single item to process */
    item: ItemInput;
    /** Task prompt */
    prompt: string;
    /** Optional operation name for observability */
    name?: string;
    /** BestOf configuration (n, judgeCriteria, taskAgents, judgeAgent, mcpServers, skills, composio) */
    config: BestOfConfig;
    /** Optional system prompt */
    systemPrompt?: string;
    /** Schema for structured output (Zod or JSON Schema) */
    schema?: z.ZodType<T> | JsonSchema;
    /** Validation options for JSON Schema (ignored for Zod) */
    schemaOptions?: SchemaValidationOptions;
    /**
     * Per-candidate retry configuration. Typed to allow retryOn access to SwarmResult fields.
     * Note: Judge always uses default retryOn (status === "error"), ignoring custom retryOn.
     */
    retry?: RetryConfig<SwarmResult<T>>;
    /** Optional timeout in ms */
    timeoutMs?: number;
}

/**
 * Simple semaphore for global concurrency control.
 *
 * Ensures no more than N sandboxes run concurrently across all swarm operations.
 */
declare class Semaphore {
    private permits;
    private queue;
    constructor(max: number);
    /**
     * Execute a function under the semaphore.
     * Acquires a permit before running, releases after completion.
     */
    use<T>(fn: () => Promise<T>): Promise<T>;
    private acquire;
    private release;
}

/**
 * Swarm Abstractions
 *
 * Functional programming for AI agents.
 *
 * @example
 * ```typescript
 * const swarm = new Swarm({
 *   agent: { type: "claude", apiKey: "..." },
 *   sandbox: createE2BProvider({ apiKey: "..." }),
 * });
 *
 * const analyses = await swarm.map({
 *   items: documents,
 *   prompt: "Analyze this",
 * });
 *
 * const evaluated = await swarm.filter({
 *   items: analyses,
 *   prompt: "Evaluate severity",
 *   schema: SeveritySchema,
 *   condition: r => r.severity === "critical",
 * });
 * // evaluated.success = passed condition
 * // evaluated.filtered = didn't pass condition
 * // evaluated.error = agent errors
 *
 * const report = await swarm.reduce({
 *   items: evaluated.success,
 *   prompt: "Create summary",
 * });
 * ```
 */

declare class Swarm {
    private config;
    private semaphore;
    constructor(config?: SwarmConfig);
    /**
     * Apply an agent to each item in parallel.
     */
    map<T = FileMap>(params: MapParams<T>): Promise<SwarmResultList<T>>;
    /**
     * Two-step evaluation: agent assesses each item, then local condition applies threshold.
     *
     * 1. Agent sees context files, evaluates per prompt, outputs result.json matching schema
     * 2. Condition function receives parsed data, returns true (success) or false (filtered)
     *
     * Returns ALL items with status:
     * - "success": passed condition
     * - "filtered": evaluated but didn't pass condition
     * - "error": agent error
     *
     * Use `.success` for passing items, `.filtered` for non-passing.
     */
    filter<T>(params: FilterParams<T>): Promise<SwarmResultList<T>>;
    /**
     * Synthesize many items into one.
     */
    reduce<T = FileMap>(params: ReduceParams<T>): Promise<ReduceResult<T>>;
    /**
     * Run N candidates on the same task, judge picks the best.
     */
    bestOf<T = FileMap>(params: BestOfParams<T>): Promise<BestOfResult<T>>;
    private execute;
    private executeMapItem;
    private executeMapItemWithVerify;
    private executeMapItemWithBestOf;
    private executeFilterItem;
    private executeFilterItemWithVerify;
    /**
     * Execute a single bestOf candidate.
     * Used by both standalone bestOf() and map() with bestOf option.
     */
    private executeBestOfCandidate;
    /**
     * Build judge context containing worker task info and candidate outputs.
     */
    private buildJudgeContext;
    /**
     * Execute judge to pick best candidate.
     * Returns RetryableResult-compatible type for use with executeWithRetry.
     */
    private executeBestOfJudge;
    private static readonly DEFAULT_VERIFY_MAX_ATTEMPTS;
    private static readonly VerifyDecisionSchema;
    /**
     * Build verify context containing worker task info and output to verify.
     */
    private buildVerifyContext;
    /**
     * Execute verifier to check if output meets criteria.
     */
    private executeVerify;
    /**
     * Build a retry prompt with verifier feedback.
     */
    private static buildRetryPromptWithFeedback;
    /**
     * Shared verification loop for map, filter, and reduce.
     * Runs worker function, verifies output, retries with feedback if needed.
     *
     * @param workerFn - Function that executes the worker with a given prompt, tag prefix, and attempt index
     * @param params - Common verification parameters
     * @returns Result with verify info attached
     */
    private runWithVerification;
    private generateOperationId;
    /** Convert pipeline context to observability fields */
    private pipelineContextToObservability;
    /** Extract pipeline tracking fields for meta objects */
    private pipelineContextToMeta;
    /**
     * Safely evaluate prompt (string or function).
     * Returns evaluated string or Error if function threw.
     */
    private evaluatePrompt;
    /**
     * Build evaluator context (shared by judge and verify).
     * Creates worker_task/ structure with input files, prompts, schema.
     */
    private buildEvaluatorContext;
    private isSwarmResult;
    private getFiles;
    private getIndex;
    private buildResult;
    private buildErrorResult;
}

/**
 * Pipeline Types
 *
 * Fluent API for chaining Swarm operations.
 */

/**
 * What filter emits to the next step.
 *
 * - "success": Items that passed condition (default)
 * - "filtered": Items that failed condition
 * - "all": Both success and filtered
 */
type EmitOption = "success" | "filtered" | "all";
/** Base fields shared by all step types */
interface BaseStepConfig {
    /** Step name for observability (appears in events) */
    name?: string;
    /** System prompt override */
    systemPrompt?: string;
    /** Agent override */
    agent?: AgentOverride;
    /** MCP servers override (replaces swarm default for this step) */
    mcpServers?: Record<string, McpServerConfig>;
    /** Skills override (replaces swarm default for this step) */
    skills?: SkillName[];
    /** Composio override (replaces swarm default for this step) */
    composio?: ComposioSetup;
    /** Timeout in ms */
    timeoutMs?: number;
}
/** Map step configuration */
interface MapConfig<T> extends BaseStepConfig {
    /** Task prompt */
    prompt: Prompt;
    /** Schema for structured output */
    schema?: z.ZodType<T> | JsonSchema;
    /** Validation options for JSON Schema */
    schemaOptions?: SchemaValidationOptions;
    /** BestOf configuration (mutually exclusive with verify) */
    bestOf?: BestOfConfig;
    /** Verify configuration (mutually exclusive with bestOf) */
    verify?: VerifyConfig;
    /** Retry configuration */
    retry?: RetryConfig<SwarmResult<T>>;
}
/** Filter step configuration */
interface FilterConfig<T> extends BaseStepConfig {
    /** Evaluation prompt */
    prompt: string;
    /** Schema for structured output (required) */
    schema: z.ZodType<T> | JsonSchema;
    /** Validation options for JSON Schema */
    schemaOptions?: SchemaValidationOptions;
    /** Condition function to determine pass/fail */
    condition: (data: T) => boolean;
    /** What to emit to next step (default: "success") */
    emit?: EmitOption;
    /** Verify configuration */
    verify?: VerifyConfig;
    /** Retry configuration */
    retry?: RetryConfig<SwarmResult<T>>;
}
/** Reduce step configuration */
interface ReduceConfig<T> extends BaseStepConfig {
    /** Synthesis prompt */
    prompt: string;
    /** Schema for structured output */
    schema?: z.ZodType<T> | JsonSchema;
    /** Validation options for JSON Schema */
    schemaOptions?: SchemaValidationOptions;
    /** Verify configuration */
    verify?: VerifyConfig;
    /** Retry configuration */
    retry?: RetryConfig<ReduceResult<T>>;
}
/** @internal Step representation */
type Step = {
    type: "map";
    config: MapConfig<unknown>;
} | {
    type: "filter";
    config: FilterConfig<unknown>;
} | {
    type: "reduce";
    config: ReduceConfig<unknown>;
};
/** @internal Step type literal */
type StepType = "map" | "filter" | "reduce";
/** Result of a single pipeline step */
interface StepResult<T = unknown> {
    type: StepType;
    index: number;
    durationMs: number;
    results: SwarmResult<T>[] | ReduceResult<T>;
}
/** Final result from pipeline execution */
interface PipelineResult<T = unknown> {
    /** Unique identifier for this pipeline run */
    pipelineRunId: string;
    steps: StepResult<unknown>[];
    output: SwarmResult<T>[] | ReduceResult<T>;
    totalDurationMs: number;
}
/** Step lifecycle event */
interface StepEvent {
    type: StepType;
    index: number;
    name?: string;
}
/** Emitted when step starts */
interface StepStartEvent extends StepEvent {
    itemCount: number;
}
/** Emitted when step completes */
interface StepCompleteEvent extends StepEvent {
    durationMs: number;
    successCount: number;
    errorCount: number;
    filteredCount: number;
}
/** Emitted when step errors */
interface StepErrorEvent extends StepEvent {
    error: Error;
}
/** Emitted on item retry */
interface ItemRetryEvent {
    stepIndex: number;
    stepName?: string;
    itemIndex: number;
    attempt: number;
    error: string;
}
/** Emitted when verify worker completes */
interface WorkerCompleteEvent {
    stepIndex: number;
    stepName?: string;
    itemIndex: number;
    attempt: number;
    status: "success" | "error";
}
/** Emitted when verifier completes */
interface VerifierCompleteEvent {
    stepIndex: number;
    stepName?: string;
    itemIndex: number;
    attempt: number;
    passed: boolean;
    feedback?: string;
}
/** Emitted when bestOf candidate completes */
interface CandidateCompleteEvent {
    stepIndex: number;
    stepName?: string;
    itemIndex: number;
    candidateIndex: number;
    status: "success" | "error";
}
/** Emitted when bestOf judge completes */
interface JudgeCompleteEvent {
    stepIndex: number;
    stepName?: string;
    itemIndex: number;
    winnerIndex: number;
    reasoning: string;
}
/** Event handlers */
interface PipelineEvents {
    onStepStart?: (event: StepStartEvent) => void;
    onStepComplete?: (event: StepCompleteEvent) => void;
    onStepError?: (event: StepErrorEvent) => void;
    onItemRetry?: (event: ItemRetryEvent) => void;
    onWorkerComplete?: (event: WorkerCompleteEvent) => void;
    onVerifierComplete?: (event: VerifierCompleteEvent) => void;
    onCandidateComplete?: (event: CandidateCompleteEvent) => void;
    onJudgeComplete?: (event: JudgeCompleteEvent) => void;
}
/** Event name mapping for chainable .on() */
type EventName = "stepStart" | "stepComplete" | "stepError" | "itemRetry" | "workerComplete" | "verifierComplete" | "candidateComplete" | "judgeComplete";
/** Map event name to handler type */
type EventHandler<E extends EventName> = E extends "stepStart" ? (event: StepStartEvent) => void : E extends "stepComplete" ? (event: StepCompleteEvent) => void : E extends "stepError" ? (event: StepErrorEvent) => void : E extends "itemRetry" ? (event: ItemRetryEvent) => void : E extends "workerComplete" ? (event: WorkerCompleteEvent) => void : E extends "verifierComplete" ? (event: VerifierCompleteEvent) => void : E extends "candidateComplete" ? (event: CandidateCompleteEvent) => void : E extends "judgeComplete" ? (event: JudgeCompleteEvent) => void : never;
/** Event name to handler type mapping (for chainable .on() style) */
interface PipelineEventMap {
    stepStart: (event: StepStartEvent) => void;
    stepComplete: (event: StepCompleteEvent) => void;
    stepError: (event: StepErrorEvent) => void;
    itemRetry: (event: ItemRetryEvent) => void;
    workerComplete: (event: WorkerCompleteEvent) => void;
    verifierComplete: (event: VerifierCompleteEvent) => void;
    candidateComplete: (event: CandidateCompleteEvent) => void;
    judgeComplete: (event: JudgeCompleteEvent) => void;
}

/**
 * Pipeline - Fluent API for Swarm Operations
 *
 * Thin wrapper over Swarm providing method chaining, timing, and events.
 *
 * @example
 * ```typescript
 * const pipeline = new Pipeline(swarm)
 *   .map({ prompt: "Analyze..." })
 *   .filter({ prompt: "Rate...", schema, condition: d => d.score > 7 })
 *   .reduce({ prompt: "Summarize..." });
 *
 * // Run with items
 * const result = await pipeline.run(documents);
 *
 * // Reusable - run with different data
 * await pipeline.run(batch1);
 * await pipeline.run(batch2);
 * ```
 */

/**
 * Pipeline for chaining Swarm operations.
 *
 * Swarm is bound at construction (infrastructure).
 * Items are passed at execution (data).
 * Pipeline is immutable - each method returns a new instance.
 */
declare class Pipeline<T = FileMap> {
    protected readonly swarm: Swarm;
    protected readonly steps: Step[];
    protected readonly events: PipelineEvents;
    constructor(swarm: Swarm, steps?: Step[], events?: PipelineEvents);
    /** Add a map step to transform items in parallel. */
    map<U>(config: MapConfig<U>): Pipeline<U>;
    /** Add a filter step to evaluate and filter items. */
    filter<U>(config: FilterConfig<U>): Pipeline<U>;
    /** Add a reduce step (terminal - no steps can follow). */
    reduce<U>(config: ReduceConfig<U>): TerminalPipeline<U>;
    /**
     * Register event handlers for step lifecycle.
     *
     * Supports two styles:
     * - Object: `.on({ onStepComplete: fn, onItemRetry: fn })`
     * - Chainable: `.on("stepComplete", fn).on("itemRetry", fn)`
     */
    on(handlers: PipelineEvents): Pipeline<T>;
    on<K extends keyof PipelineEventMap>(event: K, handler: PipelineEventMap[K]): Pipeline<T>;
    /** Execute the pipeline with the given items. */
    run(items: ItemInput[]): Promise<PipelineResult<T>>;
    private executeStep;
    private wrapRetry;
    private wrapVerify;
    private wrapBestOf;
}
/** Pipeline after reduce - no more steps can be added. */
declare class TerminalPipeline<T> extends Pipeline<T> {
    constructor(swarm: Swarm, steps: Step[], events: PipelineEvents);
    /**
     * Register event handlers for step lifecycle.
     *
     * Supports two styles:
     * - Object: `.on({ onStepComplete: fn, onItemRetry: fn })`
     * - Chainable: `.on("stepComplete", fn).on("itemRetry", fn)`
     */
    on(handlers: PipelineEvents): TerminalPipeline<T>;
    on<K extends keyof PipelineEventMap>(event: K, handler: PipelineEventMap[K]): TerminalPipeline<T>;
    /** @throws Cannot add steps after reduce */
    map(): never;
    /** @throws Cannot add steps after reduce */
    filter(): never;
    /** @throws Cannot add steps after reduce */
    reduce(): never;
}

/**
 * Agent Registry
 *
 * Single source of truth for agent-specific behavior.
 * All differences between agents are data, not code.
 *
 * Evidence: sdk-rewrite-v3.md Agent Registry section
 */

/** Model configuration */
interface ModelInfo {
    /** Model alias (short name used with --model) */
    alias: string;
    /** Full model ID */
    modelId: string;
    /** What this model is best for */
    description: string;
}
/** MCP configuration for an agent */
interface McpConfigInfo {
    /** Settings directory (e.g., "~/.claude") */
    settingsDir: string;
    /** Config filename (e.g., "settings.json" or "config.toml") */
    filename: string;
    /** Config format */
    format: "json" | "toml";
    /** Whether to use workingDir for project-level config (Claude only) */
    projectConfig?: boolean;
}
/** Options for building agent commands */
interface BuildCommandOptions {
    prompt: string;
    model: string;
    isResume: boolean;
    reasoningEffort?: string;
    isDirectMode?: boolean;
    /** Skills enabled for this run */
    skills?: string[];
}
interface AgentRegistryEntry {
    /** Sandbox image/template identifier (provider maps to its own concept) */
    image: string;
    /** Environment variable name for API key */
    apiKeyEnv: string;
    /** Environment variable name for OAuth (file path or token depending on agent) */
    oauthEnv?: string;
    /** OAuth credentials filename (e.g., "auth.json" for Codex, "oauth_creds.json" for Gemini) */
    oauthFileName?: string;
    /** Environment variable to set when OAuth is active (e.g., GOOGLE_GENAI_USE_GCA=true for Gemini) */
    oauthActivationEnv?: {
        key: string;
        value: string;
    };
    /** Environment variable name for base URL */
    baseUrlEnv: string;
    /** Default model alias */
    defaultModel: string;
    /** Available models for this agent */
    models: ModelInfo[];
    /** System prompt filename (e.g., "CLAUDE.md") */
    systemPromptFile: string;
    /** MCP configuration */
    mcpConfig: McpConfigInfo;
    /** Build the CLI command for this agent */
    buildCommand: (opts: BuildCommandOptions) => string;
    /** Extra setup step (e.g., codex login) */
    setupCommand?: string;
    /** Whether this agent uses passthrough gateway (Gemini) */
    usePassthroughGateway?: boolean;
    /** Default base URL for direct mode (only needed if provider requires specific endpoint, e.g., Qwen → Dashscope) */
    defaultBaseUrl?: string;
    /** Available beta headers for this agent (for reference) */
    availableBetas?: Record<string, string>;
    /** Skills configuration for this agent */
    skillsConfig: SkillsConfig;
    /** Multi-provider env mapping: model prefix → keyEnv (for CLIs like OpenCode that resolve provider from model string) */
    providerEnvMap?: Record<string, {
        keyEnv: string;
    }>;
    /** Env var for inline config (e.g., OPENCODE_CONFIG_CONTENT) — used in gateway mode to set provider base URLs */
    gatewayConfigEnv?: string;
    /** Additional directories to include in checkpoint tar (beyond mcpConfig.settingsDir).
     *  Used for agents like OpenCode that spread state across XDG directories. */
    checkpointDirs?: string[];
}
/**
 * Registry of all supported agents.
 *
 * Each agent defines a buildCommand function that constructs the CLI command.
 * This is type-safe and handles conditional logic cleanly.
 */
declare const AGENT_REGISTRY: Record<AgentType, AgentRegistryEntry>;
/**
 * Get registry entry for an agent type
 */
declare function getAgentConfig(agentType: AgentType): AgentRegistryEntry;
/**
 * Check if an agent type is valid
 */
declare function isValidAgentType(type: string): type is AgentType;
/**
 * Expand path with ~ to /home/user
 */
declare function expandPath(path: string): string;
/**
 * Get MCP settings path for an agent
 */
declare function getMcpSettingsPath(agentType: AgentType): string;
/**
 * Get MCP settings directory for an agent
 */
declare function getMcpSettingsDir(agentType: AgentType): string;

/**
 * MCP JSON Configuration Writer
 *
 * Handles MCP config for Claude, Gemini, Qwen, and Kimi agents.
 * Uses registry for paths - no hardcoded values.
 *
 * Transport formats by agent:
 * - Claude: { type: "http"|"sse"|"stdio", url: "..." }
 * - Gemini: { url: "...", type: "http"|"sse" } | { command: "..." }
 * - Qwen:   { httpUrl: "..." } | { url: "..." } | { command: "..." }
 * - Kimi:   { url: "...", transport?: "http"|"sse" } | { command: "...", transport: "stdio" }
 */

/**
 * Write MCP config for Claude agent
 *
 * Claude uses two files:
 * 1. ${workingDir}/.mcp.json - project-level MCP servers
 * 2. ~/.claude/settings.json - enable project MCP servers
 */
declare function writeClaudeMcpConfig(sandbox: SandboxInstance, workingDir: string, servers: Record<string, McpServerConfig>): Promise<void>;
/** Write MCP config for Gemini agent */
declare function writeGeminiMcpConfig(sandbox: SandboxInstance, servers: Record<string, McpServerConfig>): Promise<void>;
/** Write MCP config for Qwen agent */
declare function writeQwenMcpConfig(sandbox: SandboxInstance, servers: Record<string, McpServerConfig>): Promise<void>;

/**
 * MCP TOML Configuration Writer
 *
 * Handles MCP config for Codex agent which uses TOML format.
 * Uses registry for paths - no hardcoded values.
 */

/**
 * Write MCP config for Codex agent
 *
 * Codex stores MCP config in ~/.codex/config.toml using TOML format.
 * Format: [mcp_servers.server_name] sections
 */
declare function writeCodexMcpConfig(sandbox: SandboxInstance, servers: Record<string, McpServerConfig>): Promise<void>;

/**
 * MCP Configuration Module
 *
 * Unified entry point for writing MCP server configs.
 * Routes to the appropriate writer based on agent type.
 */

/**
 * Write MCP server configuration for an agent
 *
 * Routes to the appropriate config writer based on agent type:
 * - Claude: JSON to ${workingDir}/.mcp.json + ~/.claude/settings.json
 * - Codex: TOML to ~/.codex/config.toml
 * - Gemini: JSON to ~/.gemini/settings.json
 * - Qwen: JSON to ~/.qwen/settings.json
 * - OpenCode: JSON to ${workingDir}/opencode.json (mcp key)
 */
declare function writeMcpConfig(agentType: AgentType, sandbox: SandboxInstance, workingDir: string, servers: Record<string, McpServerConfig>): Promise<void>;

/**
 * Prompt Templates
 *
 * Prompts are stored as markdown files for easy editing.
 * They are inlined at build time via tsup's text loader.
 */

/**
 * Workspace system prompt template (knowledge mode)
 *
 * Placeholders:
 * - {{workingDir}} - The working directory path
 */
declare const WORKSPACE_PROMPT: string;
/**
 * Workspace system prompt template (SWE mode - includes repo/ folder)
 *
 * Placeholders:
 * - {{workingDir}} - The working directory path
 */
declare const WORKSPACE_SWE_PROMPT: string;
/**
 * User system prompt wrapper template
 *
 * Placeholders:
 * - {{systemPrompt}} - The user's system prompt content
 */
declare const SYSTEM_PROMPT: string;
/**
 * Structured output schema prompt template (for Swarm abstractions)
 *
 * Placeholders:
 * - {{schema}} - JSON schema for the expected output
 */
declare const SCHEMA_PROMPT: string;
/**
 * Judge system prompt template (for Swarm best_of)
 *
 * Placeholders:
 * - {{candidateCount}} - Number of candidates
 * - {{criteria}} - Evaluation criteria
 * - {{fileTree}} - Tree view of context folders
 */
declare const JUDGE_PROMPT: string;
/**
 * Verify system prompt template (for Swarm verify option)
 *
 * Placeholders:
 * - {{criteria}} - Verification criteria
 * - {{fileTree}} - Tree view of context folders
 */
declare const VERIFY_PROMPT: string;
/**
 * Retry feedback prompt template (for Swarm verify retry)
 *
 * Replaces the user prompt when verification fails and retry is needed.
 *
 * Placeholders:
 * - {{originalPrompt}} - The original user prompt
 * - {{feedback}} - Verifier's feedback on what needs to be fixed
 */
declare const RETRY_FEEDBACK_PROMPT: string;
/**
 * Apply template variables to a prompt
 */
declare function applyTemplate(template: string, variables: Record<string, string>): string;
/**
 * Build worker system prompt
 *
 * Used by Agent class to generate the system prompt file written to sandbox.
 *
 * @param mode - "knowledge" (default) or "swe" (includes repo/ folder)
 */
declare function buildWorkerSystemPrompt(options: {
    workingDir: string;
    systemPrompt?: string;
    schema?: z.ZodType<unknown> | Record<string, unknown>;
    mode?: "knowledge" | "swe";
}): string;

/**
 * Schema Utilities
 *
 * Functions for working with Zod and JSON Schema.
 */

/**
 * Check if a schema is a Zod schema (has safeParse method)
 */
declare function isZodSchema(schema: unknown): schema is z.ZodType<unknown>;
/**
 * Convert Zod schema to JSON Schema string
 */
declare function zodSchemaToJson(schema: z.ZodType<unknown>): string;
/**
 * Convert JSON Schema object to formatted string
 */
declare function jsonSchemaToString(schema: Record<string, unknown>): string;

/**
 * File Utilities
 *
 * Functions for reading and writing local files as FileMaps.
 */

/**
 * Read files from a local directory, returning a FileMap.
 *
 * @param localPath - Path to local directory
 * @param recursive - Read subdirectories recursively (default: false)
 * @returns FileMap with relative paths as keys
 *
 * @example
 * // Top-level files only (default)
 * readLocalDir('./folder')
 * // { "file.txt": Buffer }
 *
 * // Recursive - includes subdirectories
 * readLocalDir('./folder', true)
 * // { "file.txt": Buffer, "subdir/nested.txt": Buffer }
 */
declare function readLocalDir(localPath: string, recursive?: boolean): FileMap;
/**
 * Save a FileMap to a local directory, creating nested directories as needed.
 *
 * @param localPath - Base directory to save files to
 * @param files - FileMap to save (from getOutputFiles or other source)
 *
 * @example
 * // Save output files to local directory
 * const output = await agent.getOutputFiles(true);
 * saveLocalDir('./output', output.files);
 * // Creates: ./output/file.txt, ./output/subdir/nested.txt, etc.
 */
declare function saveLocalDir(localPath: string, files: FileMap): void;

/**
 * Storage & Checkpointing Module
 *
 * Provides durable persistence for agent workspaces beyond sandbox lifetime.
 * Supports BYOK (user's S3 bucket) and Gateway (Evolve-managed) modes.
 *
 * Evidence: storage-checkpointing plan v2.2
 */

/**
 * Resolve storage configuration from user input.
 *
 * BYOK mode: URL provided → parse into bucket/prefix, use S3 client directly
 * Gateway mode: no URL → use dashboard API endpoints
 */
declare function resolveStorageConfig(config: StorageConfig | undefined, isGateway: boolean, gatewayUrl?: string, gatewayApiKey?: string): ResolvedStorageConfig;
declare function storage(config?: StorageConfig): StorageClient;

export { AGENT_REGISTRY, AGENT_TYPES, Agent, type AgentConfig, type AgentOptions, type AgentOverride, type AgentParser, type AgentRegistryEntry, type AgentResponse, type AgentRuntimeState, type AgentType, type BaseMeta, type BestOfConfig, type BestOfParams, type BestOfResult, type CandidateCompleteEvent, type CheckpointInfo, type ComposioAuthResult, type ComposioConfig, type ComposioConnectionStatus, type ComposioSetup, type DownloadCheckpointOptions, type DownloadFilesOptions, type EmitOption, type EventHandler, type EventName, Evolve, type EvolveConfig, type EvolveEvents, type ExecuteCommandOptions, type FileMap, type FilterConfig, type FilterParams, type IndexedMeta, type ItemInput, type ItemRetryEvent, JUDGE_PROMPT, type JsonSchema, type JudgeCompleteEvent, type JudgeDecision, type JudgeMeta, type LifecycleEvent, type LifecycleReason, type MapConfig, type MapParams, type McpConfigInfo, type McpServerConfig, type ModelInfo, type OnCandidateCompleteCallback, type OnItemRetryCallback, type OnJudgeCompleteCallback, type OnVerifierCompleteCallback, type OnWorkerCompleteCallback, type OperationType, type OutputEvent, type OutputResult, Pipeline, type PipelineContext, type PipelineEventMap, type PipelineEvents, type PipelineResult, type ProcessInfo, type Prompt, type PromptFn, RETRY_FEEDBACK_PROMPT, type ReasoningEffort, type ReduceConfig, type ReduceMeta, type ReduceParams, type ReduceResult, type ResolvedStorageConfig, type RetryConfig, type RunOptions, SCHEMA_PROMPT, SWARM_RESULT_BRAND, SYSTEM_PROMPT, type SandboxCommandHandle, type SandboxCommandResult, type SandboxCommands, type SandboxCreateOptions, type SandboxFiles, type SandboxInstance, type SandboxLifecycleState, type SandboxProvider, type SandboxRunOptions, type SandboxSpawnOptions, type SchemaValidationOptions, Semaphore, type SessionStatus, type SkillName, type SkillsConfig, type StepCompleteEvent, type StepErrorEvent, type StepEvent, type StepResult, type StepStartEvent, type StorageClient, type StorageConfig, type StreamCallbacks, Swarm, type SwarmConfig, type SwarmResult, SwarmResultList, TerminalPipeline, type ToolsFilter, VALIDATION_PRESETS, VERIFY_PROMPT, type ValidationMode, type VerifierCompleteEvent, type VerifyConfig, type VerifyDecision, type VerifyInfo, type VerifyMeta, WORKSPACE_PROMPT, WORKSPACE_SWE_PROMPT, type WorkerCompleteEvent, type WorkspaceMode, applyTemplate, buildWorkerSystemPrompt, createAgentParser, createClaudeParser, createCodexParser, createGeminiParser, executeWithRetry, expandPath, getAgentConfig, getMcpSettingsDir, getMcpSettingsPath, isValidAgentType, isZodSchema, jsonSchemaToString, parseNdjsonLine, parseNdjsonOutput, parseQwenOutput, readLocalDir, resolveStorageConfig, saveLocalDir, storage, writeClaudeMcpConfig, writeCodexMcpConfig, writeGeminiMcpConfig, writeMcpConfig, writeQwenMcpConfig, zodSchemaToJson };
