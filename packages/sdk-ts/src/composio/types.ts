/**
 * Composio Internal Types
 *
 * Internal types for Composio SDK integration.
 * Public types are exported from ../types.ts
 */

import type { ToolsFilter } from "../types";

// =============================================================================
// SESSION TYPES (from Composio SDK)
// =============================================================================

/**
 * Tool Router session returned by composio.create()
 * Evidence: tool-router/quickstart.mdx, tool-router/using-with-mcp-clients.mdx
 */
export interface ToolRouterSession {
  /** MCP server configuration */
  mcp: {
    /** MCP server URL */
    url: string;
    /** Authentication headers */
    headers: Record<string, string>;
  };
  /** Authorize a toolkit for manual auth flow */
  authorize(toolkit: string): Promise<ConnectionRequest>;
  /** Get all toolkits with connection status */
  toolkits(): Promise<ToolkitList>;
}

/**
 * Connection request returned by session.authorize()
 * Evidence: tool-router/manually-authenticating-users.mdx
 */
export interface ConnectionRequest {
  /** OAuth/Connect Link URL to redirect user to */
  redirectUrl: string;
  /** Connection request ID */
  id: string;
  /** Wait for user to complete authentication */
  waitForConnection(timeoutMs?: number): Promise<ConnectedAccount>;
}

/**
 * Connected account after successful auth
 * Evidence: reference/sdk-reference/typescript/connected-accounts.mdx
 */
export interface ConnectedAccount {
  /** Unique identifier */
  id: string;
  /** Connection status */
  status: "ACTIVE" | "INITIATED" | "FAILED" | "EXPIRED";
  /** Toolkit information */
  toolkit: {
    slug: string;
    name: string;
  };
}

/**
 * Toolkit list returned by session.toolkits()
 * Evidence: tool-router/manually-authenticating-users.mdx
 */
export interface ToolkitList {
  items: ToolkitInfo[];
}

/**
 * Individual toolkit with connection status
 * Evidence: tool-router/manually-authenticating-users.mdx
 */
export interface ToolkitInfo {
  /** Toolkit slug (e.g., "github", "gmail") */
  slug: string;
  /** Display name */
  name: string;
  /** Connection status for this user */
  connection: {
    /** Whether user has active connection */
    isActive: boolean;
    /** Connected account if active */
    connectedAccount?: {
      id: string;
    };
  };
}

// =============================================================================
// SESSION CREATE OPTIONS
// =============================================================================

/**
 * Options for composio.create()
 * Evidence: tool-router/users-and-sessions.mdx, tool-router/using-in-chat-authentication.mdx
 */
export interface SessionCreateOptions {
  /** Restrict to specific toolkits */
  toolkits?: string[];
  /** Per-toolkit tool filtering */
  tools?: Record<string, ToolsFilter>;
  /** Custom auth config IDs for white-labeling */
  authConfigs?: Record<string, string>;
  /** Specific connected account IDs to use */
  connectedAccounts?: Record<string, string>;
  /**
   * Enable in-chat auth prompts (default: true)
   * Set to false to handle auth entirely in your UI
   */
  manageConnections?: boolean | { callbackUri?: string };
}

