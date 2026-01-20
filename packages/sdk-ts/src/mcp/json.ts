/**
 * MCP JSON Configuration Writer
 *
 * Handles MCP config for Claude, Gemini, and Qwen agents.
 * Uses registry for paths - no hardcoded values.
 *
 * Transport formats by agent:
 * - Claude: { type: "http"|"sse"|"stdio", url: "..." }
 * - Gemini: { url: "...", type: "http"|"sse" } | { command: "..." }
 * - Qwen:   { httpUrl: "..." } | { url: "..." } | { command: "..." }
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

// =============================================================================
// GENERIC JSON WRITER
// =============================================================================

type ConfigTransformer = (config: McpServerConfig) => Record<string, unknown>;

async function writeJsonMcpConfig(
  sandbox: SandboxInstance,
  agentType: "gemini" | "qwen",
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
