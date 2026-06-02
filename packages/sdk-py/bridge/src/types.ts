/**
 * Shared types for JSON-RPC Bridge
 *
 * Types for RPC params, responses, and event callbacks.
 * Separates transport concerns from SDK integration.
 */

// =============================================================================
// JSON-RPC PROTOCOL TYPES
// =============================================================================

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  method: string;
  params?: any;
  id: number | string;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
  /** Request ID. Null when request ID couldn't be determined (parse errors). */
  id: number | string | null;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

// =============================================================================
// FILE ENCODING (for JSON transport)
// =============================================================================

/**
 * Encoded file for JSON-RPC transport
 * Used for both input (context, files) and output (getOutputFiles)
 */
export interface EncodedFile {
  content: string;
  encoding: 'text' | 'base64';
}

export type EncodedFileMap = Record<string, EncodedFile>;

export type AgentPluginConfig =
  | { marketplace: string; plugin: string }
  | { source: string; ref?: string; autoUpdate?: boolean; preRelease?: boolean; skipSettings?: boolean }
  | { marketplace: string; ref?: string; sparse?: string[] };

// =============================================================================
// RPC METHOD PARAMETERS
// =============================================================================

export interface InitializeParams {
  // Agent config (optional - TS SDK resolves from env vars)
  agent_type?: string;
  api_key?: string;
  provider_api_key?: string;
  oauth_token?: string;
  provider_base_url?: string;
  model?: string;
  reasoning_effort?: string;
  // Sandbox provider (optional - TS SDK resolves from EVOLVE_API_KEY env var)
  sandbox_provider?: {
    type: 'e2b' | 'daytona' | 'modal';
    config: Record<string, any>;
  };
  working_directory?: string;
  workspace_mode?: 'knowledge' | 'swe';
  system_prompt?: string;
  context?: EncodedFileMap;
  files?: EncodedFileMap;
  mcp_servers?: Record<string, any>;
  browser?: 'browser-use' | 'actionbook' | 'agent-browser' | { provider: 'actionbook' | 'agent-browser'; remote?: boolean };
  browser_credentials?: BrowserCredentialsConfig;
  plugins?: AgentPluginConfig[];
  skills?: string[];
  secrets?: Record<string, string>;
  sandbox_id?: string;
  forward_stdout?: boolean;
  forward_stderr?: boolean;
  forward_content?: boolean;
  forward_lifecycle?: boolean;
  session_tag_prefix?: string;
  schema?: Record<string, any>;
  schema_options?: { mode?: 'strict' | 'loose' };
  // Observability metadata (passed to JSONL logs via withObservability)
  observability?: Record<string, unknown>;
  // Managed integrations setup
  integrations?: IntegrationsSetup;
  // Storage / Checkpointing
  storage?: StorageConfigParams;
}

export interface RunParams {
  prompt: string;
  timeout_ms?: number;
  background?: boolean;
  from?: string;
  checkpoint_comment?: string;
}

export interface ExecuteCommandParams {
  command: string;
  timeout_ms?: number;
  background?: boolean;
}

export interface UploadFilesParams {
  files: EncodedFileMap;
}

export interface SetSessionParams {
  session_id: string;
}

export interface GetHostParams {
  port: number;
}

export interface BrowserCredentialScopeEntry {
  website: string;
  account_label?: string;
}

export interface BrowserCredentialsConfig {
  allow?: BrowserCredentialScopeEntry[];
}

// =============================================================================
// MANAGED INTEGRATIONS TYPES (matches sdk-ts/src/types.ts)
// =============================================================================

/** Tool filter configuration per app */
export type IntegrationToolsFilter =
  | string[]
  | { enable: string[] }              // Enable only these tools
  | { disable: string[] }             // Disable these tools
  | { tags: string[] };               // Filter by behavior tags

export interface IntegrationsConfig {
  apps: string[];
  tools?: Record<string, IntegrationToolsFilter>;
  accounts?: Record<string, string[]>;
  keys?: Record<string, string>;
  auth_configs?: Record<string, string>;
}

export interface IntegrationsSetup {
  user_id: string;
  apps: string[];
  tools?: Record<string, IntegrationToolsFilter>;
  accounts?: Record<string, string[]>;
  keys?: Record<string, string>;
  auth_configs?: Record<string, string>;
}

// =============================================================================
// INTEGRATIONS RPC PARAMETERS
// =============================================================================

export interface IntegrationsAuthParams {
  user_id: string;
  app: string;
  account_label?: string;
  api_key?: string;
  dashboard_url?: string;
}

export interface IntegrationsAccountsListParams {
  user_ids: string[];
  app?: string;
  statuses?: string[];
  api_key?: string;
  dashboard_url?: string;
}

export interface IntegrationsDisconnectParams {
  account_id: string;
  api_key?: string;
  dashboard_url?: string;
}

export interface IntegrationsAccountUpdateParams {
  account_id: string;
  account_label?: string;
  api_key?: string;
  dashboard_url?: string;
}

// =============================================================================
// INTEGRATIONS RPC RESPONSES
// =============================================================================

export interface IntegrationsAuthResponse {
  url: string;
  account_id?: string;
}

export interface IntegrationsDisconnectResponse {
  success: boolean;
  account_id: string;
}

export interface IntegrationsAccountUpdateResponse {
  success: boolean;
  account_id: string;
  account_label?: string;
}

export interface IntegrationAccountInfo {
  user_id: string;
  app: string;
  app_name?: string;
  app_icon?: string;
  account_label?: string;
  status: string;
  account_id?: string;
}

export interface IntegrationsAccountsListResponse {
  accounts: IntegrationAccountInfo[];
}

// =============================================================================
// MULTI-INSTANCE RPC PARAMETERS (for Swarm)
// =============================================================================

export interface CreateInstanceParams extends InitializeParams {
  instance_id: string;
}

export interface InstanceRunParams extends RunParams {
  instance_id: string;
}

export interface InstanceGetOutputParams {
  instance_id: string;
  recursive?: boolean;
}

export interface InstanceIdParams {
  instance_id: string;
}

// =============================================================================
// RPC METHOD RESPONSES
// =============================================================================

export interface StatusResponse {
  status: 'ok';
}

export interface RunResponse {
  sandbox_id: string;
  /** Dashboard session ID for trace/replay APIs, when known */
  session_id?: string;
  /** Managed browser runtime info, when a remote browser is configured */
  browser?: {
    live_url: string;
  };
  /** Run ID for spend/cost attribution (present for run(), undefined for executeCommand()) */
  run_id?: string;
  exit_code: number;
  stdout: string;
  stderr: string;
  checkpoint?: CheckpointInfoResponse;
}

/**
 * Result from getOutputFiles() - matches TypeScript SDK's OutputResult<T>
 *
 * Evidence: sdk-ts/src/types.ts lines 258-268
 */
export interface OutputResultResponse {
  /** Output files from output/ folder (encoded for JSON transport) */
  files: EncodedFileMap;
  /** Parsed and validated result.json data (null if no schema or validation failed) */
  data: any | null;
  /** Validation or parse error message, if any */
  error?: string;
  /** Raw result.json string when parse or validation failed (for debugging) */
  raw_data?: string;
}

export interface GetHostResponse {
  url: string;
}

/** Runtime status snapshot (snake_case for Python transport) */
export interface SessionStatusResponse {
  sandbox_id: string | null;
  sandbox: string;
  agent: string;
  active_process_id: string | null;
  has_run: boolean;
  timestamp: string;
  browser?: {
    live_url: string;
    session_id?: string;
    session_tag?: string;
  };
}

// =============================================================================
// STORAGE / CHECKPOINTING TYPES
// =============================================================================

/** Storage config params from Python (matches TS SDK StorageConfig) */
export interface StorageConfigParams {
  url?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  credentials?: { accessKeyId: string; secretAccessKey: string };
}

/** Checkpoint info response (snake_case for Python transport) */
export interface CheckpointInfoResponse {
  id: string;
  hash: string;
  tag: string;
  timestamp: string;
  size_bytes?: number;
  agent_type?: string;
  model?: string;
  workspace_mode?: string;
  parent_id?: string;
  comment?: string;
}

export interface CheckpointParams {
  comment?: string;
}

export interface ListCheckpointsParams {
  limit?: number;
  tag?: string;
}

// =============================================================================
// STANDALONE STORAGE CLIENT RPC PARAMS
// =============================================================================

/** Params for storage_list_checkpoints RPC (standalone or bound) */
export interface StorageClientListParams {
  storage?: StorageConfigParams;
  limit?: number;
  tag?: string;
}

/** Params for storage_get_checkpoint RPC */
export interface StorageClientGetParams {
  storage?: StorageConfigParams;
  id: string;
}

/** Params for storage_download_checkpoint RPC */
export interface StorageClientDownloadParams {
  storage?: StorageConfigParams;
  id: string;
  to?: string;
  extract?: boolean;
}

/** Params for storage_download_files RPC */
export interface StorageClientDownloadFilesParams {
  storage?: StorageConfigParams;
  id: string;
  files?: string[];
  glob?: string[];
  to?: string;
}

// =============================================================================
// STANDALONE SESSIONS CLIENT RPC PARAMS
// =============================================================================

export interface SessionsConfigParams {
  apiKey?: string;
  dashboardUrl?: string;
}

export interface SessionsListParams {
  sessions?: SessionsConfigParams;
  limit?: number;
  cursor?: string;
  state?: 'live' | 'ended' | 'all';
  agent?: string;
  tag_prefix?: string;
  sort?: 'newest' | 'oldest' | 'cost';
}

export interface SessionsGetParams {
  sessions?: SessionsConfigParams;
  id: string;
}

export interface SessionsEventsParams {
  sessions?: SessionsConfigParams;
  id: string;
  since?: number;
}

export interface SessionsDownloadParams {
  sessions?: SessionsConfigParams;
  id: string;
  to?: string;
}

export interface SessionsBrowserReplayParams {
  sessions?: SessionsConfigParams;
  id: string;
  timeout_ms?: number;
  interval_ms?: number;
}

export interface SessionInfoResponse {
  id: string;
  tag: string;
  agent: string;
  model: string | null;
  provider: string;
  sandbox_id: string | null;
  state: 'live' | 'ended';
  runtime_status: 'alive' | 'dead' | 'unknown';
  cost: number | null;
  created_at: string;
  ended_at: string | null;
  step_count: number;
  tool_stats: Record<string, number> | null;
}

export interface SessionPageResponse {
  items: SessionInfoResponse[];
  next_cursor: string | null;
  has_more: boolean;
}

export interface SessionEventsResponse {
  events: Record<string, any>[];
}

export interface BrowserReplayResponse {
  session_id: string;
  status: 'ready';
  replay_url: string;
  download_url: string;
  suggested_start_seconds?: number;
  size_bytes?: number;
  ready_at?: string;
}

// =============================================================================
// COST TYPES
// =============================================================================

export interface GetRunCostParams {
  run_id?: string;
  index?: number;
}

/** Cost breakdown for a single run() invocation (snake_case for Python transport) */
export interface RunCostResponse {
  run_id: string;
  index: number;
  cost: number;
  tokens: { prompt: number; completion: number };
  model: string;
  requests: number;
  as_of: string;
  is_complete: boolean;
  truncated: boolean;
}

/** Cost breakdown for an entire agent session (snake_case for Python transport) */
export interface SessionCostResponse {
  session_tag: string;
  total_cost: number;
  total_tokens: { prompt: number; completion: number };
  runs: RunCostResponse[];
  as_of: string;
  is_complete: boolean;
  truncated: boolean;
}

// =============================================================================
// EVENT CALLBACKS (for streaming)
// =============================================================================

export interface EventCallbacks {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  onContent?: (event: any) => void;
  onLifecycle?: (event: any) => void;
}
