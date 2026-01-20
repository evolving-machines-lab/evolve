/**
 * Composio Session Management
 *
 * Creates Tool Router sessions using the Composio SDK.
 * Evidence: tool-router/quickstart.mdx, tool-router/using-with-mcp-clients.mdx
 */

import { Composio, AuthScheme } from "@composio/core";
import type { ComposioConfig } from "../types";
import type { ToolRouterSession, SessionCreateOptions } from "./types";

// =============================================================================
// CONSTANTS & HELPERS
// =============================================================================

/** Environment variable for Composio API key */
export const COMPOSIO_API_KEY_ENV = "COMPOSIO_API_KEY";

/** Factory for Composio client (DRY - single instantiation pattern) */
function getComposioClient(apiKey?: string): Composio {
  return new Composio({
    apiKey: apiKey ?? process.env[COMPOSIO_API_KEY_ENV],
  });
}

/** Validate userId is non-empty */
function validateUserId(userId: string): void {
  if (!userId?.trim()) {
    throw new Error("userId is required and cannot be empty");
  }
}

// =============================================================================
// SESSION CREATION
// =============================================================================

/**
 * Create a Tool Router session for a user
 *
 * @param userId - User's unique identifier
 * @param options - Session configuration options
 * @param apiKey - Optional API key (defaults to COMPOSIO_API_KEY env var)
 * @returns Tool Router session with MCP config
 *
 * @example
 * const session = await createSession("user_123");
 * console.log(session.mcp.url);  // MCP server URL
 */
export async function createSession(
  userId: string,
  options?: SessionCreateOptions,
  apiKey?: string
): Promise<ToolRouterSession> {
  validateUserId(userId);

  const composio = getComposioClient(apiKey);

  // Build session options - only include defined values
  const sessionOptions: Record<string, unknown> = {};
  if (options?.toolkits) sessionOptions.toolkits = options.toolkits;
  if (options?.tools) sessionOptions.tools = options.tools;
  if (options?.authConfigs) sessionOptions.authConfigs = options.authConfigs;
  if (options?.connectedAccounts) sessionOptions.connectedAccounts = options.connectedAccounts;
  if (options?.manageConnections !== undefined) sessionOptions.manageConnections = options.manageConnections;

  // Create Tool Router session
  const session = await composio.create(
    userId,
    Object.keys(sessionOptions).length > 0 ? sessionOptions : undefined
  );

  // SDK returns compatible but differently-typed object
  return session as unknown as ToolRouterSession;
}

// =============================================================================
// API KEY CONNECTIONS
// =============================================================================

/**
 * Create a connection using an API key
 *
 * @param userId - User's unique identifier
 * @param toolkit - Toolkit slug (e.g., "stripe", "openai")
 * @param apiKeyValue - The API key to use for authentication
 * @param composioApiKey - Optional Composio API key
 *
 * @example
 * await createApiKeyConnection("user_123", "stripe", "sk_live_...");
 */
export async function createApiKeyConnection(
  userId: string,
  toolkit: string,
  apiKeyValue: string,
  composioApiKey?: string
): Promise<void> {
  validateUserId(userId);

  const composio = getComposioClient(composioApiKey);
  const toolkitInfo = await composio.toolkits.get(toolkit);

  // Find API_KEY auth config via 'mode' field
  const authConfigDetails = toolkitInfo.authConfigDetails as Array<{ name: string; mode: string }> | undefined;
  const apiKeyConfig = authConfigDetails?.find((c) => c.mode === "API_KEY");

  if (!apiKeyConfig) {
    throw new Error(
      `Toolkit "${toolkit}" does not support API key authentication. ` +
      `Get an OAuth URL via Evolve.composio.auth() instead.`
    );
  }

  await composio.connectedAccounts.initiate(userId, apiKeyConfig.name, {
    config: AuthScheme.APIKey({ api_key: apiKeyValue }),
  });
}

// =============================================================================
// SETUP COMPOSIO (main entry point for agent setup)
// =============================================================================

/**
 * Configuration for Composio setup (extends public config with internal options)
 */
export interface ComposioSetupConfig extends ComposioConfig {
  /** Specific connected account IDs to use (internal) */
  connectedAccounts?: Record<string, string>;
  /** Enable in-chat auth prompts (default: true) */
  manageConnections?: boolean;
}

/**
 * MCP configuration returned by setupComposio
 */
export interface ComposioMcpResult {
  url: string;
  headers: Record<string, string>;
}

/**
 * Setup Composio for an agent
 *
 * @param userId - User's unique identifier
 * @param config - Optional configuration
 * @returns MCP server config to add to agent's mcpServers
 *
 * @example
 * const mcp = await setupComposio("user_123", {
 *   toolkits: ["github", "stripe"],
 *   keys: { stripe: "sk_live_..." }
 * });
 */
export async function setupComposio(
  userId: string,
  config?: ComposioSetupConfig
): Promise<ComposioMcpResult> {
  validateUserId(userId);

  // Handle API key connections first (sequential for clear error messages)
  if (config?.keys) {
    for (const [toolkit, keyValue] of Object.entries(config.keys)) {
      try {
        await createApiKeyConnection(userId, toolkit, keyValue);
      } catch (error) {
        throw new Error(
          `Failed to create API key connection for "${toolkit}": ${(error as Error).message}`
        );
      }
    }
  }

  // Create session with config (createSession handles the options mapping)
  const session = await createSession(userId, {
    toolkits: config?.toolkits,
    tools: config?.tools,
    authConfigs: config?.authConfigs,
    connectedAccounts: config?.connectedAccounts,
    manageConnections: config?.manageConnections,
  });

  return {
    url: session.mcp.url,
    headers: session.mcp.headers,
  };
}
