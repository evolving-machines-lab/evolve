/**
 * MCP JSON Configuration Writer
 *
 * Handles MCP config for Claude, Gemini, Qwen, and Kimi agents.
 * Uses registry for paths - no hardcoded values.
 *
 * Transport formats by agent:
 * - Claude: { type: "http"|"sse"|"stdio", url: "..." }
 * - Gemini: { url: "...", type: "http"|"sse" } | { command: "..." }
 * - Qwen:   { httpUrl: "..." } | { url: "..." } | { command: "..." }
 * - Kimi:   { url: "...", transport?: "http"|"sse" } | { command: "...", transport: "stdio" }
 */

import type { SandboxInstance, McpServerConfig } from "../types";
import { getMcpSettingsDir, getMcpSettingsPath } from "../registry";
import { validateServers, isNotFoundError } from "./validation";

// =============================================================================
// FORMAT TRANSFORMERS
// =============================================================================

/**
 * Detect transport type from config
 */
function detectTransport(config: McpServerConfig): "stdio" | "sse" | "http" {
  if (config.type) return config.type;
  if (config.command) return "stdio";
  return "sse";
}

/**
 * Transform to Gemini format
 *
 * Gemini prefers url + type (httpUrl is deprecated):
 * - { url: "...", type: "http" } → HTTP
 * - { url: "...", type: "sse" } → SSE
 * - { command: "..." } → stdio
 */
function toGeminiFormat(config: McpServerConfig): Record<string, unknown> {
  const transport = detectTransport(config);
  return { ...config, type: transport };
}

/**
 * Transform to Qwen format
 *
 * Qwen infers transport from field name (no type support):
 * - { httpUrl: "..." } → HTTP
 * - { url: "..." } → SSE
 * - { command: "..." } → stdio
 */
function toQwenFormat(config: McpServerConfig): Record<string, unknown> {
  const { type, url, ...rest } = config;
  const transport = detectTransport(config);

  if (transport === "http" && url) {
    return { httpUrl: url, ...rest };
  }
  return url ? { url, ...rest } : rest;
}

/**
 * Transform to type format (Claude)
 *
 * Claude uses explicit type field: { type: "http"|"sse"|"stdio", ... }
 */
function toTypeFormat(config: McpServerConfig): Record<string, unknown> {
  return { type: detectTransport(config), ...config };
}

/**
 * Transform to Kimi/FastMCP format
 *
 * Kimi validates config via FastMCP's MCPConfig:
 * - Remote servers use `transport: "http" | "sse"` (optional; inferred from URL when omitted)
 * - Stdio servers use `transport: "stdio"` (optional but explicit is clearer)
 */
function toKimiFormat(config: McpServerConfig): Record<string, unknown> {
  const { type, ...rest } = config;

  if (rest.command) {
    return { ...rest, transport: "stdio" };
  }

  if (rest.url) {
    if (type === "http" || type === "sse") {
      return { ...rest, transport: type };
    }
    // Let FastMCP infer transport from URL when type is omitted.
    return rest;
  }

  return rest;
}

// =============================================================================
// GENERIC JSON WRITER
// =============================================================================

type ConfigTransformer = (config: McpServerConfig) => Record<string, unknown>;

async function writeJsonMcpConfig(
  sandbox: SandboxInstance,
  agentType: "gemini" | "qwen" | "kimi",
  servers: Record<string, McpServerConfig>,
  transform: ConfigTransformer
): Promise<void> {
  validateServers(servers);

  const settingsDir = getMcpSettingsDir(agentType);
  const settingsPath = getMcpSettingsPath(agentType);

  await sandbox.files.makeDir(settingsDir);

  let existingConfig: Record<string, unknown> = {};
  try {
    const existing = await sandbox.files.read(settingsPath);
    if (typeof existing === "string") {
      existingConfig = JSON.parse(existing);
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  const transformedServers = Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [name, transform(config)])
  );

  await sandbox.files.write(
    settingsPath,
    JSON.stringify({ ...existingConfig, mcpServers: transformedServers }, null, 2)
  );
}

// =============================================================================
// CLAUDE MCP CONFIG
// =============================================================================

/**
 * Write MCP config for Claude agent
 *
 * Claude uses two files:
 * 1. ${workingDir}/.mcp.json - project-level MCP servers
 * 2. ~/.claude/settings.json - enable project MCP servers
 */
export async function writeClaudeMcpConfig(
  sandbox: SandboxInstance,
  workingDir: string,
  servers: Record<string, McpServerConfig>
): Promise<void> {
  validateServers(servers);

  const settingsDir = getMcpSettingsDir("claude");
  const settingsPath = getMcpSettingsPath("claude");

  // Transform to type format
  const transformedServers = Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [name, toTypeFormat(config)])
  );

  // Write .mcp.json to workspace
  await sandbox.files.write(
    `${workingDir}/.mcp.json`,
    JSON.stringify({ mcpServers: transformedServers }, null, 2)
  );

  // Enable project MCP servers in settings
  await sandbox.files.makeDir(settingsDir);

  let settings: Record<string, unknown> = {};
  try {
    const existing = await sandbox.files.read(settingsPath);
    if (typeof existing === "string") {
      settings = JSON.parse(existing);
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  settings.enableAllProjectMcpServers = true;
  await sandbox.files.write(settingsPath, JSON.stringify(settings, null, 2));
}

// =============================================================================
// GEMINI & QWEN MCP CONFIG
// =============================================================================

/** Write MCP config for Gemini agent */
export async function writeGeminiMcpConfig(
  sandbox: SandboxInstance,
  servers: Record<string, McpServerConfig>
): Promise<void> {
  await writeJsonMcpConfig(sandbox, "gemini", servers, toGeminiFormat);
}

/** Write MCP config for Qwen agent */
export async function writeQwenMcpConfig(
  sandbox: SandboxInstance,
  servers: Record<string, McpServerConfig>
): Promise<void> {
  await writeJsonMcpConfig(sandbox, "qwen", servers, toQwenFormat);
}

/** Write MCP config for Kimi agent (FastMCP-compatible transport field) */
export async function writeKimiMcpConfig(
  sandbox: SandboxInstance,
  servers: Record<string, McpServerConfig>
): Promise<void> {
  await writeJsonMcpConfig(sandbox, "kimi", servers, toKimiFormat);
}

/**
 * Write MCP config for OpenCode agent
 *
 * OpenCode uses opencode.json in the working directory with an `mcp` key.
 * Format: { "mcp": { "name": { "type": "local"|"remote", "command": [...], "url": "..." } } }
 *
 * Key differences from other agents:
 * - Uses `mcp` key (not `mcpServers`)
 * - Local servers use `command` as array (not string)
 * - Remote servers use `type: "remote"` with `url`
 */
export async function writeOpenCodeMcpConfig(
  sandbox: SandboxInstance,
  workingDir: string,
  servers: Record<string, McpServerConfig>
): Promise<void> {
  validateServers(servers);

  const configPath = `${workingDir}/opencode.json`;

  let existingConfig: Record<string, unknown> = {};
  try {
    const existing = await sandbox.files.read(configPath);
    if (typeof existing === "string") {
      existingConfig = JSON.parse(existing);
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  const mcpServers = Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [name, toOpenCodeFormat(config)])
  );

  await sandbox.files.write(
    configPath,
    JSON.stringify({ ...existingConfig, mcp: mcpServers }, null, 2)
  );
}

/**
 * Transform to OpenCode MCP format
 *
 * - stdio: { type: "local", command: ["cmd", ...args], environment: { ... } }
 * - remote: { type: "remote", url: "...", headers: { ... } }
 */
function toOpenCodeFormat(config: McpServerConfig): Record<string, unknown> {
  const transport = detectTransport(config);

  if (transport === "stdio" && config.command) {
    const command = config.args
      ? [config.command, ...config.args]
      : [config.command];
    const result: Record<string, unknown> = { type: "local", command };
    if (config.env && Object.keys(config.env).length > 0) {
      result.environment = config.env;
    }
    return result;
  }

  // SSE/HTTP → remote
  if (config.url) {
    const result: Record<string, unknown> = { type: "remote", url: config.url };
    if (config.headers && Object.keys(config.headers).length > 0) {
      result.headers = config.headers;
    }
    return result;
  }

  // Fallback: pass through with type
  return { type: transport === "stdio" ? "local" : "remote", ...config };
}
