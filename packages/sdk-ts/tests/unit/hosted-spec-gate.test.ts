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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  EVAL_SANDBOX_PROVIDERS,
  HOSTED_ERROR_CODES,
  TRIAL_ARTIFACT_STREAMS,
  TRIAL_STATUSES,
  agents,
  auth,
  datasets,
  jobs,
  meta,
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
const SPEC_PATH = join(PACKAGE_ROOT, "..", "..", "spec", "openapi.yaml");
const specLines = readFileSync(SPEC_PATH, "utf8").split("\n");

console.log("\n=== Hosted spec drift gate (vs spec/openapi.yaml) ===\n");

// -----------------------------------------------------------------------------
// Parse the spec: operations (+ operation-level x-wave), the ErrorCode enum,
// and the trace route's stream-selector enum. Operation-level keys sit at
// exactly 6 spaces; parameter-level x-wave markers sit deeper and are not the
// operation's wave.
// -----------------------------------------------------------------------------

const specOperations = new Map<string, number>(); // operationId -> wave
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
  regradeJob: "jobs.regrade",
  listJobTrials: "jobs.trials",
  listJobTasks: "jobs.tasks",
  // Trials (globally addressable)
  getTrial: "trials.get",
  getTrialTrace: "trials.trace", // ?stream= raw selectors ride trials.artifact
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

console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
if (failed > 0) process.exit(1);
