/**
 * MCP JSON Configuration Writer
 *
 * Handles MCP config for Claude, Gemini, Qwen, Kimi, Droid, OpenCode, and
 * Antigravity agents. Uses registry for paths - no hardcoded values.
 *
 * Transport formats by agent:
 * - Claude: { type: "http"|"sse"|"stdio", url: "..." }
 * - Gemini: { url: "...", type: "http"|"sse" } | { command: "..." }
 * - Qwen:   { httpUrl: "..." } | { url: "..." } | { command: "..." }
 * - Kimi Code: { url: "...", transport?: "http"|"sse" } | { command: "...", transport: "stdio" }
 * - Z Code: { type: "stdio", command, args, env } | { type: "http"|"sse", url, headers } under `mcp.servers`
 * - Antigravity: { serverUrl: "...", headers? } | { command: "...", args?, env?, cwd? }
 */

import type { SandboxInstance, McpServerConfig } from "../types";
import { expandPath, getMcpSettingsDir, getMcpSettingsPath } from "../registry";
import { EvolveConfigError } from "../utils/config";
import { validateServers, isNotFoundError } from "./validation";
import { writeHomeFile } from "./home-file";

/** An existing config file's object: an empty file is no config (the antigravity CLI leaves a 0-byte mcp_config.json);
 *  malformed JSON is refused with the path named, never a bare SyntaxError. */
function parseExistingJson(text: unknown, path: string, field: string): Record<string, unknown> {
  if (typeof text !== "string" || text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new EvolveConfigError(field, `Existing config at ${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

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

/**
 * Z Code's MCP schema is a strict union on `type` (stdio | http | sse): the type is always
 * written and only the keys the schema names ride through (a stray key rejects the entry).
 */
function toZcodeFormat(config: McpServerConfig): Record<string, unknown> {
  const transport = detectTransport(config);
  if (transport === "stdio" && config.command) {
    const result: Record<string, unknown> = { type: "stdio", command: config.command };
    if (config.args && config.args.length > 0) result.args = config.args;
    if (config.env && Object.keys(config.env).length > 0) result.env = config.env;
    return result;
  }
  const result: Record<string, unknown> = { type: transport === "sse" ? "sse" : "http" };
  if (config.url) result.url = config.url;
  const headers = config.headers ?? config.httpHeaders;
  if (headers && Object.keys(headers).length > 0) result.headers = headers;
  return result;
}

/**
 * ~/.gemini/config/mcp_config.json as `agy mcp add` writes it (docs/mcp; Harbor antigravity_cli.py): remote =
 * `{ serverUrl, headers? }` (the legacy url/httpUrl keys are rejected), stdio = `{ command, args?, env?, cwd? }`, no type field.
 */
function toAntigravityFormat(config: McpServerConfig): Record<string, unknown> {
  const transport = detectTransport(config);
  const { type, url, httpHeaders, envHttpHeaders, bearerTokenEnvVar, envVars, headers, ...rest } = config;
  if (transport === "stdio" && config.command) {
    return { ...rest };
  }
  if (url) {
    const result: Record<string, unknown> = { ...rest, serverUrl: url };
    const merged = headers ?? httpHeaders;
    if (merged && Object.keys(merged).length > 0) result.headers = merged;
    return result;
  }
  return { ...rest };
}

// =============================================================================
// GENERIC JSON WRITER
// =============================================================================

type ConfigTransformer = (config: McpServerConfig) => Record<string, unknown>;

async function writeJsonMcpConfig(
  sandbox: SandboxInstance,
  agentType: "gemini" | "qwen" | "kimi" | "antigravity",
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
    existingConfig = parseExistingJson(await sandbox.files.read(settingsPath), settingsPath, "mcpServers");
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
  homeOwner?: string,
): Promise<void> {
  const settingsPath = getMcpSettingsPath(agentType, homeDir);

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

  await writeHomeFile(sandbox, settingsPath, JSON.stringify(config, null, 2), { homeDir, owner: homeOwner });
}

export async function writeQwenThinkingConfig(
  sandbox: SandboxInstance,
  enableThinking: boolean,
  homeDir?: string,
  homeOwner?: string,
): Promise<void> {
  const settingsPath = getMcpSettingsPath("qwen", homeDir);

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

  await writeHomeFile(sandbox, settingsPath, JSON.stringify(config, null, 2), { homeDir, owner: homeOwner });
}

/** Write MCP config for Kimi agent (FastMCP-compatible transport field) */
export async function writeKimiMcpConfig(
  sandbox: SandboxInstance,
  servers: Record<string, McpServerConfig>,
  homeDir?: string
): Promise<void> {
  await writeJsonMcpConfig(sandbox, "kimi", servers, toKimiFormat, homeDir);
}

/** Write MCP config for the Antigravity agent (~/.gemini/config/mcp_config.json) */
export async function writeAntigravityMcpConfig(
  sandbox: SandboxInstance,
  servers: Record<string, McpServerConfig>,
  homeDir?: string
): Promise<void> {
  await writeJsonMcpConfig(sandbox, "antigravity", servers, toAntigravityFormat, homeDir);
}

// =============================================================================
// ANTIGRAVITY SETTINGS (~/.gemini/antigravity-cli/settings.json)
// =============================================================================

/**
 * The CLI's settings for a run, merged over the file it rewrites at every start: API-key auth (`modelProvider`), telemetry
 * off (`telemetryEnabled`, the key the binary keeps), non-workspace paths allowed, the run's slug registered (else `--model` exits 1).
 */
export async function writeAntigravitySettings(
  sandbox: SandboxInstance,
  settingsPath: string,
  modelSlug: string,
  homeDir?: string,
  homeOwner?: string,
): Promise<void> {
  const path = expandPath(settingsPath, homeDir);

  let settings: Record<string, unknown> = {};
  try {
    settings = parseExistingJson(await sandbox.files.read(path), path, "antigravitySettings");
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  const customModelsConfig =
    typeof settings.customModelsConfig === "object" && settings.customModelsConfig !== null
      ? (settings.customModelsConfig as Record<string, unknown>)
      : {};
  const customModels =
    typeof customModelsConfig.customModels === "object" && customModelsConfig.customModels !== null
      ? (customModelsConfig.customModels as Record<string, unknown>)
      : {};

  settings.modelProvider = "gemini";
  settings.telemetryEnabled = false;
  settings.allowNonWorkspaceAccess = true;
  settings.customModelsConfig = {
    ...customModelsConfig,
    customModels: { ...customModels, [modelSlug]: { modelName: modelSlug } },
  };

  await writeHomeFile(sandbox, path, JSON.stringify(settings, null, 2), { homeDir, owner: homeOwner });
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
  homeOwner?: string,
): Promise<void> {
  const settingsPath = expandPath(config.settingsPath, homeDir);

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

  await writeHomeFile(sandbox, settingsPath, JSON.stringify(content, null, 2), { homeDir, owner: homeOwner });
}

/**
 * Write MCP config for Z Code
 *
 * Z Code reads user-level servers from `mcp.servers` in ~/.zcode/cli/config.json
 * (the registry's mcpConfig); every other key of that file is preserved.
 */
export async function writeZcodeMcpConfig(
  sandbox: SandboxInstance,
  servers: Record<string, McpServerConfig>,
  homeDir?: string
): Promise<void> {
  validateServers(servers);

  const settingsDir = getMcpSettingsDir("zcode", homeDir);
  const settingsPath = getMcpSettingsPath("zcode", homeDir);

  await sandbox.files.makeDir(settingsDir);

  let existingConfig: Record<string, unknown> = {};
  try {
    const existing = await sandbox.files.read(settingsPath);
    if (typeof existing === "string" && existing.trim()) {
      existingConfig = JSON.parse(existing);
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  const existingMcp =
    typeof existingConfig.mcp === "object" && existingConfig.mcp !== null
      ? (existingConfig.mcp as Record<string, unknown>)
      : {};
  const transformedServers = Object.fromEntries(
    Object.entries(servers).map(([name, config]) => [name, toZcodeFormat(config)])
  );

  await sandbox.files.write(
    settingsPath,
    JSON.stringify({ ...existingConfig, mcp: { ...existingMcp, servers: transformedServers } }, null, 2)
  );
}

export interface ZcodeProviderConfigInput {
  /** The provider file, `~` = the sandbox home (registry zcodeProviderConfig.path). */
  path: string;
  providerId: string;
  providerName: string;
  /** OpenAI-compatible base URL INCLUDING `/v1` — Z Code appends `/chat/completions`. */
  baseUrl: string;
  /** The literal credential: Z Code expands no `${VAR}` in this file. */
  apiKey: string;
  /** The wire model id the request names. */
  model: string;
  /** One of ZCODE_REASONING_LEVELS. */
  reasoningLevel: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** Extra request headers (the LiteLLM spend tags); {} when none. */
  headers: Record<string, string>;
}

/**
 * Z Code's provider file, built from scratch every run at mode 0600: the CLI reads its model,
 * level, base URL and key here and nowhere else (ZCode packages/provider/src/config at v3.14.3).
 */
export async function writeZcodeProviderConfig(
  sandbox: SandboxInstance,
  config: ZcodeProviderConfigInput,
  homeDir?: string,
  homeOwner?: string,
): Promise<void> {
  const filePath = expandPath(config.path, homeDir);

  const api: Record<string, unknown> = {
    type: "openai-chat-completions",
    baseUrl: config.baseUrl,
  };
  if (Object.keys(config.headers).length > 0) api.headers = config.headers;

  const document = {
    schemaVersion: 1,
    config: {
      providerConfigRules: {
        providerRules: [
          {
            providerId: config.providerId,
            providerName: config.providerName,
            config: {
              group: "standard-personal",
              access: { type: "api-key", apiKey: config.apiKey },
              api,
              personalModelIds: [config.model],
            },
          },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          {
            providerId: config.providerId,
            modelId: config.model,
            config: {
              enabled: true,
              properties: { contextWindow: config.contextWindow, supportsToolCall: true },
              optionSpecs: {
                maxOutputTokens: {
                  max: config.maxOutputTokens,
                  map: '{"max_tokens": maxOutputTokens}',
                },
                reasoningLevel: {
                  values: ["disabled", "low", "medium", "high"],
                  map: 'reasoningLevel == "disabled" ? {} : {"reasoning_effort": reasoningLevel}',
                },
              },
            },
          },
        ],
        manualProviderModelRules: [],
      },
      defaultModelSelection: {
        providerId: config.providerId,
        modelId: config.model,
        options: { reasoningLevel: config.reasoningLevel },
      },
    },
  };

  // The file holds the literal key: 0600, for the home's owner alone.
  await writeHomeFile(sandbox, filePath, JSON.stringify(document, null, 2), { homeDir, owner: homeOwner, mode: "600" });
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

/** pi-mcp-adapter's shape: stdio `{command, args?, cwd?, env?}`, remote `{url, headers?}` (HTTP with SSE fallback). */
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

/** No host-config discovery (Harbor pi.py pins the same three off), no startup notice, no script mode. */
export const PI_MCP_ADAPTER_SETTINGS = {
  hostConfigDiscovery: "off",
  notifyOnStartupConnect: false,
  scriptMode: false,
} as const;

/** pi's MCP config: `<agent-dir>/mcp.json`, read by the adapter extension the command loads. */
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
 * Prime's settings.json McpServerConfig: `sse` is written as `http` (Prime has no SSE
 * transport), and a stdio `env` must be references by NAME — a literal value is refused.
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

/** Prime's MCP servers: the `mcpServers` map of the GLOBAL settings.json, the rest of the file kept. */
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

/** One provider entry at the literal base URL with the run's model and headers; other providers survive. */
export async function writeModelsJsonRoute(
  sandbox: SandboxInstance,
  config: ModelsJsonRouteWrite,
  headers: Record<string, string>,
  homeDir?: string,
  homeOwner?: string,
): Promise<void> {
  const agentDir = expandPath(config.agentDir, homeDir);
  const modelsPath = `${agentDir}/models.json`;

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

  await writeHomeFile(
    sandbox,
    modelsPath,
    JSON.stringify({ ...existing, providers: { ...providers, [config.providerName]: provider } }, null, 2),
    { homeDir, owner: homeOwner },
  );
}

/** Deep-merge a settings stamp: objects key by key, scalars and arrays the stamp's; other keys survive. */
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
