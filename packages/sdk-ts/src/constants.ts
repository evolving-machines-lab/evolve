/**
 * Evolve SDK Constants
 *
 * Internal constants - not exposed to users.
 */

// =============================================================================
// GATEWAY URLS
// =============================================================================

/**
 * Get the gateway base URL at runtime
 *
 * All agent requests are routed through this gateway which provides:
 * - Single API key for all providers
 * - Cost tracking per user
 * - Rate limiting and budget controls
 *
 * Note: Uses a function to ensure env var is read at runtime (not build time)
 * when using bundlers with environment variable inlining.
 *
 * @internal
 */
export function getGatewayUrl(): string {
  return (
    process.env.EVOLVE_GATEWAY_URL ||
    "https://swarmkit-gateway-692833842999.us-central1.run.app"
  );
}

/**
 * Get the Gemini passthrough URL
 *
 * Uses LiteLLM's /gemini passthrough endpoint to preserve native @google/genai SDK
 * format including systemInstruction. Without this, system prompts get dropped
 * during OpenAI format translation.
 *
 * @internal
 */
export function getGeminiGatewayUrl(): string {
  return `${getGatewayUrl()}`;
}

/**
 * Get the E2B passthrough URL
 *
 * Routes E2B control plane requests (sandbox create/connect) through the gateway.
 * Gateway validates EVOLVE_API_KEY and injects E2B_API_KEY.
 *
 * Note: Data plane operations (files, commands) go directly to the sandbox
 * using envdAccessToken - no gateway needed for those.
 *
 * @internal
 */
export function getE2BGatewayUrl(): string {
  return `${getGatewayUrl()}/e2b`;
}

/**
 * Get default MCP servers for gateway mode users
 *
 * These MCP servers are automatically available to users authenticating via
 * EVOLVE_API_KEY. The gateway injects provider API keys server-side.
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
      url: `${getGatewayUrl()}/browser_use/mcp`,
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
 * Default working directory in sandbox
 * @internal
 */
export const DEFAULT_WORKING_DIR = "/home/user/workspace";

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

/** LiteLLM header for session-level grouping (maps to `end_user` in spend logs) */
export const LITELLM_CUSTOMER_ID_HEADER = "x-litellm-customer-id";

/** LiteLLM header for per-request tagging (maps to `request_tags` in spend logs) */
export const LITELLM_TAGS_HEADER = "x-litellm-tags";

/** Prefix for run tags in `request_tags` — must match dashboard parser */
export const RUN_TAG_PREFIX = "run:";

/**
 * Local storage directory for session logs (relative to home)
 * Full path: ~/.evolve-sdk/observability/sessions/
 * @internal
 */
export const SESSION_LOGS_DIR = ".evolve-sdk/observability/sessions";

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
