/**
 * MCP TOML Configuration Writer
 *
 * Handles MCP config for Codex agent which uses TOML format.
 * Uses registry for paths - no hardcoded values.
 *
 * Every writer here follows one pattern: parse the existing document into an
 * object, mutate the object, re-serialize with smol-toml. Nothing inspects the
 * raw text, so a commented-out section never masks a real one and a value
 * containing newlines or quotes cannot break the file.
 */

import { parse, stringify } from "smol-toml";
import type { SandboxInstance, McpServerConfig } from "../types";
import { getMcpSettingsDir, getMcpSettingsPath, expandPath } from "../registry";
import { validateMcpServer, isNotFoundError } from "./validation";
import {
  LITELLM_CUSTOMER_ID_HEADER,
  LITELLM_TAGS_HEADER,
} from "../constants";

// =============================================================================
// TOML DOCUMENT HELPERS
// =============================================================================

type TomlTable = Record<string, unknown>;

/** Narrow to a TOML table (plain object), rejecting arrays and scalars. */
function asTable(value: unknown): TomlTable | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as TomlTable)
    : undefined;
}

/**
 * The user's existing key as a table, or an empty one when the key is absent.
 * A key that EXISTS but is not a table refuses loudly: `?? {}` silently
 * replaced whatever the user wrote (e.g. `mcp_servers = "oops"`) and the next
 * write erased it from their file.
 */
function requireTable(doc: TomlTable, key: string, path: string): TomlTable {
  const value = doc[key];
  if (value === undefined) return {};
  const table = asTable(value);
  if (!table) {
    const found = Array.isArray(value) ? "an array" : `a ${typeof value}`;
    throw new Error(
      `Refusing to rewrite "${key}" in ${path}: expected a TOML table, found ${found}`
    );
  }
  return table;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, i) => deepEqual(item, b[i]))
    );
  }
  const left = asTable(a);
  const right = asTable(b);
  if (!left || !right) return false;
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => key in right && deepEqual(left[key], right[key]))
  );
}

/** Read and parse a TOML file; an absent or empty file is an empty document. */
async function readTomlDocument(
  sandbox: SandboxInstance,
  path: string,
): Promise<TomlTable> {
  let raw = "";
  try {
    const existing = await sandbox.files.read(path);
    if (typeof existing === "string") {
      raw = existing;
    }
  } catch (error) {
    if (!isNotFoundError(error)) {
      throw error; // Re-throw unexpected errors (permissions, encoding, etc.)
    }
    return {}; // File doesn't exist yet - expected on first run
  }

  if (!raw.trim()) return {};
  try {
    return parse(raw) as TomlTable;
  } catch (error) {
    throw new Error(`Failed to parse TOML at ${path}: ${(error as Error).message}`);
  }
}

async function writeTomlDocument(
  sandbox: SandboxInstance,
  path: string,
  doc: TomlTable,
): Promise<void> {
  await sandbox.files.write(path, stringify(doc).trimEnd() + "\n");
}

// =============================================================================
// CODEX MCP CONFIG
// =============================================================================

function buildCodexServerTable(name: string, config: McpServerConfig): TomlTable {
  const table: TomlTable = {};

  const transportType = config.type ?? (config.command ? "stdio" : "http");
  const isStreamable = transportType === "http" || transportType === "sse" || Boolean(config.url);

  if (isStreamable) {
    // HTTP/SSE transport
    if (!config.url) {
      throw new Error(`MCP server "${name}" is missing url for ${transportType} transport`);
    }
    table.url = config.url;

    // Bearer token from env var
    if (config.bearerTokenEnvVar) {
      table.bearer_token_env_var = config.bearerTokenEnvVar;
    }

    // HTTP headers (prefer httpHeaders, fallback to headers)
    const httpHeaders = config.httpHeaders ?? config.headers;
    if (httpHeaders && Object.keys(httpHeaders).length > 0) {
      table.http_headers = httpHeaders;
    }

    // Environment-based HTTP headers
    if (config.envHttpHeaders && Object.keys(config.envHttpHeaders).length > 0) {
      table.env_http_headers = config.envHttpHeaders;
    }
  } else {
    // STDIO transport
    table.command = config.command!;
    if (config.args && config.args.length > 0) {
      table.args = config.args;
    }
    if (config.cwd) {
      table.cwd = config.cwd;
    }
  }

  // Common env vars (key=value)
  if (config.env && Object.keys(config.env).length > 0) {
    table.env = config.env;
  }

  // Environment variable names to pass through
  if (config.envVars && config.envVars.length > 0) {
    table.env_vars = config.envVars;
  }

  return table;
}

/**
 * Write MCP config for Codex agent
 *
 * Codex stores MCP config in ~/.codex/config.toml using TOML format.
 * Format: [mcp_servers.server_name] sections
 */
export async function writeCodexMcpConfig(
  sandbox: SandboxInstance,
  servers: Record<string, McpServerConfig>,
  homeDir?: string
): Promise<void> {
  // Validate all servers
  for (const [name, config] of Object.entries(servers)) {
    validateMcpServer(name, config);
  }

  const settingsDir = getMcpSettingsDir("codex", homeDir);
  const settingsPath = getMcpSettingsPath("codex", homeDir);

  // Ensure settings directory exists
  await sandbox.files.makeDir(settingsDir);

  // Read existing config to preserve other settings
  const doc = await readTomlDocument(sandbox, settingsPath);

  // Enable the improved RMCP client unless the user set it themselves
  if (doc.experimental_use_rmcp_client === undefined) {
    doc.experimental_use_rmcp_client = true;
  }

  const mcpServers = requireTable(doc, "mcp_servers", settingsPath);
  doc.mcp_servers = mcpServers;

  for (const [name, config] of Object.entries(servers)) {
    // A server the user already configured stays exactly as they wrote it
    if (mcpServers[name] !== undefined) {
      continue;
    }
    mcpServers[name] = buildCodexServerTable(name, config);
  }

  await writeTomlDocument(sandbox, settingsPath, doc);
}

// =============================================================================
// CODEX SPEND TRACKING MODEL PROVIDER
// =============================================================================

/**
 * Write an "evolve-gateway" model provider into Codex config.toml
 *
 * Codex supports env_http_headers per model provider — header values are read
 * from env vars at request time. We define a provider that injects gateway
 * tracking headers via env vars set per-run by buildRunEnvs().
 *
 * When spendTrackingEnvs is undefined (external gateway mode: no gateway
 * tracking headers, no runtime binding exists), the provider is written
 * without env_http_headers.
 */
export async function writeCodexSpendProvider(
  sandbox: SandboxInstance,
  baseUrl: string,
  spendTrackingEnvs?: { sessionTagEnv: string; runTagEnv: string },
  envHttpHeaders: Record<string, string> = {},
  homeDir?: string,
): Promise<void> {
  const settingsDir = getMcpSettingsDir("codex", homeDir);
  const settingsPath = getMcpSettingsPath("codex", homeDir);

  await sandbox.files.makeDir(settingsDir);

  const doc = await readTomlDocument(sandbox, settingsPath);

  const providerHeaders = {
    ...(spendTrackingEnvs
      ? {
          [LITELLM_CUSTOMER_ID_HEADER]: spendTrackingEnvs.sessionTagEnv,
          [LITELLM_TAGS_HEADER]: spendTrackingEnvs.runTagEnv,
        }
      : {}),
    ...envHttpHeaders,
  };
  const desiredProvider: TomlTable = {
    name: "Evolve Gateway",
    base_url: baseUrl,
    env_key: "OPENAI_API_KEY",
    // Codex >=0.145 removed wire_api="chat"; "responses" is the only supported
    // value and the default — pinned explicitly so a future default change
    // cannot silently break gateway routing.
    wire_api: "responses",
    ...(Object.keys(providerHeaders).length > 0
      ? { env_http_headers: providerHeaders }
      : {}),
  };

  const providers = requireTable(doc, "model_providers", settingsPath);

  // model_provider is read as a root key, so a profile-scoped one under
  // [profiles.*] never satisfies this check.
  if (
    doc.model_provider === "evolve-gateway" &&
    deepEqual(providers["evolve-gateway"], desiredProvider)
  ) {
    return;
  }

  doc.model_provider = "evolve-gateway";
  providers["evolve-gateway"] = desiredProvider;
  doc.model_providers = providers;

  await writeTomlDocument(sandbox, settingsPath, doc);
}

// =============================================================================
// KIMI CODE SPEND TRACKING (config.toml)
// =============================================================================

/**
 * Write the Kimi Code config file used for gateway routing and spend tracking.
 *
 * The sandbox is ours, so we write ~/.kimi-code/config.toml from scratch. This
 * keeps Kimi coherent with Codex/Qwen/Droid: the SDK owns gateway provider
 * settings, and run-specific gateway headers are rewritten before each spawn.
 *
 * Source-verified: Kimi Code reads default_model, providers.<name>,
 * providers.<name>.custom_headers, and models.<name> from config.toml.
 */
export async function writeKimiSpendConfig(
  sandbox: SandboxInstance,
  config: {
    configPath: string;
    providerName: string;
    modelName: string;
    maxContextSize: number;
  },
  headers: Record<string, string>,
  connection: {
    baseUrl: string;
    apiKey: string;
    model: string;
    defaultThinking: boolean;
    thinkingEffort?: string;
  },
  homeDir?: string,
): Promise<void> {
  const configPath = expandPath(config.configPath, homeDir);
  const configDir = configPath.slice(0, configPath.lastIndexOf("/"));

  await sandbox.files.makeDir(configDir);

  // Built from scratch — no reading, no parsing, no merging.
  const doc: TomlTable = {
    default_model: config.modelName,
    default_thinking: connection.defaultThinking,
    default_permission_mode: "auto",
    thinking: {
      mode: connection.defaultThinking ? "on" : "off",
      ...(connection.defaultThinking && connection.thinkingEffort
        ? { effort: connection.thinkingEffort }
        : {}),
    },
    providers: {
      [config.providerName]: {
        type: "kimi",
        base_url: connection.baseUrl,
        api_key: connection.apiKey,
        custom_headers: headers,
      },
    },
    models: {
      [config.modelName]: {
        provider: config.providerName,
        model: connection.model,
        max_context_size: config.maxContextSize,
        capabilities: ["image_in", "thinking"],
      },
    },
  };

  await writeTomlDocument(sandbox, configPath, doc);
}
