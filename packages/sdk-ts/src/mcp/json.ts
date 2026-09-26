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
  transform: ConfigTransformer,
  homeDir?: string
): Promise<void> {
  validateServers(servers);

  const settingsDir = getMcpSettingsDir(agentType, homeDir);
  const settingsPath = getMcpSettingsPath(agentType, homeDir);

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
  servers: Record<string, McpServerConfig>,
  homeDir?: string
): Promise<void> {
  validateServers(servers);

  const settingsDir = getMcpSettingsDir("claude", homeDir);
  const settingsPath = getMcpSettingsPath("claude", homeDir);

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
  servers: Record<string, McpServerConfig>,
  homeDir?: string
): Promise<void> {
  await writeJsonMcpConfig(sandbox, "gemini", servers, toGeminiFormat, homeDir);
}

/** Write MCP config for Qwen agent */
export async function writeQwenMcpConfig(
  sandbox: SandboxInstance,
  servers: Record<string, McpServerConfig>,
  homeDir?: string
): Promise<void> {
  await writeJsonMcpConfig(sandbox, "qwen", servers, toQwenFormat, homeDir);
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
  homeDir?: string,
): Promise<void> {
  const settingsDir = getMcpSettingsDir(agentType, homeDir);
  const settingsPath = getMcpSettingsPath(agentType, homeDir);

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
  homeDir?: string,
): Promise<void> {
  const settingsDir = getMcpSettingsDir("qwen", homeDir);
  const settingsPath = getMcpSettingsPath("qwen", homeDir);

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
  servers: Record<string, McpServerConfig>,
  homeDir?: string
): Promise<void> {
  await writeJsonMcpConfig(sandbox, "kimi", servers, toKimiFormat, homeDir);
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
  homeDir?: string,
): Promise<void> {
  const settingsPath = expandPath(config.settingsPath, homeDir);
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

// =============================================================================
// THE PI FAMILY (pi, Prime Agent): models.json route, MCP, settings stamp
// =============================================================================

/**
 * Transform to pi-mcp-adapter format (nicobailon/pi-mcp-adapter 2.37.0 README):
 * a stdio server is `{ command, args?, cwd?, env? }`, a remote one `{ url,
 * headers? }` — the adapter speaks streamable HTTP with SSE fallback on any
 * `url`, so both SDK transports collapse onto it.
 */
function toPiMcpFormat(config: McpServerConfig): Record<string, unknown> {
  const transport = detectTransport(config);
  if (transport === "stdio" && config.command) {
    const result: Record<string, unknown> = { command: config.command };
    if (config.args && config.args.length > 0) result.args = config.args;
    if (config.cwd) result.cwd = config.cwd;
    if (config.env && Object.keys(config.env).length > 0) result.env = config.env;
    return result;
  }
  const result: Record<string, unknown> = { url: config.url };
  const headers = config.headers ?? config.httpHeaders;
  if (headers && Object.keys(headers).length > 0) result.headers = headers;
  return result;
}

/**
 * The adapter settings the SDK pins in pi's mcp.json: no host-config
 * discovery (the adapter would otherwise also read ~/.config/mcp/mcp.json,
 * ~/.agents/mcp.json and the project's .mcp.json — Harbor pi.py:290-294
 * pins the same three), no startup notification, no script mode.
 */
export const PI_MCP_ADAPTER_SETTINGS = {
  hostConfigDiscovery: "off",
  notifyOnStartupConnect: false,
  scriptMode: false,
} as const;

/**
 * Write MCP config for pi: `<agent-dir>/mcp.json`, read by the pi-mcp-adapter
 * extension the command loads whenever this file exists (registry.ts pi
 * buildCommand). pi's own core has no MCP.
 */
export async function writePiMcpConfig(
  sandbox: SandboxInstance,
  servers: Record<string, McpServerConfig>,
  homeDir?: string
): Promise<void> {
  validateServers(servers);

  const settingsDir = getMcpSettingsDir("pi", homeDir);
  const settingsPath = getMcpSettingsPath("pi", homeDir);

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

  const existingSettings =
    typeof existingConfig.settings === "object" && existingConfig.settings !== null
      ? (existingConfig.settings as Record<string, unknown>)
      : {};
  const transformedServers = Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [name, toPiMcpFormat(config)])
  );

  await sandbox.files.write(
    settingsPath,
    JSON.stringify(
      {
        ...existingConfig,
        settings: { ...existingSettings, ...PI_MCP_ADAPTER_SETTINGS },
        mcpServers: transformedServers,
      },
      null,
      2
    )
  );
}

/**
 * Transform to Prime Agent's settings.json `mcpServers` shape
 * (settings-manager.ts McpServerConfig, v0.9.6): `{ type: "http", url,
 * headers?, bearerTokenEnvVar? }` or `{ type: "stdio", command, args?, cwd?,
 * env? }`. Two honesty rules from that type:
 *   - Prime has no SSE transport; a server declared `sse` is written as
 *     `http` (its client speaks streamable HTTP), which an SSE-only server
 *     will refuse at connect — the closest thing Prime can be told.
 *   - a stdio server's `env` is `Record<name, { env: hostVarName }>`:
 *     references into the kernel's environment, never literal values, so a
 *     literal SDK `env` is refused typed rather than silently dropped. The
 *     SDK's `envVars` (names to pass through) is exactly that shape.
 */
function toPrimeAgentMcpFormat(name: string, config: McpServerConfig): Record<string, unknown> {
  const transport = detectTransport(config);
  if (transport === "stdio" && config.command) {
    if (config.env && Object.keys(config.env).length > 0) {
      throw new Error(
        `MCP server "${name}": Prime Agent passes a stdio server's env only as references to the sandbox ` +
          `environment (its settings.json takes { env: NAME }, never literal values). Set the values in ` +
          `the sandbox environment and name them with envVars instead of env.`,
      );
    }
    const result: Record<string, unknown> = { type: "stdio", command: config.command };
    if (config.args && config.args.length > 0) result.args = config.args;
    if (config.cwd) result.cwd = config.cwd;
    if (config.envVars && config.envVars.length > 0) {
      result.env = Object.fromEntries(config.envVars.map((envName) => [envName, { env: envName }]));
    }
    return result;
  }
  const result: Record<string, unknown> = { type: "http", url: config.url };
  const headers = config.headers ?? config.httpHeaders;
  if (headers && Object.keys(headers).length > 0) result.headers = headers;
  if (config.bearerTokenEnvVar) result.bearerTokenEnvVar = config.bearerTokenEnvVar;
  return result;
}

/**
 * Write MCP config for Prime Agent: the `mcpServers` map of the GLOBAL
 * ~/.prime/agent/settings.json (docs/mcp-integrations.md — project-level
 * maps are ignored for execution), the rest of the file preserved.
 */
export async function writePrimeAgentMcpConfig(
  sandbox: SandboxInstance,
  servers: Record<string, McpServerConfig>,
  homeDir?: string
): Promise<void> {
  validateServers(servers);

  const settingsDir = getMcpSettingsDir("prime-agent", homeDir);
  const settingsPath = getMcpSettingsPath("prime-agent", homeDir);

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
    Object.entries(servers).map(([name, config]) => [name, toPrimeAgentMcpFormat(name, config)])
  );

  await sandbox.files.write(
    settingsPath,
    JSON.stringify({ ...existingConfig, mcpServers: transformedServers }, null, 2)
  );
}

export interface ModelsJsonRouteWrite {
  /** The agent dir holding models.json (~ expanded here). */
  agentDir: string;
  /** The provider name the command's --provider selects. */
  providerName: string;
  /** "$VAR" (pi) or the bare "VAR" (Prime Agent) in the file's apiKey field. */
  apiKeyRef: "dollar" | "bare";
  /** The env var the key rides in. */
  apiKeyEnv: string;
  /** The LITERAL base URL, `/v1` included (pi never expands a variable here). */
  baseUrl: string;
  /** The wire model id, as the command's --model spells it. */
  model: string;
  /** Whether thinking is on for this run (the model entry's `reasoning` flag). */
  reasoning: boolean;
  /** The --thinking level; xhigh/max need an explicit thinkingLevelMap (Harbor pi.py:235-239). */
  thinkingLevel?: string;
}

/**
 * Write the pi family's models.json: one custom provider on the
 * `openai-completions` dialect at the literal base URL, the run's model, and
 * the spend headers at provider level (pi docs/models.md; live-proven to
 * reach the gateway on both CLIs 2026-09-25). Other providers a caller left
 * in the file survive; ours is replaced whole every run.
 */
export async function writeModelsJsonRoute(
  sandbox: SandboxInstance,
  config: ModelsJsonRouteWrite,
  headers: Record<string, string>,
  homeDir?: string,
): Promise<void> {
  const agentDir = expandPath(config.agentDir, homeDir);
  const modelsPath = `${agentDir}/models.json`;

  await sandbox.files.makeDir(agentDir);

  let existing: Record<string, unknown> = {};
  try {
    const raw = await sandbox.files.read(modelsPath);
    if (typeof raw === "string" && raw.trim()) {
      existing = JSON.parse(raw);
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }
  const providers =
    typeof existing.providers === "object" && existing.providers !== null
      ? (existing.providers as Record<string, unknown>)
      : {};

  const model: Record<string, unknown> = { id: config.model, reasoning: config.reasoning };
  if (config.reasoning && (config.thinkingLevel === "xhigh" || config.thinkingLevel === "max")) {
    model.thinkingLevelMap = { [config.thinkingLevel]: config.thinkingLevel };
  }
  const provider: Record<string, unknown> = {
    baseUrl: config.baseUrl,
    api: "openai-completions",
    apiKey: config.apiKeyRef === "dollar" ? `$${config.apiKeyEnv}` : config.apiKeyEnv,
    models: [model],
  };
  if (Object.keys(headers).length > 0) provider.headers = headers;

  await sandbox.files.write(
    modelsPath,
    JSON.stringify({ ...existing, providers: { ...providers, [config.providerName]: provider } }, null, 2),
  );
}

/**
 * Deep-merge a platform stamp into a harness's JSON settings file: objects
 * merge key by key, everything else (scalars, arrays) is the stamp's. The
 * file's other keys — an MCP writer's `mcpServers`, a user's own settings —
 * survive untouched.
 */
export async function writeJsonSettingsStamp(
  sandbox: SandboxInstance,
  path: string,
  stamp: Record<string, unknown>,
  homeDir?: string,
): Promise<void> {
  const settingsPath = expandPath(path, homeDir);
  const settingsDir = settingsPath.slice(0, settingsPath.lastIndexOf("/"));

  await sandbox.files.makeDir(settingsDir);

  let existing: Record<string, unknown> = {};
  try {
    const raw = await sandbox.files.read(settingsPath);
    if (typeof raw === "string" && raw.trim()) {
      existing = JSON.parse(raw);
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  await sandbox.files.write(settingsPath, JSON.stringify(mergeStamp(existing, stamp), null, 2));
}

function mergeStamp(base: Record<string, unknown>, stamp: Record<string, unknown>): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(stamp)) {
    const current = merged[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      merged[key] = mergeStamp(current, value);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
