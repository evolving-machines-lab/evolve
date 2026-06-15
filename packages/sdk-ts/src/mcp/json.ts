/**
 * MCP JSON Configuration Writer
 *
 * Handles MCP config for Claude, Gemini, Qwen, Kimi, Droid, and OpenCode agents.
 * Uses registry for paths - no hardcoded values.
 *
 * Transport formats by agent:
 * - Claude: { type: "http"|"sse"|"stdio", url: "..." }
 * - Gemini: { url: "...", type: "http"|"sse" } | { command: "..." }
 * - Qwen:   { httpUrl: "..." } | { url: "..." } | { command: "..." }
 * - Kimi Code: { url: "...", transport?: "http"|"sse" } | { command: "...", transport: "stdio" }
 */

import type { SandboxInstance, McpServerConfig } from "../types";
import { expandPath, getMcpSettingsDir, getMcpSettingsPath } from "../registry";
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
 * Transform to Kimi Code MCP format
 *
 * Kimi Code validates config via its MCPConfig loader:
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

/**
 * Transform to Droid MCP format
 *
 * Droid uses .factory/mcp.json:
 * - Remote servers use `{ type: "http" | "sse", url, headers }`
 * - Stdio servers use `{ type: "stdio", command, args, env }`
 */
function toDroidFormat(config: McpServerConfig): Record<string, unknown> {
  const transport = detectTransport(config);
  const { type, httpHeaders, envHttpHeaders, bearerTokenEnvVar, envVars, ...rest } = config;

  if (transport === "stdio" && config.command) {
    return { type: "stdio", ...rest };
  }

  if (config.url) {
    const result: Record<string, unknown> = {
      ...rest,
      type: transport === "sse" ? "sse" : "http",
      url: config.url,
    };
    const headers = config.headers ?? httpHeaders;
    if (headers && Object.keys(headers).length > 0) {
      result.headers = headers;
    }
    return result;
  }

  return { type: transport === "stdio" ? "stdio" : "http", ...rest };
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

// =============================================================================
// JSON SPEND TRACKING (Qwen-style: customHeaders in settings.json)
// =============================================================================

/**
 * Write spend tracking headers to a JSON settings file.
 *
 * Sets headers at the specified dot-path (e.g., "model.generationConfig.customHeaders")
 * within the agent's existing settings.json. Preserves all other config (MCP, etc.).
 *
 * Used for CLIs that read custom HTTP headers from a JSON config file
 * rather than environment variables (e.g., Qwen).
 */
export async function writeJsonSpendHeaders(
  sandbox: SandboxInstance,
  agentType: "qwen",
  headersPath: string,
  headers: Record<string, string>,
): Promise<void> {
  const settingsDir = getMcpSettingsDir(agentType);
  const settingsPath = getMcpSettingsPath(agentType);

  await sandbox.files.makeDir(settingsDir);

  let config: Record<string, unknown> = {};
  try {
    const existing = await sandbox.files.read(settingsPath);
    if (typeof existing === "string") {
      config = JSON.parse(existing);
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  // Walk the dot-path and merge headers (preserves user-supplied non-spend headers)
  const parts = headersPath.split(".");
  let current: Record<string, unknown> = config;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (typeof current[key] !== "object" || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  const existing = (typeof current[leaf] === "object" && current[leaf] !== null)
    ? current[leaf] as Record<string, string>
    : {};
  current[leaf] = { ...existing, ...headers };

  await sandbox.files.write(settingsPath, JSON.stringify(config, null, 2));
}

export async function writeQwenThinkingConfig(
  sandbox: SandboxInstance,
  enableThinking: boolean,
): Promise<void> {
  const settingsDir = getMcpSettingsDir("qwen");
  const settingsPath = getMcpSettingsPath("qwen");

  await sandbox.files.makeDir(settingsDir);

  let config: Record<string, unknown> = {};
  try {
    const existing = await sandbox.files.read(settingsPath);
    if (typeof existing === "string") {
      config = JSON.parse(existing);
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  const model = (config.model as Record<string, unknown>) ?? {};
  const generationConfig = (model.generationConfig as Record<string, unknown>) ?? {};
  const extraBody = (generationConfig.extra_body as Record<string, unknown>) ?? {};

  config.model = {
    ...model,
    generationConfig: {
      ...generationConfig,
      extra_body: {
        ...extraBody,
        enable_thinking: enableThinking,
      },
    },
  };

  await sandbox.files.write(settingsPath, JSON.stringify(config, null, 2));
}

/** Write MCP config for Kimi agent (FastMCP-compatible transport field) */
export async function writeKimiMcpConfig(
  sandbox: SandboxInstance,
  servers: Record<string, McpServerConfig>
): Promise<void> {
  await writeJsonMcpConfig(sandbox, "kimi", servers, toKimiFormat);
}

/**
 * Write MCP config for Droid agent
 *
 * Droid supports project-level `.factory/mcp.json`, which keeps MCP config
 * scoped to the sandbox workspace instead of mutating global user config.
 */
export async function writeDroidMcpConfig(
  sandbox: SandboxInstance,
  workingDir: string,
  servers: Record<string, McpServerConfig>
): Promise<void> {
  validateServers(servers);

  const settingsDir = `${workingDir}/.factory`;
  const settingsPath = `${settingsDir}/mcp.json`;

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
    Object.entries(servers).map(([name, config]) => [name, toDroidFormat(config)])
  );

  await sandbox.files.write(
    settingsPath,
    JSON.stringify({ ...existingConfig, mcpServers: transformedServers }, null, 2)
  );
}

export interface DroidGatewaySettingsConfig {
  settingsPath: string;
  displayName: string;
  model: string;
  baseUrl: string;
  apiKeyEnv: string;
  provider: "generic-chat-completion-api" | "openai" | "anthropic";
  maxOutputTokens?: number;
}

/**
 * Write an Evolve-owned Droid settings file for gateway custom-model routing.
 *
 * The command passes this file with `droid --settings`, so it does not alter the
 * user's normal ~/.factory/settings.json inside the sandbox.
 */
export async function writeDroidGatewaySettings(
  sandbox: SandboxInstance,
  config: DroidGatewaySettingsConfig,
  headers: Record<string, string>,
): Promise<void> {
  const settingsPath = expandPath(config.settingsPath);
  const settingsDir = settingsPath.slice(0, settingsPath.lastIndexOf("/"));

  await sandbox.files.makeDir(settingsDir);

  const content = {
    cloudSessionSync: false,
    customModels: [
      {
        model: config.model,
        displayName: config.displayName,
        baseUrl: config.baseUrl,
        apiKey: `\${${config.apiKeyEnv}}`,
        provider: config.provider,
        ...(config.maxOutputTokens !== undefined && { maxOutputTokens: config.maxOutputTokens }),
        extraHeaders: headers,
      },
    ],
  };

  await sandbox.files.write(settingsPath, JSON.stringify(content, null, 2));
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
