/**
 * dsh Configuration Writers (YAML patches)
 *
 * dsh has no model, effort or base-URL flag and reads no .mcp.json: Cordis
 * patch files (a YAML list of rows; `- insert:` adds rows) are its one config
 * surface, so two Evolve-owned files under ~/.dsh route it — the pi-ai route
 * (model, effort, spend headers) and one dsh-mcp-client row per MCP server.
 * The route patch names the key and URL as env variables (`!!js process.env.X`,
 * read by dsh at boot), so no secret lands on disk and one shape serves every mode.
 */

import { stringify as stringifyYaml } from "yaml";
import type { SandboxInstance, McpServerConfig } from "../types";
import { DSH_REASONING_EFFORTS, expandPath, getMcpSettingsDir, getMcpSettingsPath } from "../registry";
import { validateServers } from "./validation";

// =============================================================================
// MCP PATCH
// =============================================================================

/** dsh-mcp-client's serverName grammar (packages/mcp/mcp-client/README.md). */
const DSH_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/** dsh speaks stdio and streamable-http only (no SSE in the vendor's packages/), so sse is refused, not re-labelled. */
function toDshMcpFormat(name: string, config: McpServerConfig): Record<string, unknown> {
  if (!DSH_SERVER_NAME.test(name)) {
    throw new Error(
      `MCP server "${name}" cannot be registered with dsh: dsh-mcp-client server names must match ${DSH_SERVER_NAME}`,
    );
  }
  if (config.type === "sse") {
    throw new Error(
      `MCP server "${name}" uses the sse transport, which dsh does not support (stdio or streamable-http only)`,
    );
  }

  const row: Record<string, unknown> = { serverName: name };
  if (config.command) {
    row.transport = "stdio";
    row.command = config.command;
    if (config.args && config.args.length > 0) row.args = config.args;
    if (config.env && Object.keys(config.env).length > 0) row.env = config.env;
    if (config.cwd) row.cwd = config.cwd;
    return row;
  }

  row.transport = "streamable-http";
  row.url = config.url;
  const headers = config.headers ?? config.httpHeaders;
  if (headers && Object.keys(headers).length > 0) row.headers = headers;
  return row;
}

/** Rows must sit under `- insert:`; a bare row in a --patch file is "entry not found" (live M1). */
export async function writeDshMcpConfig(
  sandbox: SandboxInstance,
  servers: Record<string, McpServerConfig>,
  homeDir?: string
): Promise<void> {
  validateServers(servers);

  const settingsDir = getMcpSettingsDir("dsh", homeDir);
  const settingsPath = getMcpSettingsPath("dsh", homeDir);

  await sandbox.files.makeDir(settingsDir);

  const rows = Object.entries(servers).map(([name, config]) => ({
    id: `evolve-mcp-${name}`,
    name: "@deepseek-ai/dsh-mcp-client",
    config: toDshMcpFormat(name, config),
  }));

  await sandbox.files.write(
    settingsPath,
    "# Evolve-owned dsh patch: MCP servers as @deepseek-ai/dsh-mcp-client rows. Rewritten at setup.\n" +
      stringifyYaml([{ insert: rows }]),
  );
}

// =============================================================================
// ROUTE PATCH
// =============================================================================

export interface DshRoutePatchConfig {
  path: string;
  providerName: string;
  /** Env var NAME (pi-ai `apiKeyEnv` reads it per request). */
  apiKeyEnv: string;
  /** Env var NAME, read at boot via `!!js process.env`. */
  baseUrlEnv: string;
  /** The wire model id, sent verbatim. */
  model: string;
  /** pi-ai thinking level; absent = the route's default. */
  reasoningEffort?: string;
  /** Header name → env var NAME; only where the SDK sets every named env (an unset env would be an undefined header). */
  headerEnvs?: Record<string, string>;
  contextWindow: number;
  maxTokens: number;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** The name is validated so no other code can ride the `!!js` scalar. */
function envRead(envName: string): string {
  if (!ENV_NAME.test(envName)) {
    throw new Error(`dsh route patch: "${envName}" is not an environment variable name`);
  }
  return `!!js process.env.${envName}`;
}

/** A YAML double-quoted scalar (JSON's string grammar is a YAML subset). */
function quoted(value: string): string {
  return JSON.stringify(value);
}

/** Rendered by hand: `!!js` tags have no JSON spelling. */
export function renderDshRoutePatch(config: DshRoutePatchConfig): string {
  const lines: string[] = [
    "# Evolve-owned dsh patch: the pi-ai route, the default model and effort, and the rows a",
    "# headless run must not carry. Rewritten before every run. Names env variables only —",
    "# never a key or a URL value.",
    "- id: llm-pi-ai",
    "  config:",
    "    providers:",
    `      ${quoted(config.providerName)}:`,
    `        apiKeyEnv: ${quoted(config.apiKeyEnv)}`,
    "        api: openai-completions",
    `        baseURL: ${envRead(config.baseUrlEnv)}`,
  ];
  if (config.headerEnvs && Object.keys(config.headerEnvs).length > 0) {
    lines.push("        headers:");
    for (const [header, envName] of Object.entries(config.headerEnvs)) {
      lines.push(`          ${quoted(header)}: ${envRead(envName)}`);
    }
  }
  lines.push(
    // The two switches the vendor names for an OpenAI-compatible gateway (providers.md "Request compatibility").
    "        compat:",
    "          supportsDeveloperRole: false",
    "          maxTokensField: max_tokens",
    "        models:",
    `          - id: ${quoted(config.model)}`,
    `            contextWindow: ${config.contextWindow}`,
    `            maxTokens: ${config.maxTokens}`,
    // A hand-declared model offers no levels until declared (providers.md "Reasoning effort").
    "            reasoningEfforts:",
    ...DSH_REASONING_EFFORTS.map((level) => `              ${level}: ${level}`),
    "- id: agent-default-model",
    "  config:",
    `    provider: ${quoted(config.providerName)}`,
    `    model: ${quoted(config.model)}`,
  );
  if (config.reasoningEffort) {
    lines.push(`    reasoningEffort: ${quoted(config.reasoningEffort)}`);
  }
  lines.push(
    // The native route's per-request uploads, pinned off so a future default cannot re-enable them.
    "- id: session-log-deepseek",
    "  config:",
    "    enabled: false",
    "- id: plugin-package-inventory-deepseek",
    "  config:",
    "    enabled: false",
    // One hidden model call per session otherwise.
    "- id: session-title-llm",
    "  disabled: true",
    // web_search would send DEEPSEEK_API_KEY to DeepSeek's own search API, past the gateway;
    // a patch row replaces the whole config, so fetch and the timeout are restated at the base's values.
    "- id: tool-web",
    "  config:",
    "    search: false",
    "    fetch: true",
    "    searchTimeoutMs: 60000",
    "",
  );
  return lines.join("\n");
}

/** Rewritten before every run; the run tag rides an env var, so the text is static per session. */
export async function writeDshRoutePatch(
  sandbox: SandboxInstance,
  config: DshRoutePatchConfig,
  homeDir?: string,
): Promise<void> {
  const path = expandPath(config.path, homeDir);
  const dir = path.slice(0, path.lastIndexOf("/"));
  await sandbox.files.makeDir(dir);
  await sandbox.files.write(path, renderDshRoutePatch(config));
}
