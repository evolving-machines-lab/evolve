/**
 * dsh Configuration Writers (YAML patches)
 *
 * DeepSeek Harness (`dsh`) is configured by Cordis PATCH files: a YAML list of
 * rows, each `id` replacing that row's whole `config` (no deep merge), or an
 * `insert:` list adding rows (deepseek-harness apps/cli/reference/README.md
 * "Profile boot"; docs/user/guide/mcp-memory.md for `insert`). dsh has no
 * model, effort or base-URL flag and reads no .mcp.json, so the two patches
 * below are the whole routing surface. Both are Evolve-owned files under
 * ~/.dsh, passed to the command with `--patch` (registry.ts dsh.buildCommand).
 *
 *   evolve-route.patch.yml  the pi-ai provider route at the gateway (or at
 *                           OpenRouter in direct mode), the default model and
 *                           effort, and the rows the headless run must not
 *                           carry (the hidden title call; the native route's
 *                           session-log and plugin-inventory uploads).
 *   evolve-mcp.patch.yml    one @deepseek-ai/dsh-mcp-client row per server.
 *
 * NO SECRET EVER LANDS IN THE ROUTE PATCH. The key and the base URL are named
 * as ENV VARIABLES — `apiKeyEnv` is dsh's own env-name field, and the URL and
 * the spend headers ride `!!js process.env.X` scalars, which dsh's YAML loader
 * evaluates at boot (proven live 2026-09-25, harness-recon-2026-09-25/
 * 06-live-tests/dsh). One file shape therefore serves gateway, external-
 * gateway and direct mode; only the env values differ, and the home capture
 * can carry the file.
 */

import { stringify as stringifyYaml } from "yaml";
import type { SandboxInstance, McpServerConfig } from "../types";
import { DSH_REASONING_LEVELS, expandPath, getMcpSettingsDir, getMcpSettingsPath } from "../registry";
import { validateServers } from "./validation";

// =============================================================================
// MCP PATCH
// =============================================================================

/** dsh-mcp-client's serverName grammar (packages/mcp/mcp-client/README.md). */
const DSH_SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Transform to the dsh-mcp-client row config.
 *
 * dsh speaks `stdio` and `streamable-http` only — no SSE (grep across the
 * vendor's packages/: none), so an SSE server is refused typed rather than
 * silently re-labelled onto a protocol it does not speak. A url with no type
 * is streamable-http (the modern default; SSE must be asked for by name).
 */
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

/**
 * Write MCP config for dsh: `~/.dsh/evolve-mcp.patch.yml`, one inserted
 * @deepseek-ai/dsh-mcp-client row per server (tools surface as
 * `mcp__<serverName>__<tool>`). Rows must sit under `- insert:` — a bare row
 * in a --patch file is "entry not found" (round-2 live finding M1). The file
 * is Evolve-owned and rewritten whole.
 */
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
  /** Sandbox path of the patch (registry dshRoutePatch.path, `~` allowed). */
  path: string;
  /** The pi-ai provider route name declared and selected. */
  providerName: string;
  /** Env var NAME dsh reads the key from per request (pi-ai `apiKeyEnv`). */
  apiKeyEnv: string;
  /** Env var NAME holding the base URL, read at boot via `!!js process.env`. */
  baseUrlEnv: string;
  /** The wire model id — the one string the provider receives verbatim. */
  model: string;
  /** pi-ai thinking level for `agent-default-model.reasoningEffort`; absent = the route's default. */
  reasoningEffort?: string;
  /**
   * Spend-tracking headers as header name → env var NAME, each read at boot
   * via `!!js process.env`. Only for the managed gateway, where the SDK sets
   * every named env per run; absent otherwise (an unset env would become an
   * undefined header value).
   */
  headerEnvs?: Record<string, string>;
  contextWindow: number;
  maxTokens: number;
}

const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

/** A `!!js` scalar reading one env var at boot; the name is validated so no other code can ride it. */
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

/**
 * The route patch's text — rendered by hand because the `!!js` tags have no
 * JSON spelling. Every string dsh could misread as a number, a boolean or a
 * flow token is quoted.
 */
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
    // The two switches the vendor names for an OpenAI-compatible gateway
    // (docs/user/guide/providers.md "Request compatibility"), proven live.
    "        compat:",
    "          supportsDeveloperRole: false",
    "          maxTokensField: max_tokens",
    "        models:",
    `          - id: ${quoted(config.model)}`,
    `            contextWindow: ${config.contextWindow}`,
    `            maxTokens: ${config.maxTokens}`,
    // A hand-declared model offers no effort levels until they are declared;
    // each key is a level, its value the `reasoning_effort` wire spelling, and
    // `off` valueless means "send nothing" (providers.md "Reasoning effort").
    "            reasoningEfforts:",
    ...DSH_REASONING_LEVELS.map((level) => (level === "off" ? "              off: null" : `              ${level}: ${level}`)),
    "- id: agent-default-model",
    "  config:",
    `    provider: ${quoted(config.providerName)}`,
    `    model: ${quoted(config.model)}`,
  );
  if (config.reasoningEffort) {
    lines.push(`    reasoningEffort: ${quoted(config.reasoningEffort)}`);
  }
  lines.push(
    // The native route's per-request uploads (the whole session log and the
    // plugin inventory, both on by default) never leave on the pi-ai route,
    // but the rows are pinned off so a future default cannot re-enable them.
    "- id: session-log-deepseek",
    "  config:",
    "    enabled: false",
    "- id: plugin-package-inventory-deepseek",
    "  config:",
    "    enabled: false",
    // One hidden extra model call per session, on the same route and key.
    "- id: session-title-llm",
    "  disabled: true",
    "",
  );
  return lines.join("\n");
}

/**
 * Write the Evolve-owned dsh route patch. Rewritten before every run because
 * the model and effort are per-Agent facts; the text itself is static per
 * session (the run tag rides an env var), so the write is idempotent.
 */
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
