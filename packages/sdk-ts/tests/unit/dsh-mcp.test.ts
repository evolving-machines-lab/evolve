#!/usr/bin/env tsx
/**
 * Unit Test: dsh config writers (mcp/yaml.ts)
 *
 * The MCP patch: one @deepseek-ai/dsh-mcp-client row per server under
 * `- insert:` (a bare row is "entry not found" — round-2 live finding M1),
 * stdio and streamable-http only. The route patch: env NAMES for the key and
 * the URL, `!!js process.env` reads, the reasoning-effort ladder, the rows a
 * headless run must not carry — and never a secret.
 */

import { parse as parseYaml } from "yaml";
import { renderDshRoutePatch, writeDshMcpConfig, writeDshRoutePatch } from "../../src/mcp/yaml.ts";
import type { SandboxInstance, SandboxCommandHandle, SandboxCommandResult, ProcessInfo } from "../../src/types.ts";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function createNoopHandle(): SandboxCommandHandle {
  return {
    processId: "p1",
    wait: async (): Promise<SandboxCommandResult> => ({ exitCode: 0, stdout: "", stderr: "" }),
    kill: async (): Promise<boolean> => true,
  };
}

function createMockSandbox() {
  const files = new Map<string, string>();
  const dirs: string[] = [];

  const sandbox: SandboxInstance = {
    sandboxId: "sbx-1",
    commands: {
      run: async (): Promise<SandboxCommandResult> => ({ exitCode: 0, stdout: "", stderr: "" }),
      spawn: async (): Promise<SandboxCommandHandle> => createNoopHandle(),
      list: async (): Promise<ProcessInfo[]> => [],
      kill: async (): Promise<boolean> => true,
    },
    files: {
      read: async (path: string): Promise<string> => {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
        return files.get(path) as string;
      },
      write: async (path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> => {
        if (typeof content !== "string") throw new Error("Mock sandbox only supports string writes in this test");
        files.set(path, content);
      },
      writeBatch: async (): Promise<void> => {},
      makeDir: async (path: string): Promise<void> => {
        dirs.push(path);
      },
    },
    getHost: async (): Promise<string> => "http://localhost:3000",
    kill: async (): Promise<void> => {},
    pause: async (): Promise<void> => {},
  };

  return {
    sandbox,
    dirs,
    text(path: string): string {
      const raw = files.get(path);
      if (raw === undefined) throw new Error(`Missing file: ${path}`);
      return raw;
    },
  };
}

// ---------------------------------------------------------------------------
// MCP patch
// ---------------------------------------------------------------------------

async function testMcpPatch(): Promise<void> {
  console.log("\n[1] writes the MCP patch: insert rows, stdio and streamable-http");

  const { sandbox, dirs, text } = createMockSandbox();
  await writeDshMcpConfig(sandbox, {
    everything: { command: "/opt/bin/mcp-server-everything", args: ["stdio"], env: { LOG: "1" }, cwd: "/srv" },
    remote: { url: "https://mcp.example.com/mcp", type: "http", headers: { Authorization: "Bearer token" } },
    bare_url: { url: "https://mcp.example.com/other" },
  });

  assert(dirs.includes("/home/user/.dsh"), "creates ~/.dsh under the default home");
  const raw = text("/home/user/.dsh/evolve-mcp.patch.yml");
  const doc = parseYaml(raw) as Array<{ insert?: Array<Record<string, unknown>> }>;
  assert(Array.isArray(doc) && doc.length === 1 && Array.isArray(doc[0]?.insert), "the file is one `- insert:` entry (bare rows are refused by dsh)");
  const rows = doc[0].insert ?? [];
  assert(rows.length === 3, "one row per server");
  assert(rows.every((row) => row.name === "@deepseek-ai/dsh-mcp-client"), "every row is a dsh-mcp-client plugin row");
  assert(same(rows.map((row) => row.id), ["evolve-mcp-everything", "evolve-mcp-remote", "evolve-mcp-bare_url"]), "row ids are evolve-mcp-<server>");

  assert(
    same(rows[0]?.config, { serverName: "everything", transport: "stdio", command: "/opt/bin/mcp-server-everything", args: ["stdio"], env: { LOG: "1" }, cwd: "/srv" }),
    "a command server is transport stdio with command/args/env/cwd",
  );
  assert(
    same(rows[1]?.config, { serverName: "remote", transport: "streamable-http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer token" } }),
    "an http server is transport streamable-http with url and headers",
  );
  assert(
    same(rows[2]?.config, { serverName: "bare_url", transport: "streamable-http", url: "https://mcp.example.com/other" }),
    "a url with no type is streamable-http (dsh has no SSE to default to)",
  );
  assert(raw.startsWith("# Evolve-owned dsh patch"), "the file names its owner");
}

async function testMcpRefusals(): Promise<void> {
  console.log("\n[2] refuses what dsh cannot serve, typed");

  const { sandbox } = createMockSandbox();
  let sse: unknown;
  try {
    await writeDshMcpConfig(sandbox, { legacy: { url: "https://mcp.example.com/sse", type: "sse" } });
  } catch (error) {
    sse = error;
  }
  assert(sse instanceof Error && sse.message.includes("sse") && sse.message.includes("legacy"), "an SSE server is refused by name (dsh speaks stdio and streamable-http only)");

  let badName: unknown;
  try {
    await writeDshMcpConfig(sandbox, { "my server!": { command: "x" } });
  } catch (error) {
    badName = error;
  }
  assert(badName instanceof Error && badName.message.includes("my server!"), "a name outside dsh-mcp-client's grammar is refused by name");

  let both: unknown;
  try {
    await writeDshMcpConfig(sandbox, { dup: { command: "x", url: "https://y" } });
  } catch (error) {
    both = error;
  }
  assert(both instanceof Error && both.message.includes("cannot specify both"), "the shared transport validation still applies");
}

// ---------------------------------------------------------------------------
// Route patch
// ---------------------------------------------------------------------------

const ROUTE = {
  path: "~/.dsh/evolve-route.patch.yml",
  providerName: "evolve",
  apiKeyEnv: "OPENROUTER_API_KEY",
  baseUrlEnv: "EVOLVE_DSH_BASE_URL",
  model: "openrouter/deepseek/deepseek-v4.1-flash",
  reasoningEffort: "high",
  contextWindow: 128000,
  maxTokens: 32000,
};

/** The `!!js` scalars have no JSON spelling; strip the tag so the rest parses as YAML. */
function parseRoutePatch(raw: string): Array<Record<string, any>> {
  return parseYaml(raw.replace(/!!js (process\.env\.[A-Z0-9_]+)/g, '"$1"')) as Array<Record<string, any>>;
}

async function testRoutePatchManaged(): Promise<void> {
  console.log("\n[3] the route patch for the managed gateway: env reads for key, URL and the three spend headers");

  const { sandbox, dirs, text } = createMockSandbox();
  await writeDshRoutePatch(sandbox, {
    ...ROUTE,
    headerEnvs: {
      "x-litellm-customer-id": "EVOLVE_LITELLM_CUSTOMER_ID",
      "x-litellm-tags": "EVOLVE_LITELLM_TAGS",
      "x-evolve-provider-runtime-binding": "EVOLVE_PROVIDER_RUNTIME_BINDING",
    },
  });
  assert(dirs.includes("/home/user/.dsh"), "creates the patch's directory");
  const raw = text("/home/user/.dsh/evolve-route.patch.yml");

  assert(raw.includes("baseURL: !!js process.env.EVOLVE_DSH_BASE_URL"), "the base URL is a `!!js process.env` read of the SDK's baseUrlEnv");
  assert(raw.includes(`apiKeyEnv: "OPENROUTER_API_KEY"`), "the key is named by env (dsh's own apiKeyEnv field), never by value");
  assert(raw.includes(`"x-litellm-customer-id": !!js process.env.EVOLVE_LITELLM_CUSTOMER_ID`), "the session tag header reads its env");
  assert(raw.includes(`"x-litellm-tags": !!js process.env.EVOLVE_LITELLM_TAGS`), "the run tag header reads its env");
  assert(raw.includes(`"x-evolve-provider-runtime-binding": !!js process.env.EVOLVE_PROVIDER_RUNTIME_BINDING`), "the runtime binding header reads its env");
  assert(!/sk-|Bearer|https?:\/\//.test(raw), "no key, no token, no URL value anywhere in the file");

  const doc = parseRoutePatch(raw);
  const byId = Object.fromEntries(doc.map((row) => [row.id, row]));
  const provider = byId["llm-pi-ai"]?.config?.providers?.evolve;
  assert(provider?.api === "openai-completions", "the route speaks openai-completions (the gateway's /v1 dialect)");
  assert(same(provider?.compat, { supportsDeveloperRole: false, maxTokensField: "max_tokens" }), "the two compat switches the vendor names for an OpenAI-compatible gateway");
  assert(same(provider?.models?.[0]?.id, ROUTE.model) && provider.models[0].contextWindow === 128000 && provider.models[0].maxTokens === 32000, "the one model row carries the wire id and its sizes");
  assert(
    same(provider?.models?.[0]?.reasoningEfforts, { low: "low", medium: "medium", high: "high" }),
    "exactly the three accepted levels are declared, each with itself as the wire spelling (no off, nothing unproven)",
  );
  assert(same(byId["agent-default-model"]?.config, { provider: "evolve", model: ROUTE.model, reasoningEffort: "high" }), "the default model row selects the route, the model and the effort");
  assert(same(byId["session-log-deepseek"]?.config, { enabled: false }), "the session-log upload is off");
  assert(same(byId["plugin-package-inventory-deepseek"]?.config, { enabled: false }), "the plugin-inventory upload is off");
  assert(byId["session-title-llm"]?.disabled === true, "the hidden title model call is off");
  assert(
    raw.includes("- id: tool-web\n  config:\n    search: false\n    fetch: true\n    searchTimeoutMs: 60000\n"),
    "the tool-web row turns web_search off (it would carry DEEPSEEK_API_KEY past the gateway) and restates fetch and the timeout, since a row replaces the whole config",
  );
  assert(same(byId["tool-web"]?.config, { search: false, fetch: true, searchTimeoutMs: 60000 }), "parsed: search off, fetch on, the base's 60 s timeout kept");
  assert(
    same(doc.map((row) => row.id), ["llm-pi-ai", "agent-default-model", "session-log-deepseek", "plugin-package-inventory-deepseek", "session-title-llm", "tool-web"]),
    "exactly these six rows, in this order",
  );
}

async function testRoutePatchWithoutHeaders(): Promise<void> {
  console.log("\n[4] external gateway / direct mode: no headers block, no effort when none");

  const raw = renderDshRoutePatch({ ...ROUTE, reasoningEffort: undefined, model: "deepseek/deepseek-v4.1-flash" });
  assert(!raw.includes("headers:"), "no headers block when no header envs are named (an unset env would be an undefined header)");
  assert(!raw.includes("reasoningEffort:"), "no reasoningEffort line when none is given (the route's default applies)");
  const doc = parseRoutePatch(raw);
  const byId = Object.fromEntries(doc.map((row) => [row.id, row]));
  assert(byId["agent-default-model"]?.config?.model === "deepseek/deepseek-v4.1-flash", "the model rides verbatim as given (direct mode passes OpenRouter's own id)");
  assert(byId["llm-pi-ai"]?.config?.providers?.evolve?.models?.[0]?.id === "deepseek/deepseek-v4.1-flash", "the model row and the default model agree");

  const homed = createMockSandbox();
  await writeDshRoutePatch(homed.sandbox, ROUTE, "/root");
  assert(homed.text("/root/.dsh/evolve-route.patch.yml").length > 0, "the `~` in the path follows the given home");
}

async function testEnvNameGuard(): Promise<void> {
  console.log("\n[5] only an environment variable NAME may ride a `!!js` read");
  let error: unknown;
  try {
    renderDshRoutePatch({ ...ROUTE, baseUrlEnv: "process.exit(1); //" });
  } catch (e) {
    error = e;
  }
  assert(error instanceof Error && error.message.includes("not an environment variable name"), "a non-identifier is refused before it can reach the YAML loader");
  let header: unknown;
  try {
    renderDshRoutePatch({ ...ROUTE, headerEnvs: { "x-a": "lower_case" } });
  } catch (e) {
    header = e;
  }
  assert(header instanceof Error, "the same guard covers header env names");
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("dsh config writers (mcp/yaml.ts)");
  console.log("=".repeat(60));

  await testMcpPatch();
  await testMcpRefusals();
  await testRoutePatchManaged();
  await testRoutePatchWithoutHeaders();
  await testEnvNameGuard();

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
