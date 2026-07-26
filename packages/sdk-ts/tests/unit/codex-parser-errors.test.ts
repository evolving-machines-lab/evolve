#!/usr/bin/env tsx
/**
 * Unit Test: Codex parser — harness-reported FAILURES
 *
 * REGRESSION (2026-07-26). codex streams its failures on stdout as JSONL
 * ({"type":"error"}, {"type":"turn.failed"}) while stderr says only
 * "Reading prompt from stdin...". This parser dropped both through its default
 * case, so a codex run that could not reach the model produced ZERO events and
 * was indistinguishable from a run that did nothing — the exact blindness that
 * cost a full night of diagnosis on a "stream disconnected before completion"
 * failure.
 *
 * The fix must hold BOTH properties at once:
 *   1. the failure is surfaced, verbatim, so a transcript shows what happened;
 *   2. it is NOT counted as agent work — because the eval runner's
 *      harnessNeverRan law keys on "zero trace events", and if a surfaced error
 *      satisfied that count, every unreachable-model run would stop being an
 *      infrastructure failure and start being a SCORED ZERO.
 * The second property is why these are their own `error` variant rather than
 * message chunks, and why isAgentWorkUpdate exists.
 */

import { createCodexParser } from "../../src/parsers/codex.ts";
import { isAgentWorkUpdate } from "../../src/parsers/types.ts";
import type { OutputEvent } from "../../src/parsers/types.ts";

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

/** The exact stdout codex produced in the failing daytona/modal trials. */
const REAL_FAILURE_STREAM = [
  `{"type":"thread.started","thread_id":"019f9d12-8645-7933-94fc-b81f13f3c232"}`,
  `{"type":"turn.started"}`,
  `{"type":"error","message":"stream disconnected before completion: error sending request for url (https://example.trycloudflare.com/api/model-gateway/v1/responses)"}`,
  `{"type":"turn.failed","error":{"message":"stream disconnected before completion: error sending request for url (https://example.trycloudflare.com/api/model-gateway/v1/responses)"}}`,
];

function parseAll(lines: string[]): OutputEvent[] {
  const parse = createCodexParser();
  const out: OutputEvent[] = [];
  for (const line of lines) {
    const events = parse(line);
    if (events) out.push(...events);
  }
  return out;
}

async function testTopLevelErrorSurfaced(): Promise<void> {
  console.log("\nTop-level error events are surfaced, not dropped");
  const events = parseAll(REAL_FAILURE_STREAM);
  const errors = events.filter(e => (e.update as { sessionUpdate?: string })?.sessionUpdate === "error");
  assert(errors.length === 2, `both error + turn.failed surfaced (got ${errors.length})`);
  const first = errors[0].update as { message: string; fatal: boolean };
  assert(
    first.message.includes("stream disconnected before completion"),
    "carries the harness's own message verbatim",
  );
  assert(first.message.includes("/v1/responses"), "keeps the endpoint that failed");
  assert(first.fatal === false, "a retryable error is not marked fatal");
  const last = errors[1].update as { fatal: boolean };
  assert(last.fatal === true, "turn.failed IS marked fatal");
}

async function testErrorsAreNotWork(): Promise<void> {
  console.log("\nTHE HONESTY LAW: a surfaced error is never counted as agent work");
  const events = parseAll(REAL_FAILURE_STREAM);
  assert(events.length > 0, "the run produced events at all (previously zero)");
  const work = events.filter(e => isAgentWorkUpdate(e.update as { sessionUpdate?: unknown }));
  assert(
    work.length === 0,
    `an error-only run has ZERO work events, so harnessNeverRan still fires (got ${work.length})`,
  );
}

async function testRealWorkStillCounts(): Promise<void> {
  console.log("\nReal output is still work");
  const events = parseAll([
    `{"type":"item.completed","item":{"id":"i1","type":"agent_message","text":"hello"}}`,
  ]);
  const work = events.filter(e => isAgentWorkUpdate(e.update as { sessionUpdate?: unknown }));
  assert(work.length === 1, "an agent message counts as work");
}

async function testErrorItemCompleted(): Promise<void> {
  console.log("\nitem.completed carrying an error item is surfaced too");
  const events = parseAll([
    `{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Falling back from WebSockets to HTTPS transport."}}`,
  ]);
  const update = events[0]?.update as { sessionUpdate?: string; message?: string; fatal?: boolean };
  assert(update?.sessionUpdate === "error", "mapped to the error variant");
  assert(!!update?.message?.includes("Falling back"), "keeps the message");
  assert(update?.fatal === false, "not fatal — the turn may still succeed");
  assert(!isAgentWorkUpdate(update), "still not counted as work");
}

async function testMalformedErrorDoesNotThrow(): Promise<void> {
  console.log("\nMalformed failures degrade instead of throwing");
  const events = parseAll([
    `{"type":"error"}`,
    `{"type":"turn.failed"}`,
  ]);
  assert(events.length === 2, "both still surface");
  for (const e of events) {
    const u = e.update as { message?: string };
    assert(typeof u.message === "string" && u.message.length > 0, "message is always a non-empty string");
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Codex Parser — harness-reported failures");
  console.log("=".repeat(60));

  await testTopLevelErrorSurfaced();
  await testErrorsAreNotWork();
  await testRealWorkStillCounts();
  await testErrorItemCompleted();
  await testMalformedErrorDoesNotThrow();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
