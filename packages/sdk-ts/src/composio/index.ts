/**
 * Composio Integration Module
 *
 * Provides integration with Composio Tool Router for access to 1000+ tools.
 * Uses the official @composio/core SDK.
 *
 * Evidence:
 * - tool-router/quickstart.mdx
 * - tool-router/using-with-mcp-clients.mdx
 * - tool-router/manually-authenticating-users.mdx
 */

// =============================================================================
// SESSION EXPORTS (for agent setup)
// =============================================================================

export {
  setupComposio,
  createSession,
  createApiKeyConnection,
  COMPOSIO_API_KEY_ENV,
  type ComposioSetupConfig,
  type ComposioMcpResult,
} from "./session";

// =============================================================================
// AUTH EXPORTS (for app UI)
// =============================================================================

export {
  getAuthUrl,
  getStatus,
  getConnections,
  composioHelpers,
  type ComposioAuthResult,
  type ComposioConnectionStatus,
} from "./auth";

// =============================================================================
// INTERNAL TYPES (for advanced use cases)
// =============================================================================

export type {
  ToolRouterSession,
  ConnectionRequest,
  ConnectedAccount,
  ToolkitList,
  ToolkitInfo,
  SessionCreateOptions,
} from "./types";
