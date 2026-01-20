/**
 * Composio Auth Helpers
 *
 * Helper functions for managing Composio authentication in your app's UI.
 * Evidence: tool-router/manually-authenticating-users.mdx
 */

import { Composio } from "@composio/core";
import { createSession, COMPOSIO_API_KEY_ENV } from "./session";

// =============================================================================
// PUBLIC TYPES
// =============================================================================

/**
 * Result from getAuthUrl()
 */
export interface ComposioAuthResult {
  /** OAuth/Connect Link URL to redirect user to */
  url: string;
  /** Connection request ID for tracking */
  connectionId: string;
}

/**
 * Connection status for a toolkit
 */
export interface ComposioConnectionStatus {
  /** Toolkit slug (e.g., "github", "gmail") */
  toolkit: string;
  /** Whether the user has an active connection */
  connected: boolean;
  /** Connected account ID if connected */
  accountId?: string;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Validate userId is non-empty */
function validateUserId(userId: string): void {
  if (!userId?.trim()) {
    throw new Error("userId is required and cannot be empty");
  }
}

/** Factory for Composio client */
function getComposioClient(): Composio {
  return new Composio({
    apiKey: process.env[COMPOSIO_API_KEY_ENV],
  });
}

// =============================================================================
// AUTH URL
// =============================================================================

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
export async function getAuthUrl(
  userId: string,
  toolkit: string
): Promise<ComposioAuthResult> {
  validateUserId(userId);

  const session = await createSession(userId, {
    manageConnections: false, // Disable in-chat auth for manual flow
  });

  const connectionRequest = await session.authorize(toolkit);

  return {
    url: connectionRequest.redirectUrl,
    connectionId: connectionRequest.id,
  };
}

// =============================================================================
// CONNECTION STATUS
// =============================================================================

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
export async function getStatus(
  userId: string,
  toolkit?: string
): Promise<Record<string, boolean> | boolean> {
  const connections = await getConnections(userId);

  const statusMap: Record<string, boolean> = {};
  for (const conn of connections) {
    statusMap[conn.toolkit] = conn.connected;
  }

  if (toolkit) {
    return statusMap[toolkit] ?? false;
  }

  return statusMap;
}

// =============================================================================
// DETAILED CONNECTIONS
// =============================================================================

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
export async function getConnections(
  userId: string
): Promise<ComposioConnectionStatus[]> {
  validateUserId(userId);

  const composio = getComposioClient();
  const accounts = await composio.connectedAccounts.list({
    userIds: [userId],
    statuses: ["ACTIVE"],
  });

  return accounts.items.map((account) => ({
    toolkit: account.toolkit.slug,
    connected: account.status === "ACTIVE",
    accountId: account.id,
  }));
}

// =============================================================================
// STATIC HELPERS OBJECT
// =============================================================================

/**
 * Static helpers for Composio auth management
 *
 * Access via Evolve.composio.*
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
export const composioHelpers = {
  /** Get OAuth URL for user to connect a toolkit */
  auth: getAuthUrl,

  /** Get connection status for a user */
  status: getStatus,

  /** Get detailed connection info */
  connections: getConnections,
};
