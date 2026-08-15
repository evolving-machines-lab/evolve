/**
 * Evolve SDK Types
 *
 * Simplified types for the headless CLI agent SDK.
 * Provider-agnostic sandbox abstraction - any provider can implement these.
 */

import type { OutputEvent } from "./parsers/types";
import type { ManagedSecretRef } from "./managed-secrets";
import type { ZodType } from "zod";

export interface EvolveEvents {
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  content: (event: OutputEvent) => void;
  lifecycle: (event: LifecycleEvent) => void;
}

export interface EvolveConfig {
  agent?: AgentConfig;
  sandbox?: SandboxProvider;
  sandboxCreateOptions?: SandboxCreateOptions;
  workingDirectory?: string;
  workspaceMode?: WorkspaceMode;
  secrets?: Record<string, string>;
  managedSecrets?: ManagedSecretRef[];
  sandboxId?: string;
  systemPrompt?: string;
  context?: FileMap;
  files?: FileMap;
  mcpServers?: Record<string, McpServerConfig>;
  browser?: BrowserConfig;
  browserCredentials?: BrowserCredentialsConfig;
  plugins?: AgentPluginConfig[];
  skills?: SkillName[];
  schema?: ZodType<unknown> | JsonSchema;
  schemaOptions?: SchemaValidationOptions;
  sessionTagPrefix?: string;
  observability?: Record<string, unknown>;
  integrations?: IntegrationsSetup;
  storage?: StorageConfig;
}

// =============================================================================
// SANDBOX ABSTRACTION (provider-agnostic)
// =============================================================================
//
// These interfaces are the ONE contract between the SDK and any sandbox
// provider (E2B, Daytona, Modal, Docker, Fly.io, local, ...). The provider
// packages each declare their own wider surface; every one of those surfaces
// is pinned to this file by tests/unit/provider-parity.test.ts, which type-
// checks a conformance file per provider package and fails the unit suite on
// drift. Change a member here and the providers must follow.
//
// Members fall into three tiers:
//
//   REQUIRED — the SDK itself calls these, so every provider must have them.
//     provider: providerType, create, connect
//     instance: sandboxId, commands, files, getHost, kill, pause
//     commands: run, spawn, list, kill
//     files:    read, write, writeBatch, makeDir
//
//   OPTIONAL CAPABILITY — provider-neutral operations that all three
//     first-party providers implement but the SDK never calls. Declared
//     optional so a third-party provider passed to .withSandbox() is not
//     forced to implement what the SDK does not use, while any provider that
//     DOES offer them is held to one signature. Probe before calling:
//     `if (sandbox.files.writeFromPath) ...`.
//     provider: name, list
//     instance: isRunning, getInfo
//     files:    writeFromPath, exists, list, remove, rename
//
//   PROVIDER-NATIVE — deliberately NOT in this contract, because they are
//     backend-shaped and not offered by every provider (Daytona has none of
//     them): commands.connect, commands.sendStdin, files.readStream,
//     files.writeStream, files.uploadUrl, files.downloadUrl, files.watchDir.
//     Reach them through the provider's own types:
//
//       import type { SandboxInstance as E2BInstance } from "@evolvingmachines/e2b";
//       const e2b = sandbox as E2BInstance;
//       await e2b.commands.sendStdin(pid, "input");
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

/** Provider-neutral outbound network policy applied when the sandbox boots. */
export interface SandboxNetworkPolicy {
  /** Allow all outbound traffic, or deny it except for allowedDestinations. */
  outbound: "open" | "blocked";
  /** Hostnames, IP addresses, or CIDR ranges that remain reachable when blocked. */
  allowedDestinations?: string[];
}

/** Options for creating a sandbox */
export interface SandboxCreateOptions {
  /** Sandbox image/template ID. Provider uses its default if not specified. */
  image?: string;
  envs?: Record<string, string>;
  metadata?: Record<string, string>;
  timeoutMs?: number;
  /**
   * Terminate the sandbox after this long with nothing running in it. This is
   * an INACTIVITY bound, not a lifetime: `timeoutMs` caps how long the box may
   * live at all, this caps how long it may sit doing nothing — which is what
   * reclaims a box whose client died between commands, long before the lifetime
   * would.
   *
   * Providers must reject it if they cannot enforce it, never silently ignore
   * it. Only modal has a true idle timer alongside an absolute lifetime; e2b has
   * no idle concept, and daytona's only clock IS an inactivity one, which
   * `timeoutMs` already drives there.
   *
   * WHAT COUNTS AS ACTIVITY IS THE PROVIDER'S DEFINITION, and it is narrower
   * than "the client is doing something" — Modal counts a running exec, a stdin
   * write, and an open tunnel connection, and says nothing about filesystem
   * calls. Size this above the longest gap between commands the caller expects,
   * not above the longest gap between API calls.
   */
  idleTimeoutMs?: number;
  workingDirectory?: string;
  /**
   * Per-sandbox compute sizing: cpu in cores, memory and disk in GiB.
   * Providers must reject entries they cannot enforce at create time, never
   * silently ignore them (modal sizes cpu/memory at create but cannot size
   * disk; e2b sizes at template build only; daytona sizes at snapshot build,
   * so an existing snapshot cannot be resized at create).
   *
   * `gpu` is a create-time GPU reservation (count) with `gpuTypes` the
   * acceptable type names. Modal is the one first-party provider that takes
   * it: the adapter maps the pair to Modal's "<TYPE>:<count>" reservation
   * string ('any' when no types; the FIRST type when several — Modal takes
   * one). e2b has no GPU offering and daytona allocates GPU at snapshot
   * build, so both typed-reject a create-time `gpu` — same law as `disk`.
   */
  resources?: { cpu?: number; memory?: number; disk?: number; gpu?: number; gpuTypes?: string[] };
  /** Providers must reject policies they cannot enforce; never silently ignore them. */
  network?: SandboxNetworkPolicy;
  /**
   * Run all commands and file operations as this user.
   * Providers must reject it if they cannot enforce it, never silently ignore it.
   */
  user?: string;
  /**
   * Home directory used for agent config paths inside the sandbox.
   * Default: "/root" when user is "root", "/home/<user>" for other users,
   * "/home/user" when no user is given.
   */
  homeDir?: string;
}

/** Options for listing sandboxes (capability: SandboxProvider.list). */
export interface SandboxListOptions {
  /**
   * Provider-neutral states. Providers map them onto their own vocabulary and
   * must not invent matches for a state they do not have (Modal has no paused
   * state, so a filter excluding "running" matches nothing there).
   */
  state?: ("running" | "paused")[];
  metadata?: Record<string, string>;
  limit?: number;
}

/** File or directory entry (capability: SandboxFiles.list). */
export interface FileInfo {
  name: string;
  path: string;
  type: "file" | "dir";
}

/**
 * A COMPLETE (or admittedly incomplete) enumeration of a provider's fleet.
 *
 * `complete` is the load-bearing field, not a nicety. The callers that need a
 * whole fleet — orphan sweeps, lifecycle reconciliation — read a sandbox's
 * ABSENCE from the list as evidence it is gone, so a truncated page and a small
 * fleet must never be the same answer. Returning a short array with no signal
 * makes them identical, and the caller that acts on that difference is the one
 * deleting machines.
 *
 * A caller that sees `complete: false` has to leave every row alone, exactly as
 * if it had never asked.
 */
export interface SandboxListPage {
  sandboxes: SandboxInfo[];
  /**
   * False means THIS IS NOT THE WHOLE FLEET — for any reason, including a
   * `limit` the caller set. A caller-imposed limit that stopped the walk while
   * more sandboxes existed is still a truncated answer, and reporting it as
   * complete is what made this flag useless at its only real consumer: a sweep
   * that always passes a limit could never learn it had been truncated.
   * Complete means the provider ran out, not that we stopped asking.
   */
  complete: boolean;
  /** Provider requests made. Diagnostic — a fleet that suddenly costs 40 pages. */
  pagesFetched: number;
  /** Why it could not be finished, when it could not. */
  error?: string;
}

/** Sandbox metadata and lifecycle info (capability: SandboxProvider.list, SandboxInstance.getInfo). */
export interface SandboxInfo {
  sandboxId: string;
  /** The provider-neutral image/template the sandbox booted from. */
  image: string;
  name?: string;
  metadata: Record<string, string>;
  startedAt: string;
  /** End time (undefined for running sandboxes). */
  endAt?: string;
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
  /**
   * Upload a LOCAL file by path, without loading it into the process heap.
   *
   * write()/writeBatch() take the bytes as a value, so uploading a large
   * artifact costs one full-size Buffer per concurrent upload — a caller doing
   * many uploads at once pays that in RSS. This takes the path instead and lets
   * the provider move the bytes its own cheapest way (a request body streamed
   * off disk, or the vendor SDK's own path upload).
   *
   * OPTIONAL: a provider that has no cheaper path than "read it and send it"
   * omits this, and uploadFileFromPath() falls back to write().
   */
  writeFromPath?(sandboxPath: string, localPath: string): Promise<void>;

  // --- Optional capabilities (all three first-party providers implement these;
  //     the SDK never calls them, so a provider may omit them) ---

  /** Check whether a file or directory exists. */
  exists?(path: string): Promise<boolean>;
  /** List directory contents. */
  list?(path: string): Promise<FileInfo[]>;
  /** Delete a file or directory. */
  remove?(path: string): Promise<void>;
  /** Rename or move a file or directory. */
  rename?(oldPath: string, newPath: string): Promise<void>;
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

  // --- Optional capabilities (see the tier notes at the top of this section) ---

  /** Whether the sandbox is currently running. */
  isRunning?(): Promise<boolean>;
  /** Sandbox metadata and timing. */
  getInfo?(): Promise<SandboxInfo>;
}

/** Sandbox lifecycle management - providers implement this */
export interface SandboxProvider {
  /** Provider type identifier (e.g., "e2b") */
  readonly providerType: string;
  /** Human-readable provider name for logging (e.g., "E2B") */
  readonly name?: string;
  create(options: SandboxCreateOptions): Promise<SandboxInstance>;
  connect(sandboxId: string, timeoutMs?: number): Promise<SandboxInstance>;

  /**
   * List sandboxes, paginating to exhaustion.
   *
   * `limit` bounds the number of items RETURNED, so a caller that wants one
   * cheap page still asks for one; without it the answer is the whole fleet.
   * It used to be first-page-only regardless, which silently truncated any
   * account past a provider's page size.
   *
   * Errors throw. A caller that cannot treat a failed enumeration as an
   * exception — because it reads absence as termination — wants `listAll`.
   *
   * OPTIONAL: all three first-party providers implement it, but the SDK never
   * calls it, so requiring it would break third-party providers passed to
   * .withSandbox() for no gain. Declared here so every provider that offers it
   * offers the SAME signature.
   */
  list?(options?: SandboxListOptions): Promise<SandboxInfo[]>;

  /**
   * The fleet-bookkeeping counterpart to `list()`: paginates to exhaustion and
   * NEVER throws.
   *
   * The difference is not error style, it is what a failure MEANS to the
   * caller. Anything that reads a sandbox's absence as "terminated" cannot
   * distinguish a provider that answered "nothing" from one that could not
   * finish answering — and acting on that confusion mass-kills a live fleet. So
   * a failure comes back as `complete: false` rather than as an exception the
   * caller might catch and treat as an empty list.
   *
   * REQUIRED, unlike `list`. It was optional in the first cut, and that is
   * precisely what let one provider keep silently truncating while this
   * interface promised exhaustive listing — a provider that cannot answer "is
   * this the whole fleet?" cannot be used for fleet bookkeeping at all, so the
   * type refuses to let a fourth one ship without saying so.
   *
   * PARTIAL RESULTS ARE RETURNED, not discarded: `complete: false` with a
   * non-empty `sandboxes` means "at least these, and there are more". Modal's
   * own `listSandboxIds` takes the stricter line and returns an empty set on
   * failure, on the grounds that partial results are worse than none for a
   * terminal-state decision. Both are safe because `complete` is what callers
   * branch on; the divergence is deliberate and noted here so nobody "fixes"
   * one to match the other without deciding which rule they want.
   */
  listAll(options?: SandboxListOptions): Promise<SandboxListPage>;

  /**
   * Build or pull a sandbox image ahead of time, so the sandbox that needs it
   * later does not wait for it.
   *
   * `image` takes exactly what `create({ image })` takes and MUST be resolved
   * by the same path the provider's own create() uses — a prewarm that
   * resolves an image differently from the create it is meant to serve fails
   * silently, populating one image while sandboxes launch from another.
   * Omitted, it prewarms the provider's configured default image.
   *
   * Sizing is deliberately absent: a provider whose image identity includes
   * CPU/memory (Daytona content-addresses over image plus sizing) needs a
   * different shape than one whose identity is the registry reference alone
   * (Modal), and guessing here would hand callers a prewarm that misses.
   *
   * OPTIONAL, on the same terms as `list`: the SDK never calls it, so
   * requiring it would break third-party providers passed to .withSandbox()
   * for no gain. Declared here so every provider that offers it offers the
   * SAME signature, and so callers can feature-detect it in a typed way
   * rather than casting.
   */
  prepareImage?(image?: string): Promise<void>;
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
export type WorkspaceMode = "knowledge" | "swe" | "task";

/**
 * A skill reference. Real references only — there is no built-in catalog:
 * `skills.sh/<owner>/<repo>[/<skill>]`, `org/repo[@ref]`, an https git URL
 * (optionally `/tree/<ref>/<subdir>`), or a local folder path. The historical
 * name is kept as the alias every skills-carrying surface already imports;
 * the grammar and resolution live in skills.ts.
 */
export type SkillName = string;

/** Browser automation providers that can be enabled explicitly */
export type BrowserProvider = "browser-use" | "actionbook" | "agent-browser";

/** Browser providers backed by Evolve-managed browser transport. */
export type ManagedBrowserProvider = "actionbook" | "agent-browser";

/** Actionbook browser configuration. */
export interface ActionbookBrowserConfig {
  provider: "actionbook";
  /** Use Evolve-managed remote browser transport. Defaults to false for object config. */
  remote?: boolean;
  /** Reusable provider-native browser profile for managed remote browser sessions. */
  profile?: string;
}

/** Agent-browser browser configuration. */
export interface AgentBrowserConfig {
  provider: "agent-browser";
  /** Use Evolve-managed remote browser transport. Defaults to false for object config. */
  remote?: boolean;
  /** Reusable provider-native browser profile for managed remote browser sessions. */
  profile?: string;
}

/** Default managed browser configuration. */
export interface DefaultBrowserConfig {
  provider?: undefined;
  /** Defaults to true for the default managed agent-browser path. */
  remote?: boolean;
  /** Reusable provider-native browser profile for managed remote browser sessions. */
  profile?: string;
}

/** Browser automation configuration. */
export type BrowserConfig = BrowserProvider | DefaultBrowserConfig | ActionbookBrowserConfig | AgentBrowserConfig;

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
  /** Directory the CLI auto-discovers skills from; resolved skills are mounted here */
  targetDir: string;
}

/** Reasoning effort for CLIs/models that support it; valid values vary by model. */
export type ReasoningEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "thinking"
  | "no-thinking";

/**
 * The named agent-settings presets the platform ships. Exactly two at launch
 * (owner ruling): `no-internet` (vendor server-side web tools off) and
 * `pinned-context` (fixed context window). A preset is a platform-authored
 * settings bundle stamped ON TOP of any user config document — see
 * `AgentConfig.preset` for the per-harness delivery.
 */
export const AGENT_PRESETS = ["no-internet", "pinned-context"] as const;

/** One of the platform's named agent-settings presets. */
export type AgentPreset = (typeof AGENT_PRESETS)[number];

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

/**
 * Caller-minted gateway credential for external gateway mode.
 *
 * For callers that mint their own spend-capped key on an OpenAI-compatible
 * gateway. The credential is injected like direct mode and sealCredentials()
 * calls revoke() — sealing fails if revocation fails.
 */
export interface ExternalGatewayConfig {
  /** Spend-capped gateway API key minted by the caller */
  apiKey: string;
  /** OpenAI-compatible gateway base URL */
  baseUrl: string;
  /** Revoke the minted credential. Called by sealCredentials(); seal fails if this throws. */
  revoke: () => Promise<void>;
}

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
  /**
   * Caller-minted revocable gateway credential. Mutually exclusive with
   * apiKey (gateway mode) and providerApiKey/providerBaseUrl (direct mode).
   */
  externalGateway?: ExternalGatewayConfig;
  /** Model to use (optional, uses agent's default if omitted) */
  model?: string;
  /** Reasoning effort for models that support it */
  reasoningEffort?: ReasoningEffort;
  /**
   * Native agent settings — Harbor's `config` agent kwarg. Either a local
   * file path (read when the run resolves its config) or an inline JSON
   * object; the SDK converts it into the harness's native settings document
   * inside the sandbox (Claude: a settings JSON passed via `--settings`;
   * Codex: the base `~/.codex/config.toml`). The user document is the BASE:
   * platform inputs — gateway routing, MCP servers, model/effort flags — are
   * stamped on top. Only harnesses with native-config support accept it
   * (claude, codex); any other agent type refuses loudly.
   */
  config?: string | Record<string, unknown>;
  /**
   * Named agent-settings preset — a platform-authored bundle of native
   * settings delivered through the same channel as `config`, stamped ON TOP
   * of the user document (a preset is a platform stamp, so a user config can
   * never undo it):
   *
   *   - `"no-internet"`: turns off the vendor's server-side web tools —
   *     Claude gets `permissions.deny: ["WebSearch", "WebFetch"]` in its
   *     settings document, Codex gets `-c web_search=disabled` (the exact
   *     flag Harbor's codex agent exposes, their codex.py:70-76). Sandbox
   *     sealing cannot stop server-side search: it rides inside the one
   *     allowed model call, so the harness must be told not to ask for it.
   *   - `"pinned-context"`: pins the effective context window to one fixed
   *     size (PINNED_CONTEXT_WINDOW_TOKENS) so vendor-side window tuning
   *     never confounds a comparison — Claude gets `autoCompactWindow` (its
   *     settings key for exactly this; unset, "Claude Code uses a window
   *     tuned for your model"), Codex gets `-c model_context_window`.
   *
   * Only harnesses whose registry entry carries delivery knowledge for the
   * preset accept it (claude, codex); any other combination refuses loudly
   * at the door — a preset that cannot be guaranteed is never half-applied.
   */
  preset?: AgentPreset;
  /**
   * Context/completion ceiling for CLIs that must be told one (Kimi Code reads
   * it as `max_context_size` and sends it as the request's `max_tokens`).
   *
   * Set it to the model's real ceiling when driving a harness against a model
   * from another family — e.g. Kimi Code against `gpt-5.5` through an
   * OpenAI-compatible gateway, where an oversized `max_tokens` is rejected with
   * a 400. When set it is used verbatim. When omitted, the harness's own models
   * keep their registry value and any other model falls back to a conservative
   * 128000. Harnesses that never send a ceiling ignore it.
   */
  maxContextSize?: number;
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
  /** External gateway mode: caller-minted revocable credential */
  externalGateway?: { revoke: () => Promise<void> };
  model?: string;
  reasoningEffort?: ReasoningEffort;
  /** Caller-pinned context/completion ceiling; used verbatim when present */
  maxContextSize?: number;
  /**
   * Native agent settings, NORMALIZED: a file path input has been read and
   * parsed by now, so delivery code only ever sees the document object.
   */
  config?: Record<string, unknown>;
  /**
   * Named agent-settings preset, validated against the harness's registry
   * delivery knowledge by now — an unsupported combination was refused at the
   * door and never reaches delivery code.
   */
  preset?: AgentPreset;
}

/** Options for Agent constructor */
export interface AgentOptions {
  /** Sandbox provider (e.g., E2B) */
  sandboxProvider?: SandboxProvider;
  /** Provider-neutral sandbox creation options forwarded on fresh creates. */
  sandboxCreateOptions?: SandboxCreateOptions;
  /** Additional environment secrets */
  secrets?: Record<string, string>;
  /** Dashboard-stored managed secrets exposed through opaque env vars. */
  managedSecrets?: {
    secrets: ManagedSecretRef[];
    apiKey: string;
    dashboardUrl?: string;
  };
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
    profile?: string;
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
  /** Evolve-managed provider routing tokens for dashboard-stored BYOK provider keys. */
  providerRouting?: {
    apiKey: string;
    dashboardUrl?: string;
  };
  /** Plugins/extensions to install in the sandbox user profile before first run */
  plugins?: AgentPluginConfig[];
  /**
   * Skill references to mount: `skills.sh/<owner>/<repo>[/<skill>]`,
   * `org/repo[@ref]`, an https git URL, or a local folder path.
   */
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

  /**
   * Whether this run CONTINUES the agent's previous conversation in this
   * sandbox, or starts a fresh one.
   *
   * Omitted, the SDK decides as it always has: the first run in a sandbox is
   * fresh and every run after it resumes (and a session attached with
   * `withSession()` resumes, since the agent may already have run there). That
   * default is right for a chat-shaped session, where each turn builds on the
   * last.
   *
   * It is wrong for a sequence of INDEPENDENT tasks against one shared sandbox
   * — the environment is meant to persist while the agent's context is not.
   * Harbor's multi-step tasks are exactly that shape: steps share a container
   * and, by default, each step starts the agent in a fresh conversation
   * (docs/content/docs/tasks/multi-step.mdx:210). Before this option there was
   * no way to ask for it: the resume flag was bound to internal state, so an
   * evaluator running N steps in one box silently made every step after the
   * first easier than the benchmark intended.
   *
   * `false` forces a fresh conversation, `true` forces a resume. Forcing a
   * resume on the FIRST run of a sandbox asks a CLI to continue a session that
   * does not exist, and each CLI answers that its own way — so pass `true` only
   * when a previous run really happened.
   */
  resume?: boolean;
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
  /** Total cost in USD as billed to your Evolve account */
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
