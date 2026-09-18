#!/usr/bin/env tsx
/**
 * Unit Test: observability metadata cannot rename a session
 *
 * The session envelope carries the run's identity — tag, provider, agent,
 * model, sandboxId, timestamp — and observability metadata was spread over it
 * afterwards. A metadata key called `tag` therefore did not annotate the run,
 * it renamed it: the dashboard keys a session row on (tag, userId), so one
 * sandbox arrived as two rows, the renamed one holding the events and the
 * model while gateway spend, attributed from the real session tag, stayed on
 * the original. Neither row described the run.
 *
 * What this pins down:
 *   - the Agent constructor — the door Evolve, Swarm and a hand-built Agent all
 *     pass through — rejects a reserved key and names it;
 *   - every reserved name is rejected, not just `tag`;
 *   - the metadata Swarm actually sends is still accepted;
 *   - SessionLogger keeps its own identity even when metadata carrying a
 *     reserved key reaches it by some other path, and still forwards the
 *     annotations that are not reserved.
 *
 * Usage:
 *   npm run test:unit:observability-identity
 *   npx tsx tests/unit/observability-identity.test.ts
 */

import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Agent, EvolveConfigError } from "../../dist/index.js";
import { RESERVED_OBSERVABILITY_KEYS } from "../../src/constants.js";
import type { ResolvedAgentConfig } from "../../src/types.js";

// =============================================================================
// TEST HELPERS
// =============================================================================

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

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
    console.log(`      Expected: ${String(expected)}`);
    console.log(`      Actual:   ${String(actual)}`);
  }
}

/** Run `fn`, return what it threw (or undefined if it did not throw). */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e;
  }
}

const AGENT_CONFIG: ResolvedAgentConfig = {
  type: "opencode",
  apiKey: "key",
  isDirectMode: true,
} as ResolvedAgentConfig;

// =============================================================================
// TESTS
// =============================================================================

function testReservedKeyIsNamed(): void {
  console.log("\n[1] A reserved metadata key is rejected by name");

  const error = thrownBy(
    () => new Agent(AGENT_CONFIG, { observability: { tag: "nightly" } }),
  );

  assert(error instanceof EvolveConfigError, "a metadata `tag` raises EvolveConfigError");
  assertEqual(
    (error as EvolveConfigError)?.field,
    "observability.tag",
    "the error names the offending key",
  );
  assert(
    String((error as Error)?.message).includes("reserved"),
    "the message says the key is reserved",
  );
}

function testEveryReservedKeyIsRejected(): void {
  console.log("\n[2] Every session-identity name is reserved");

  for (const key of RESERVED_OBSERVABILITY_KEYS) {
    const error = thrownBy(
      () => new Agent(AGENT_CONFIG, { observability: { [key]: "x" } }),
    );
    assertEqual(
      (error as EvolveConfigError)?.field,
      `observability.${key}`,
      `"${key}" is rejected`,
    );
  }
}

function testSwarmMetadataStillPasses(): void {
  console.log("\n[3] The metadata Swarm sends is still accepted");

  const error = thrownBy(
    () =>
      new Agent(AGENT_CONFIG, {
        observability: {
          swarmName: "batch",
          operationName: "map",
          operationId: "op-1",
          operation: "map",
          itemIndex: 0,
          role: "worker",
          errorRetry: 0,
          verifyRetry: 0,
          pipelineRunId: "run-1",
          pipelineStepIndex: 2,
        },
      }),
  );

  assertEqual(error, undefined, "Swarm's own observability fields construct fine");
}

async function testLoggerKeepsItsIdentity(): Promise<void> {
  console.log("\n[4] SessionLogger keeps its identity when metadata collides");

  // Keep the logger's local JSONL out of the real home directory: a
  // throwaway HOME, removed in the teardown.
  const originalHome = process.env.HOME;
  const originalDashboard = process.env.EVOLVE_DASHBOARD_URL;
  const tempHome = mkdtempSync(join(tmpdir(), "evolve-session-logs-"));
  process.env.HOME = tempHome;
  process.env.EVOLVE_DASHBOARD_URL = "http://localhost:3000";

  const originalFetch = globalThis.fetch;
  const originalWarn = console.warn;
  let body: Record<string, unknown> = {};
  const warnings: string[] = [];

  try {
    // Imported after HOME is set: the module resolves its log directory once.
    const { SessionLogger } = await import("../../src/observability/session-logger.js");

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    console.warn = (msg?: unknown) => {
      warnings.push(String(msg));
    };

    const logger = new SessionLogger({
      provider: "e2b",
      agent: "claude",
      model: "claude-opus-5",
      sandboxId: "sbx-1",
      tag: "evolve-realtag",
      apiKey: "key",
      observability: { tag: "nightly", model: "impostor", swarmName: "batch" },
    });

    logger.writePrompt("hello");
    await logger.flush();

    assertEqual(body.tag, "evolve-realtag", "the ingest payload keeps the session tag");
    assertEqual(body.model, "claude-opus-5", "the ingest payload keeps the session model");
    assertEqual(body.reasoningEffort, null, "a logger given no effort sends null, never an absent key (B181)");
    assertEqual(body.swarmName, "batch", "an ordinary annotation still reaches the payload");
    assert(
      warnings.some((w) => w.includes("tag")),
      "the ignored key is reported",
    );
    const offShape = new SessionLogger({
      provider: "e2b",
      agent: "claude",
      model: "claude-opus-5",
      sandboxId: "sbx-2",
      tag: "evolve-offshape",
      apiKey: "key",
      reasoningEffort: "very high",
    });
    offShape.writePrompt("hello");
    await offShape.flush();
    assertEqual(body.reasoningEffort, null, "an effort outside the wire's shape is sent as null, so the server never refuses the batch for it");
  } finally {
    globalThis.fetch = originalFetch;
    console.warn = originalWarn;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalDashboard === undefined) delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = originalDashboard;
    // The throwaway HOME goes with the run. flush() awaits the logger's local
    // write queue before returning, so the JSONL under it is settled.
    rmSync(tempHome, { recursive: true, force: true });
  }
}

async function testOrgRidesTheIngest(): Promise<void> {
  console.log("\n[5] The session's organization reaches the ingest payload");

  const originalHome = process.env.HOME;
  const originalDashboard = process.env.EVOLVE_DASHBOARD_URL;
  const tempHome = mkdtempSync(join(tmpdir(), "evolve-session-logs-"));
  process.env.HOME = tempHome;
  process.env.EVOLVE_DASHBOARD_URL = "http://localhost:3000";

  const originalFetch = globalThis.fetch;
  let body: Record<string, unknown> = {};

  try {
    const { SessionLogger } = await import("../../src/observability/session-logger.js");

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const named = new SessionLogger({
      provider: "e2b",
      agent: "claude",
      model: "claude-opus-5",
      sandboxId: "sbx-org",
      tag: "evolve-org",
      apiKey: "key",
      org: "acme",
    });
    named.writePrompt("hello");
    await named.flush();
    assertEqual(body.org, "acme", "the ingest payload names the organization the session starts under");

    const unnamed = new SessionLogger({
      provider: "e2b",
      agent: "claude",
      model: "claude-opus-5",
      sandboxId: "sbx-personal",
      tag: "evolve-personal",
      apiKey: "key",
    });
    unnamed.writePrompt("hello");
    await unnamed.flush();
    assert(!("org" in body), "no org named = the key is absent, so the server takes the personal org");

    // The builder is the public surface: .withOrg() has to reach the Agent options
    // the logger is built from, or the option exists only on the logger.
    const { Evolve } = await import("../../dist/index.js");
    const kit = new Evolve().withOrg("acme");
    assertEqual(
      (kit as unknown as { config: { org?: string } }).config.org,
      "acme",
      "Evolve.withOrg() records the organization on the run config",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalDashboard === undefined) delete process.env.EVOLVE_DASHBOARD_URL;
    else process.env.EVOLVE_DASHBOARD_URL = originalDashboard;
    rmSync(tempHome, { recursive: true, force: true });
  }
}

// =============================================================================
// RUNNER
// =============================================================================

async function main(): Promise<void> {
  console.log("Observability metadata cannot rename a session\n" + "=".repeat(60));

  testReservedKeyIsNamed();
  testEveryReservedKeyIsRejected();
  testSwarmMetadataStillPasses();
  await testLoggerKeepsItsIdentity();
  await testOrgRidesTheIngest();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Test runner error:", e);
  process.exit(1);
});
