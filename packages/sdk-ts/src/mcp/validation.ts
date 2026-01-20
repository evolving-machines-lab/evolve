/**
 * MCP Validation Utilities
 *
 * Shared validation for MCP server configurations.
 */

import type { McpServerConfig } from "../types";

/**
 * Check if an error indicates "file not found"
 * Works across different sandbox providers
 */
export function isNotFoundError(error: unknown): boolean {
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    return msg.includes("not found") || msg.includes("enoent") || msg.includes("no such file") || msg.includes("does not exist");
  }
  return false;
}

/**
 * Validate MCP server config has exactly one transport type
 */
export function validateMcpServer(name: string, config: McpServerConfig): void {
  const transports = [config.command, config.url].filter(Boolean);
  if (transports.length === 0) {
    throw new Error(`MCP server "${name}" must specify command or url`);
  }
  if (transports.length > 1) {
    throw new Error(`MCP server "${name}" cannot specify both command and url`);
  }
}

/**
 * Validate all servers in a config
 */
export function validateServers(servers: Record<string, McpServerConfig>): void {
  for (const [name, config] of Object.entries(servers)) {
    validateMcpServer(name, config);
  }
}
