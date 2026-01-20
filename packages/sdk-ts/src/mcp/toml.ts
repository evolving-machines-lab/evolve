/**
 * MCP TOML Configuration Writer
 *
 * Handles MCP config for Codex agent which uses TOML format.
 * Uses registry for paths - no hardcoded values.
 */

import type { SandboxInstance, McpServerConfig } from "../types";
import { getMcpSettingsDir, getMcpSettingsPath } from "../registry";
import { validateMcpServer, isNotFoundError } from "./validation";

// =============================================================================
// TOML SERIALIZATION
// =============================================================================

/**
 * Serialize a value to TOML format
 */
function serializeTomlValue(value: unknown): string {
  if (typeof value === "string") {
    // Escape backslashes and double quotes
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => serializeTomlValue(v)).join(", ")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const pairs = Object.entries(value).map(
      ([k, v]) => `${k} = ${serializeTomlValue(v)}`
    );
    return `{ ${pairs.join(", ")} }`;
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  return String(value);
}

// =============================================================================
// CODEX MCP CONFIG
// =============================================================================

/**
 * Write MCP config for Codex agent
 *
 * Codex stores MCP config in ~/.codex/config.toml using TOML format.
 * Format: [mcp_servers.server_name] sections
 */
export async function writeCodexMcpConfig(
  sandbox: SandboxInstance,
  servers: Record<string, McpServerConfig>
): Promise<void> {
  // Validate all servers
  for (const [name, config] of Object.entries(servers)) {
    validateMcpServer(name, config);
  }

  const settingsDir = getMcpSettingsDir("codex");
  const settingsPath = getMcpSettingsPath("codex");

  // Ensure settings directory exists
  await sandbox.files.makeDir(settingsDir);

  // Read existing config to preserve other settings
  let existingToml = "";
  try {
    const existing = await sandbox.files.read(settingsPath);
    if (typeof existing === "string") {
      existingToml = existing;
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error; // Re-throw unexpected errors (permissions, encoding, etc.)
    }
    // File doesn't exist yet - expected on first run
  }

  // Build config sections
  const globalConfigLines: string[] = [];
  const mcpTomlLines: string[] = [];

  // Add experimental_use_rmcp_client flag if not present
  if (!existingToml.includes("experimental_use_rmcp_client")) {
    globalConfigLines.push("# Enable improved RMCP client (recommended)");
    globalConfigLines.push("experimental_use_rmcp_client = true");
  }

  // Add [mcp_servers] section header if not present
  if (!existingToml.includes("[mcp_servers]")) {
    mcpTomlLines.push("[mcp_servers]", "");
  }

  // Generate server sections
  for (const [name, config] of Object.entries(servers)) {
    // Skip if server already exists
    if (existingToml.includes(`[mcp_servers.${name}]`)) {
      continue;
    }

    mcpTomlLines.push(`[mcp_servers.${name}]`);

    const transportType = config.type ?? (config.command ? "stdio" : "http");
    const isStreamable = transportType === "http" || transportType === "sse" || Boolean(config.url);

    if (isStreamable) {
      // HTTP/SSE transport
      if (!config.url) {
        throw new Error(`MCP server "${name}" is missing url for ${transportType} transport`);
      }
      mcpTomlLines.push(`url = ${serializeTomlValue(config.url)}`);

      // Bearer token from env var
      if (config.bearerTokenEnvVar) {
        mcpTomlLines.push(`bearer_token_env_var = ${serializeTomlValue(config.bearerTokenEnvVar)}`);
      }

      // HTTP headers (prefer httpHeaders, fallback to headers)
      const httpHeaders = config.httpHeaders ?? config.headers;
      if (httpHeaders && Object.keys(httpHeaders).length > 0) {
        mcpTomlLines.push(`http_headers = ${serializeTomlValue(httpHeaders)}`);
      }

      // Environment-based HTTP headers
      if (config.envHttpHeaders && Object.keys(config.envHttpHeaders).length > 0) {
        mcpTomlLines.push(`env_http_headers = ${serializeTomlValue(config.envHttpHeaders)}`);
      }
    } else {
      // STDIO transport
      mcpTomlLines.push(`command = ${serializeTomlValue(config.command!)}`);
      if (config.args && config.args.length > 0) {
        mcpTomlLines.push(`args = ${serializeTomlValue(config.args)}`);
      }
      if (config.cwd) {
        mcpTomlLines.push(`cwd = ${serializeTomlValue(config.cwd)}`);
      }
    }

    // Common env vars (key=value)
    if (config.env && Object.keys(config.env).length > 0) {
      mcpTomlLines.push(`env = ${serializeTomlValue(config.env)}`);
    }

    // Environment variable names to pass through
    if (config.envVars && config.envVars.length > 0) {
      mcpTomlLines.push(`env_vars = ${serializeTomlValue(config.envVars)}`);
    }

    mcpTomlLines.push(""); // Empty line between servers
  }

  // Combine all segments
  const segments = [
    existingToml.trim(),
    globalConfigLines.join("\n"),
    mcpTomlLines.join("\n"),
  ].filter((segment) => segment.length > 0);

  await sandbox.files.write(settingsPath, segments.join("\n\n") + "\n");
}
