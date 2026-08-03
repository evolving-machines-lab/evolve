/**
 * Evolve SDK Constants
 *
 * Internal constants - not exposed to users.
 */

// =============================================================================
// GATEWAY URLS
// =============================================================================

/**
 * Get the gateway URL at runtime
 *
 * All agent requests are routed through this gateway which provides:
 * - Single API key for all providers
 * - Cost tracking per user
 * - Rate limiting and budget controls
 *
 * Note: Uses a function to ensure env var is read at runtime (not build time)
 * when using bundlers with environment variable inlining.
 *
 * @param path Optional gateway path prefix for provider passthrough routes
 * @internal
 */
export function getGatewayUrl(path = ""): string {
  const baseUrl =
    process.env.EVOLVE_GATEWAY_URL ||
    "https://swarmkit-gateway-692833842999.us-central1.run.app";
  if (!path) return baseUrl;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl}${normalizedPath}`;
}

/**
 * Get the dashboard URL at runtime.
 *
 * Managed control-plane requests go to the Dashboard endpoint.
 *
 * @param path Optional dashboard path
 * @internal
 */
export function getDashboardUrl(path = ""): string {
  const baseUrl = process.env.EVOLVE_DASHBOARD_URL || DEFAULT_DASHBOARD_URL;
  if (!path) return baseUrl;
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${baseUrl.replace(/\/$/, "")}${normalizedPath}`;
}

/**
 * Sandbox providers the Dashboard runs on the customer's behalf.
 *
 * Managed mode means the customer holds one Evolve API key and no provider
 * credential at all: the Dashboard authenticates the key, records ownership,
 * and makes the provider call with platform credentials. Each provider has its
 * own door under /api/managed/<provider>.
 */
export const MANAGED_SANDBOX_PROVIDERS = ["e2b", "daytona", "modal"] as const;

export type ManagedSandboxProviderName = (typeof MANAGED_SANDBOX_PROVIDERS)[number];

/**
 * Get a managed provider's control-plane URL.
 *
 * @internal
 */
export function getManagedProviderUrl(provider: ManagedSandboxProviderName): string {
  return getDashboardUrl(`/api/managed/${provider}`);
}

/**
 * Get the managed Daytona TOOLBOX URL — the second plane.
 *
 * Daytona sends every command and file operation to a per-sandbox runner it
 * discovers at runtime, not to the control-plane URL. Managed mode answers
 * that discovery with this route, so exec and filesystem traffic reaches the
 * Dashboard like everything else.
 *
 * @internal
 */
export function getManagedDaytonaToolboxUrl(): string {
  return `${getManagedProviderUrl("daytona")}/toolbox`;
}

/**
 * Get the managed E2B control-plane URL.
 *
 * Managed sandbox control-plane requests go to the Dashboard endpoint.
 *
 * @internal
 */
export function getE2BGatewayUrl(): string {
  return getManagedProviderUrl("e2b");
}

/**
 * Get gateway MCP servers for opt-in platform integrations
 *
 * These MCP servers are available to users authenticating via EVOLVE_API_KEY.
 * The gateway injects provider API keys server-side.
 *
 * Users can override these by providing their own config with the same key
 * via .withMcpServers().
 *
 * @param apiKey - The user's Evolve API key for authentication
 * @returns MCP server configurations to merge with user config
 * @internal
 */
export function getGatewayMcpServers(apiKey: string): Record<string, { type: "http"; url: string; headers: Record<string, string> }> {
  return {
    "browser-use": {
      type: "http",
      url: getGatewayUrl("/browser_use/mcp"),
      headers: { "x-litellm-api-key": `Bearer ${apiKey}` },
    },
  };
}

// =============================================================================
// ENVIRONMENT VARIABLES
// =============================================================================

/**
 * Environment variable for Evolve SDK API key
 * @internal
 */
export const ENV_EVOLVE_API_KEY = "EVOLVE_API_KEY";

/**
 * Environment variable for E2B API key
 * @internal
 */
export const ENV_E2B_API_KEY = "E2B_API_KEY";

/**
 * Environment variable for Daytona API key
 * @internal
 */
export const ENV_DAYTONA_API_KEY = "DAYTONA_API_KEY";

/**
 * Environment variable for Modal token ID
 * @internal
 */
export const ENV_MODAL_TOKEN_ID = "MODAL_TOKEN_ID";

/**
 * Environment variable for Modal token secret
 * @internal
 */
export const ENV_MODAL_TOKEN_SECRET = "MODAL_TOKEN_SECRET";

// =============================================================================
// DEFAULTS
// =============================================================================

/**
 * Default agent type when not specified
 * @internal
 */
export const DEFAULT_AGENT_TYPE = "claude";

/**
 * Default timeout for agent operations (1 hour)
 * @internal
 */
export const DEFAULT_TIMEOUT_MS = 3600000;

/**
 * Default concurrency for swarm operations
 * @internal
 */
export const DEFAULT_CONCURRENCY = 4;

/**
 * Maximum concurrency for swarm operations
 * For higher parallelism, scale horizontally with multiple processes.
 * @internal
 */
export const MAX_CONCURRENCY = 100;

/**
 * Default sandbox home directory (used when no sandbox user is configured)
 * @internal
 */
export const DEFAULT_HOME_DIR = "/home/user";

/**
 * Resolve the sandbox home directory for a configured sandbox user.
 * Default: "/root" when user is "root", "/home/<user>" for other users,
 * DEFAULT_HOME_DIR when no user is given.
 * @internal
 */
export function resolveHomeDir(user?: string, homeDir?: string): string {
  if (homeDir) return homeDir.replace(/\/+$/, "") || "/";
  if (!user) return DEFAULT_HOME_DIR;
  return user === "root" ? "/root" : `/home/${user}`;
}

/**
 * Default working directory in sandbox (resolved per-agent as `${homeDir}/workspace`)
 * @internal
 */
export const DEFAULT_WORKING_DIR = `${DEFAULT_HOME_DIR}/workspace`;

// =============================================================================
// OBSERVABILITY
// =============================================================================

/**
 * Default dashboard URL for session sync
 * @internal
 */
export const DEFAULT_DASHBOARD_URL = process.env.EVOLVE_DASHBOARD_URL || "https://dashboard.evolvingmachines.ai";

// =============================================================================
// SPEND TRACKING
// =============================================================================

/** Header the sandbox sends so gateway usage is attributed to this session. */
export const LITELLM_CUSTOMER_ID_HEADER = "x-litellm-customer-id";

/** Header the sandbox sends so gateway usage is attributed to this run. */
export const LITELLM_TAGS_HEADER = "x-litellm-tags";

/** Prefix for per-run tags. */
export const RUN_TAG_PREFIX = "run:";

/**
 * Local storage directory for session logs (relative to home)
 * Full path: ~/.evolve-sdk/observability/sessions/
 * @internal
 */
export const SESSION_LOGS_DIR = ".evolve-sdk/observability/sessions";

/**
 * The names the session ingest payload spends on identity, so observability
 * metadata may not use them.
 *
 * The dashboard keys a session row on (tag, userId) and reads the rest of these
 * off the same envelope. Observability metadata is spread into that envelope
 * after the identity fields, so a metadata key named `tag` does not annotate
 * the session — it renames it, and the run splits in two: the renamed row
 * collects the events and the model while gateway spend, attributed from the
 * real session tag, stays behind on the original row. One sandbox, two rows,
 * neither complete.
 *
 * @internal
 */
export const RESERVED_OBSERVABILITY_KEYS = [
  "tag",
  "provider",
  "agent",
  "model",
  "sandboxId",
  "timestamp",
  "event",
  "events",
] as const;

/**
 * Max events per dashboard sync batch
 * @internal
 */
export const DASHBOARD_BATCH_SIZE = 100;

/**
 * Interval between dashboard sync flushes (ms)
 * @internal
 */
export const DASHBOARD_FLUSH_INTERVAL_MS = 5000;

/**
 * Max retries for failed dashboard sync requests
 * @internal
 */
export const DASHBOARD_MAX_RETRIES = 3;

/**
 * Initial retry delay for dashboard sync (ms)
 * Uses exponential backoff: delay * attempt
 * @internal
 */
export const DASHBOARD_RETRY_DELAY_MS = 1000;
