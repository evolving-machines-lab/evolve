#!/usr/bin/env tsx
/**
 * Unit Test: the SDK half of the contract drift gate.
 *
 * spec/openapi.yaml calls itself the single source of truth, and until this
 * file existed only its ErrorCode enum was machine-checked — every operation
 * and artifact-selector claim in it could drift from the client silently. This
 * gate holds the SDK to the contract on three axes:
 *
 *   1. OPERATIONS. Every operationId in the spec appears in the explicit
 *      map below, and every wave-1 operation resolves to a real client
 *      method. The map is maintained by hand ON PURPOSE: it doubles as the
 *      documentation of which spec operation each SDK method serves, and a
 *      new operation fails the gate until someone states its SDK answer.
 *      Wave-aware: an operation marked `x-wave: 2` may map to null (declared
 *      "not in the SDK yet"), a wave-1 operation may not.
 *
 *   2. ERROR CODES. HOSTED_ERROR_CODES equals the spec's ErrorCode enum
 *      byte-exactly — same members, same order — sourced from the spec
 *      itself, not from a shadow copy (hosted-error-codes.test.ts proves the
 *      shadow separately).
 *
 *   3. ARTIFACT SELECTORS. TRIAL_ARTIFACT_STREAMS equals the trace route's
 *      `?stream=` enum byte-exactly. The SDK ships wave-2 selectors ahead of
 *      the server (the route refuses them until its wave lands), so equality
 *      against the full enum is exactly the law.
 *
 *   4. STATUS + PROVIDER VOCABULARIES. TRIAL_STATUSES and
 *      EVAL_SANDBOX_PROVIDERS — the runtime lists the CLI validates flags
 *      against — equal the contract's own enums byte-exactly.
 *
 *   5. SPEND VOCABULARY. The published `SpendSource` union equals the
 *      contract's own enum. It is type-only (nothing validates a spend lane
 *      at runtime, so a runtime copy would be dead weight), so it is read out
 *      of the source the package ships — the axis that was missing while the
 *      platform stamped three lanes and the type still offered two.
 *
 * The spec is parsed line-by-line against its own committed formatting. That
 * is a deliberate trade: the file is hand-written, its indentation is part of
 * its style, and a parse that finds nothing fails loudly (non-vacuity checks
 * below) rather than passing empty.
 *
 * Usage:
 *   npx tsx tests/unit/hosted-spec-gate.test.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  AGENT_EFFORT_SUPPORT_VALUES,
  EVAL_SANDBOX_PROVIDERS,
  HOSTED_ERROR_CODES,
  TRIAL_ARTIFACT_STREAMS,
  TRIAL_STATUSES,
  agents,
  auth,
  datasets,
  jobs,
  meta,
  skills,
  trials,
} from "../../src/hosted/index";

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

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
// The contract lives in the private server repo; EVOLVE_OPENAPI_SPEC_PATH
// points at a checkout of it. The repo-root path stays as the legacy
// fallback for checkouts that still carry a copy.
const SPEC_PATH =
  process.env.EVOLVE_OPENAPI_SPEC_PATH ?? join(PACKAGE_ROOT, "..", "..", "spec", "openapi.yaml");
if (!existsSync(SPEC_PATH)) {
  console.log("SKIP: spec not present — gate runs in private CI or with EVOLVE_OPENAPI_SPEC_PATH");
  process.exit(0);
}
const specLines = readFileSync(SPEC_PATH, "utf8").split("\n");

console.log("\n=== Hosted spec drift gate (vs spec/openapi.yaml) ===\n");

// -----------------------------------------------------------------------------
// Parse the spec: operations (+ operation-level x-wave), the ErrorCode enum,
// and the trace route's stream-selector enum. Operation-level keys sit at
// exactly 6 spaces; parameter-level x-wave markers sit deeper and are not the
// operation's wave.
// -----------------------------------------------------------------------------

const specOperations = new Map<string, number>(); // operationId -> wave
const runtimePlaneOperations = new Set<string>(); // operations marked x-plane: sdk-runtime
{
  let current: string | null = null;
  for (const line of specLines) {
    const op = /^ {6}operationId: (\w+)\s*$/.exec(line);
    if (op) {
      current = op[1];
      specOperations.set(current, 1);
      continue;
    }
    const wave = /^ {6}x-wave: (\d+)\s*$/.exec(line);
    if (wave && current) specOperations.set(current, Number(wave[1]));
    const plane = /^ {6}x-plane: sdk-runtime\s*$/.exec(line);
    if (plane && current) {
      runtimePlaneOperations.add(current);
      specOperations.delete(current);
    }
  }
}

function enumEntries(startPredicate: (line: string) => boolean, endPredicate: (line: string) => boolean, entryPattern: RegExp): string[] {
  const out: string[] = [];
  let inside = false;
  for (const line of specLines) {
    if (!inside) {
      if (startPredicate(line)) inside = true;
      continue;
    }
    if (endPredicate(line)) break;
    const entry = entryPattern.exec(line);
    if (entry) out.push(entry[1]);
  }
  return out;
}

// The ErrorCode schema's enum: from the schema key to the next 4-space schema.
const specErrorCodes = enumEntries(
  (line) => /^ {4}ErrorCode:\s*$/.test(line),
  (line) => /^ {4}[A-Z]\w*:\s*$/.test(line),
  /^ {8}- ([a-z_]+)\s*(?:#.*)?$/
);

// The trace route's `stream` parameter enum: from its `- name: stream` line to
// the next parameter.
const specStreamSelectors = enumEntries(
  (line) => /^ {8}- name: stream\s*$/.test(line),
  (line) => /^ {8}- name: /.test(line),
  /^ {14}- ([a-z-]+)\s*(?:#.*)?$/
);

// Non-vacuity: a parse that found nothing must fail here, never pass empty.
assert(specOperations.size >= 25, `the spec declares operations (${specOperations.size} found)`);
assert(specErrorCodes.length > 10, `the spec's ErrorCode enum parsed (${specErrorCodes.length} codes)`);
assert(specStreamSelectors.length >= 4, `the spec's stream-selector enum parsed (${specStreamSelectors.length} selectors)`);

// -----------------------------------------------------------------------------
// 1. OPERATIONS — the operationId -> client-method map. This IS the
// documentation of which SDK method serves which contract operation; null
// means "wave-gated and not in the SDK yet", legal only past wave 1.
// -----------------------------------------------------------------------------

const cfg = { apiKey: "drift-gate", baseUrl: "http://localhost:0" };
const surfaces: Record<string, unknown> = {
  jobs: jobs(cfg),
  trials: trials(cfg),
  datasets: datasets(cfg),
  agents: agents(cfg),
  skills: skills(cfg),
  auth: auth(cfg),
  meta,
};

const OPERATION_TO_METHOD: Record<string, string | null> = {
  // Jobs
  createJob: "jobs.start",
  listJobs: "jobs.list",
  compareJobs: "jobs.compare",
  getJob: "jobs.get",
  cancelJob: "jobs.cancel",
  watchJob: "jobs.watch",
  downloadJob: "jobs.download",
  resumeJob: "jobs.resume",
  retryJob: "jobs.retry",
  regradeJob: "jobs.regrade",
  grepJob: "jobs.grep",
  listJobTrials: "jobs.trials",
  listJobTasks: "jobs.tasks",
  // Trials (globally addressable)
  getTrial: "trials.get",
  getTrialTrace: "trials.trace", // ?stream= raw selectors ride trials.artifact
  listTrialFiles: "trials.files",
  getTrialFile: "trials.file",
  retryTrial: "trials.retry",
  regradeTrial: "trials.regrade",
  stopTrials: "trials.stop",
  // Datasets
  listDatasets: "datasets.list",
  getDataset: "datasets.get",
  updateDataset: "datasets.update",
  deleteDataset: "datasets.delete",
  downloadDataset: "datasets.download",
  activateDatasetVersion: "datasets.activate",
  publishDataset: "datasets.publish",
  listDatasetImports: "datasets.listImports",
  getDatasetImport: "datasets.getImport",
  // Agents (bring-your-own)
  registerAgent: "agents.create",
  listAgents: "agents.list",
  getAgent: "agents.get",
  upsertAgent: "agents.upsert",
  deleteAgent: "agents.delete",
  // Skills (platform uploads referenced as upload:<id> in agents[].skills)
  uploadSkill: "skills.upload",
  listSkills: "skills.list",
  getSkill: "skills.get",
  deleteSkill: "skills.delete",
  // Meta + auth
  getMeta: "meta",
  getAuthStatus: "auth.status",
  listApiKeys: null, // wave 2 — no SDK method yet
  revokeApiKey: null, // wave 2 — no SDK method yet
};

function resolve(path: string): unknown {
  const [head, method] = path.split(".");
  const target = surfaces[head];
  return method === undefined ? target : (target as Record<string, unknown>)?.[method];
}

// -----------------------------------------------------------------------------
// 1b. RUNTIME-PLANE OPERATIONS — the spec's `x-plane: sdk-runtime` doors (the
// managed-agents surface). They are NOT served by the hosted clients this
// file exercises, so they carry their own hand-maintained map: operationId ->
// the SDK module that speaks that door. Same law as the hosted map — a new
// runtime operation fails the gate until someone states its SDK answer, and
// a map entry whose operation left the spec fails as phantom.
// -----------------------------------------------------------------------------

const RUNTIME_OPERATION_TO_MODULE: Record<string, string> = {
  listSessions: "src/sessions/index.ts",
  deleteSessions: "src/sessions/index.ts",
  getSession: "src/sessions/index.ts",
  deleteSession: "src/sessions/index.ts",
  ingestSessionEvents: "src/observability/session-logger.ts",
  getSessionSpend: "src/sessions/index.ts (cost surface)",
  listCheckpoints: "src/storage/index.ts",
  createCheckpoint: "src/storage/index.ts",
  getCheckpoint: "src/storage/index.ts",
  presignCheckpointTransfer: "src/storage/index.ts",
  listManagedSecrets: "src/managed-secrets.ts",
  createManagedRuntimeToken: "src/managed-secrets.ts",
  extendManagedRuntimeToken: "src/managed-secrets.ts",
  revokeManagedRuntimeToken: "src/managed-secrets.ts",
  createProviderRuntimeToken: "src/provider-secrets.ts",
  extendProviderRuntimeToken: "src/provider-secrets.ts",
  revokeProviderRuntimeToken: "src/provider-secrets.ts",
  listBrowserCredentials: "src/browser-credentials.ts",
  storeBrowserCredential: "src/browser-credentials.ts",
  deleteBrowserCredentials: "src/browser-credentials.ts",
  deleteBrowserCredential: "src/browser-credentials.ts",
  getBrowserCredentialsPublicKey: "src/browser-credentials.ts",
  createBrowserLoginMcpConfig: "src/browser.ts",
  listBrowserProfiles: "src/browser-profiles.ts",
  deleteBrowserProfile: "src/browser-profiles.ts",
  createBrowserSession: "src/browser.ts",
  deleteBrowserSession: "src/browser.ts",
  createIntegrationSession: "src/integrations.ts",
  updateIntegrationAccounts: "src/integrations.ts",
  connectIntegration: "src/integrations.ts",
  disconnectIntegration: "src/integrations.ts",
  getIntegrationsStatus: "src/integrations.ts",
  proxyDaytonaGet: "src/agent.ts (managed door)",
  proxyDaytonaPost: "src/agent.ts (managed door)",
  proxyDaytonaDelete: "src/agent.ts (managed door)",
  proxyDaytonaToolboxGet: "src/agent.ts (managed door)",
  proxyDaytonaToolboxPost: "src/agent.ts (managed door)",
  proxyDaytonaToolboxDelete: "src/agent.ts (managed door)",
  proxyE2bGet: "src/agent.ts (managed door)",
  proxyE2bPost: "src/agent.ts (managed door)",
  proxyE2bDelete: "src/agent.ts (managed door)",
  proxyModalGet: "src/utils/managed-modal.ts",
  proxyModalPost: "src/utils/managed-modal.ts",
  proxyModalDelete: "src/utils/managed-modal.ts",
};

const runtimeUnmapped = [...runtimePlaneOperations].filter(
  (id) => !(id in RUNTIME_OPERATION_TO_MODULE)
);
assert(
  runtimeUnmapped.length === 0,
  runtimeUnmapped.length === 0
    ? `every runtime-plane operation has a stated SDK module (${runtimePlaneOperations.size} doors)`
    : `runtime operations missing from the map (state their SDK answer): ${runtimeUnmapped.join(", ")}`
);
const runtimePhantom = Object.keys(RUNTIME_OPERATION_TO_MODULE).filter(
  (id) => !runtimePlaneOperations.has(id)
);
assert(
  runtimePhantom.length === 0,
  runtimePhantom.length === 0
    ? "the runtime map invents no operation the spec does not declare"
    : `runtime map entries with no spec operation: ${runtimePhantom.join(", ")}`
);
assert(
  runtimePlaneOperations.size >= 25,
  `the runtime plane parsed (${runtimePlaneOperations.size} operations found)`
);

const unmapped = [...specOperations.keys()].filter((id) => !(id in OPERATION_TO_METHOD));
assert(
  unmapped.length === 0,
  unmapped.length === 0
    ? "every spec operationId has an entry in the map"
    : `spec operations missing from the map (state their SDK answer): ${unmapped.join(", ")}`
);

const phantom = Object.keys(OPERATION_TO_METHOD).filter((id) => !specOperations.has(id));
assert(
  phantom.length === 0,
  phantom.length === 0
    ? "the map invents no operation the spec does not declare"
    : `map entries with no spec operation: ${phantom.join(", ")}`
);

const nullWave1 = [...specOperations.entries()]
  .filter(([id, wave]) => wave === 1 && OPERATION_TO_METHOD[id] === null)
  .map(([id]) => id);
assert(
  nullWave1.length === 0,
  nullWave1.length === 0
    ? "no wave-1 operation is declared absent from the SDK"
    : `wave-1 operations mapped to null: ${nullWave1.join(", ")}`
);

const unreachable = Object.entries(OPERATION_TO_METHOD)
  .filter(([, path]) => path !== null)
  .filter(([, path]) => typeof resolve(path as string) !== "function")
  .map(([id, path]) => `${id} -> ${path}`);
assert(
  unreachable.length === 0,
  unreachable.length === 0
    ? "every mapped method is reachable as a function on its client"
    : `mapped methods that do not resolve: ${unreachable.join(", ")}`
);

// -----------------------------------------------------------------------------
// 2. ERROR CODES — byte-exact against the contract's own enum.
// -----------------------------------------------------------------------------

assert(
  JSON.stringify([...HOSTED_ERROR_CODES]) === JSON.stringify(specErrorCodes),
  JSON.stringify([...HOSTED_ERROR_CODES]) === JSON.stringify(specErrorCodes)
    ? `HOSTED_ERROR_CODES is the spec's ErrorCode enum, byte-exactly (${specErrorCodes.length} codes)`
    : `HOSTED_ERROR_CODES drifted from the spec enum (SDK ${HOSTED_ERROR_CODES.length}, spec ${specErrorCodes.length})`
);

// -----------------------------------------------------------------------------
// 3. ARTIFACT SELECTORS — byte-exact against the trace route's stream enum.
// -----------------------------------------------------------------------------

assert(
  JSON.stringify([...TRIAL_ARTIFACT_STREAMS]) === JSON.stringify(specStreamSelectors),
  JSON.stringify([...TRIAL_ARTIFACT_STREAMS]) === JSON.stringify(specStreamSelectors)
    ? `TRIAL_ARTIFACT_STREAMS is the spec's stream enum, byte-exactly (${specStreamSelectors.join(", ")})`
    : `artifact selectors drifted: SDK [${TRIAL_ARTIFACT_STREAMS.join(", ")}] vs spec [${specStreamSelectors.join(", ")}]`
);

// -----------------------------------------------------------------------------
// 4. STATUS + PROVIDER VOCABULARIES — the runtime lists the CLI validates
// flags against, byte-exact against the contract's own enums.
// -----------------------------------------------------------------------------

/** A schema's inline `enum: [a, b, c]` line, scoped to that schema's block. */
function inlineEnum(schemaName: string): string[] {
  let inside = false;
  for (const line of specLines) {
    if (!inside) {
      if (new RegExp(`^ {4}${schemaName}:\\s*$`).test(line)) inside = true;
      continue;
    }
    if (/^ {4}[A-Z]\w*:\s*$/.test(line)) break;
    const m = /^ {6}enum: \[([^\]]+)\]\s*$/.exec(line);
    if (m) return m[1].split(",").map((s) => s.trim());
  }
  return [];
}

const specTrialStatuses = enumEntries(
  (line) => /^ {4}TrialStatus:\s*$/.test(line),
  (line) => /^ {4}[A-Z]\w*:\s*$/.test(line),
  /^ {8}- ([A-Z_]+)\s*(?:#.*)?$/
);
const specProviders = inlineEnum("SandboxProvider");

assert(specTrialStatuses.length >= 8, `the spec's TrialStatus enum parsed (${specTrialStatuses.length} members)`);
assert(specProviders.length >= 3, `the spec's SandboxProvider enum parsed (${specProviders.length} members)`);

assert(
  JSON.stringify([...TRIAL_STATUSES]) === JSON.stringify(specTrialStatuses),
  JSON.stringify([...TRIAL_STATUSES]) === JSON.stringify(specTrialStatuses)
    ? `TRIAL_STATUSES is the spec's TrialStatus enum, byte-exactly (${specTrialStatuses.length} members)`
    : `trial statuses drifted: SDK [${TRIAL_STATUSES.join(", ")}] vs spec [${specTrialStatuses.join(", ")}]`
);

assert(
  JSON.stringify([...EVAL_SANDBOX_PROVIDERS]) === JSON.stringify(specProviders),
  JSON.stringify([...EVAL_SANDBOX_PROVIDERS]) === JSON.stringify(specProviders)
    ? `EVAL_SANDBOX_PROVIDERS is the spec's SandboxProvider enum, byte-exactly (${specProviders.join(", ")})`
    : `providers drifted: SDK [${EVAL_SANDBOX_PROVIDERS.join(", ")}] vs spec [${specProviders.join(", ")}]`
);

// -----------------------------------------------------------------------------
// 5. SPEND VOCABULARY — the money-reading path. `SpendSource` is a type-only
// union, and a type cannot be read at run time, so the union is parsed out of
// the source this package publishes and held to the contract member for
// member. A caller branching on a lane the platform stamps must compile.
// -----------------------------------------------------------------------------

const TYPES_SOURCE = readFileSync(join(PACKAGE_ROOT, "src", "hosted", "types.ts"), "utf8");
const declaredSpendSources = (/export type SpendSource =([^;]+);/.exec(TYPES_SOURCE)?.[1] ?? "")
  .split("|")
  .map((member) => member.trim().replace(/^"|"$/g, ""))
  .filter((member) => member.length > 0);
const specSpendSources = inlineEnum("SpendSource");

assert(specSpendSources.length >= 3, `the spec's SpendSource enum parsed (${specSpendSources.length} lanes)`);
assert(
  declaredSpendSources.length >= 3,
  `the published SpendSource union parsed from types.ts (${declaredSpendSources.length} lanes)`
);

assert(
  JSON.stringify(declaredSpendSources) === JSON.stringify(specSpendSources),
  JSON.stringify(declaredSpendSources) === JSON.stringify(specSpendSources)
    ? `SpendSource is the spec's enum, byte-exactly (${specSpendSources.join(", ")})`
    : `spend lanes drifted: SDK [${declaredSpendSources.join(", ")}] vs spec [${specSpendSources.join(", ")}]`
);

// -----------------------------------------------------------------------------
// 6. AGENT EFFORT VOCABULARY — the axis the effort_support CRITICAL proved
// missing: the spec typed the field as a boolean while the server served a
// three-value string, and no gate on any side noticed. The published runtime
// list AND the published union are both held to the contract's enum.
// -----------------------------------------------------------------------------

/** A property's inline `enum: [a, b, c]` line, scoped to one schema's block. */
function propertyEnum(schemaName: string, property: string): string[] {
  let inSchema = false;
  let inProperty = false;
  for (const line of specLines) {
    if (!inSchema) {
      if (new RegExp(`^ {4}${schemaName}:\\s*$`).test(line)) inSchema = true;
      continue;
    }
    if (/^ {4}[A-Z]\w*:\s*$/.test(line)) break;
    if (new RegExp(`^ {8}${property}:\\s*$`).test(line)) {
      inProperty = true;
      continue;
    }
    if (inProperty) {
      if (/^ {8}\w/.test(line)) break; // the next property ends the scope
      const m = /^ {10}enum: \[([^\]]+)\]\s*$/.exec(line);
      if (m) return m[1].split(",").map((s) => s.trim());
    }
  }
  return [];
}

const specEffortSupport = propertyEnum("AgentCapability", "effort_support");
assert(
  specEffortSupport.length >= 3,
  `the spec's AgentCapability.effort_support enum parsed (${specEffortSupport.length} members)`
);
assert(
  JSON.stringify([...AGENT_EFFORT_SUPPORT_VALUES]) === JSON.stringify(specEffortSupport),
  JSON.stringify([...AGENT_EFFORT_SUPPORT_VALUES]) === JSON.stringify(specEffortSupport)
    ? `AGENT_EFFORT_SUPPORT_VALUES is the spec's enum, byte-exactly (${specEffortSupport.join(", ")})`
    : `effort_support drifted: SDK [${AGENT_EFFORT_SUPPORT_VALUES.join(", ")}] vs spec [${specEffortSupport.join(", ")}]`
);

// The published AgentEffortSupport union derives from the runtime list
// (`(typeof AGENT_EFFORT_SUPPORT_VALUES)[number]`), so holding the list to
// the contract holds the type with it — asserted through the source so a
// hand-rewritten literal union cannot quietly replace the derivation.
assert(
  /export type AgentEffortSupport = \(typeof AGENT_EFFORT_SUPPORT_VALUES\)\[number\];/.test(
    TYPES_SOURCE
  ),
  "AgentEffortSupport derives from AGENT_EFFORT_SUPPORT_VALUES (no shadow union)"
);

console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
if (failed > 0) process.exit(1);
