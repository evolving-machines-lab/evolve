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
  // Composio Tool Router setup
  composio?: ComposioSetup;
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

// =============================================================================
// COMPOSIO TYPES (matches sdk-ts/src/types.ts)
// =============================================================================

/** Tool filter configuration per toolkit - matches TS SDK ToolsFilter */
export type ToolsFilter =
  | string[]                          // Enable only these tools
  | { enable: string[] }              // Enable only these tools
  | { disable: string[] }             // Disable these tools
  | { tags: string[] };               // Filter by behavior tags

export interface ComposioConfig {
  toolkits?: string[];
  tools?: Record<string, ToolsFilter>;
  keys?: Record<string, string>;
  auth_configs?: Record<string, string>;
}

export interface ComposioSetup {
  user_id: string;
  config?: ComposioConfig;
}

// =============================================================================
// COMPOSIO RPC PARAMETERS
// =============================================================================

export interface ComposioAuthParams {
  user_id: string;
  toolkit: string;
}

export interface ComposioStatusParams {
  user_id: string;
  toolkit?: string;
}

export interface ComposioConnectionsParams {
  user_id: string;
}

// =============================================================================
// COMPOSIO RPC RESPONSES
// =============================================================================

/** Auth result - url to redirect user, connectionId for tracking */
export interface ComposioAuthResponse {
  url: string;
  connection_id: string;
}

/** Status result - boolean if toolkit specified, map if not */
export interface ComposioStatusResponse {
  /** If toolkit was specified, this is the result */
  connected?: boolean;
  /** If no toolkit specified, this is the map */
  status_map?: Record<string, boolean>;
}

/** Connection info from getConnections */
export interface ComposioConnectionInfo {
  toolkit: string;
  connected: boolean;
  account_id?: string;
}

export interface ComposioConnectionsResponse {
  connections: ComposioConnectionInfo[];
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
