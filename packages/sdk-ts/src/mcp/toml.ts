/**
 * MCP TOML Configuration Writer
 *
 * Handles MCP config for Codex agent which uses TOML format.
 * Uses registry for paths - no hardcoded values.
 */

import type { SandboxInstance, McpServerConfig } from "../types";
import { getMcpSettingsDir, getMcpSettingsPath, expandPath } from "../registry";
import { validateMcpServer, isNotFoundError } from "./validation";
import {
  LITELLM_CUSTOMER_ID_HEADER,
  LITELLM_TAGS_HEADER,
} from "../constants";

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

// =============================================================================
// CODEX SPEND TRACKING MODEL PROVIDER
// =============================================================================

/**
 * Write an "evolve-gateway" model provider into Codex config.toml
 *
 * Codex supports env_http_headers per model provider — header values are read
 * from env vars at request time. We define a provider that injects LiteLLM
 * tracking headers via env vars set per-run by buildRunEnvs().
 */
export async function writeCodexSpendProvider(
  sandbox: SandboxInstance,
  baseUrl: string,
  spendTrackingEnvs: { sessionTagEnv: string; runTagEnv: string },
): Promise<void> {
  const settingsDir = getMcpSettingsDir("codex");
  const settingsPath = getMcpSettingsPath("codex");

  await sandbox.files.makeDir(settingsDir);

  let existingToml = "";
  try {
    const existing = await sandbox.files.read(settingsPath);
    if (typeof existing === "string") {
      existingToml = existing;
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  // Split into root-level portion (before first [section]) and the rest.
  // TOML keys before any section header are root-level; keys after belong to that section.
  const firstSectionIdx = existingToml.search(/^\[/m);
  const rootPortion = firstSectionIdx >= 0 ? existingToml.slice(0, firstSectionIdx) : existingToml;
  const restPortion = firstSectionIdx >= 0 ? existingToml.slice(firstSectionIdx) : "";

  // Skip if both the provider section and root key are already correct.
  // hasRootKey checks only the root portion so a profile-scoped model_provider doesn't match.
  const hasProviderSection = existingToml.includes("[model_providers.evolve-gateway]");
  const hasRootKey = /^model_provider\s*=\s*"evolve-gateway"/m.test(rootPortion);
  if (hasProviderSection && hasRootKey) {
    return;
  }

  // Strip any existing model_provider root key to avoid duplicate TOML keys.
  const cleanedRoot = rootPortion.replace(/^model_provider\s*=\s*.*$/m, "").replace(/\n{3,}/g, "\n\n");

  existingToml = (cleanedRoot + restPortion).replace(/^\n+/, "");

  // model_provider must be a root-level TOML key (before any [section] headers).
  // The [model_providers.evolve-gateway] table goes at the end.
  const rootKey = `model_provider = "evolve-gateway"`;
  const providerSection = hasProviderSection ? "" : [
    "[model_providers.evolve-gateway]",
    `name = "Evolve Gateway"`,
    `base_url = ${serializeTomlValue(baseUrl)}`,
    `env_key = "OPENAI_API_KEY"`,
    `env_http_headers = ${serializeTomlValue({
      [LITELLM_CUSTOMER_ID_HEADER]: spendTrackingEnvs.sessionTagEnv,
      [LITELLM_TAGS_HEADER]: spendTrackingEnvs.runTagEnv,
    })}`,
  ].join("\n");

  let content: string;
  if (!existingToml.trim()) {
    content = providerSection ? `${rootKey}\n\n${providerSection}\n` : `${rootKey}\n`;
  } else {
    // Insert root key before the first [section] header so it stays root-level
    const firstSection = existingToml.search(/^\[/m);
    if (firstSection > 0) {
      content = existingToml.slice(0, firstSection) + rootKey + "\n\n" + existingToml.slice(firstSection).trimEnd();
    } else if (firstSection === 0) {
      content = rootKey + "\n\n" + existingToml.trimEnd();
    } else {
      // No section headers — just append
      content = existingToml.trimEnd() + "\n\n" + rootKey;
    }
    if (providerSection) {
      content = content.trimEnd() + "\n\n" + providerSection;
    }
    content += "\n";
  }

  await sandbox.files.write(settingsPath, content);
}

// =============================================================================
// KIMI SPEND TRACKING (TOML provider with custom_headers)
// =============================================================================

/**
 * Write spend tracking headers to Kimi's config.toml via a provider entry.
 *
 * Kimi reads custom_headers from providers[name].custom_headers in config.toml.
 * Unlike Qwen (flat JSON path), Kimi requires a full provider+model+default_model
 * chain so the CLI picks up the provider with headers.
 *
 * The provider's base_url/api_key are placeholders — KIMI_BASE_URL and KIMI_API_KEY
 * env vars override them at runtime. Only custom_headers needs real values.
 *
 * Preserves existing config (other providers, models, MCP, loop_control, etc.).
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
): Promise<void> {
  const configPath = expandPath(config.configPath);
  const configDir = configPath.slice(0, configPath.lastIndexOf("/"));

  await sandbox.files.makeDir(configDir);

  let existingToml = "";
  try {
    const existing = await sandbox.files.read(configPath);
    if (typeof existing === "string") {
      existingToml = existing;
    }
  } catch (error) {
    if (!isNotFoundError(error)) throw error;
  }

  // Parse existing custom_headers from provider section to merge (don't clobber user headers)
  const providerSection = `[providers.${config.providerName}]`;
  const existingHeaders = parseExistingCustomHeaders(existingToml, providerSection);
  const mergedHeaders = { ...existingHeaders, ...headers };

  // Split into root portion (before first [section]) and rest
  const firstSectionIdx = existingToml.search(/^\[/m);
  const rootPortion = firstSectionIdx >= 0 ? existingToml.slice(0, firstSectionIdx) : existingToml;
  const restPortion = firstSectionIdx >= 0 ? existingToml.slice(firstSectionIdx) : "";

  // Ensure default_model points to our model entry
  const hasDefaultModel = /^default_model\s*=/m.test(rootPortion);
  let cleanedRoot = rootPortion;
  if (hasDefaultModel) {
    cleanedRoot = rootPortion.replace(/^default_model\s*=\s*.*$/m, `default_model = ${serializeTomlValue(config.modelName)}`);
  }

  // Remove existing provider and model sections (we'll rewrite them)
  let cleanedRest = restPortion;
  cleanedRest = removeTomlSection(cleanedRest, `providers.${config.providerName}`);
  cleanedRest = removeTomlSection(cleanedRest, `models.${config.modelName}`);

  // Build new sections
  const providerLines = [
    providerSection,
    `type = "kimi"`,
    `base_url = ""`,
    `api_key = ""`,
    `custom_headers = ${serializeTomlValue(mergedHeaders)}`,
  ].join("\n");

  const modelLines = [
    `[models.${config.modelName}]`,
    `provider = ${serializeTomlValue(config.providerName)}`,
    `model = ""`,
    `max_context_size = ${config.maxContextSize}`,
  ].join("\n");

  // Assemble final config
  const segments: string[] = [];

  // Root portion with default_model
  let root = cleanedRoot.replace(/\n{3,}/g, "\n\n").trim();
  if (!hasDefaultModel) {
    root = root
      ? `${root}\ndefault_model = ${serializeTomlValue(config.modelName)}`
      : `default_model = ${serializeTomlValue(config.modelName)}`;
  }
  if (root) segments.push(root);

  // Existing sections (minus the ones we removed)
  const rest = cleanedRest.replace(/\n{3,}/g, "\n\n").trim();
  if (rest) segments.push(rest);

  // Our provider + model
  segments.push(providerLines);
  segments.push(modelLines);

  await sandbox.files.write(configPath, segments.join("\n\n") + "\n");
}

/**
 * Parse existing custom_headers from a TOML provider section.
 * Returns empty object if not found.
 */
function parseExistingCustomHeaders(
  toml: string,
  sectionHeader: string,
): Record<string, string> {
  const sectionIdx = toml.indexOf(sectionHeader);
  if (sectionIdx === -1) return {};

  // Find section content (up to next [section] or end)
  const afterHeader = toml.slice(sectionIdx + sectionHeader.length);
  const nextSection = afterHeader.search(/^\[/m);
  const sectionContent = nextSection >= 0 ? afterHeader.slice(0, nextSection) : afterHeader;

  // Match inline table: custom_headers = { "key" = "value", ... }
  const match = sectionContent.match(/^custom_headers\s*=\s*\{([^}]*)\}/m);
  if (!match) return {};

  const headers: Record<string, string> = {};
  // Parse key = "value" pairs
  for (const pair of match[1].split(",")) {
    const kv = pair.match(/^\s*"?([^"=]+)"?\s*=\s*"([^"]*)"/);
    if (kv) {
      headers[kv[1].trim()] = kv[2];
    }
  }
  return headers;
}

/**
 * Remove a TOML section (header + all lines until next section or EOF).
 */
function removeTomlSection(toml: string, sectionName: string): string {
  const header = `[${sectionName}]`;
  const idx = toml.indexOf(header);
  if (idx === -1) return toml;

  const afterHeader = toml.slice(idx + header.length);
  const nextSection = afterHeader.search(/^\[/m);
  const end = nextSection >= 0 ? idx + header.length + nextSection : toml.length;

  return (toml.slice(0, idx) + toml.slice(end)).replace(/\n{3,}/g, "\n\n");
}
