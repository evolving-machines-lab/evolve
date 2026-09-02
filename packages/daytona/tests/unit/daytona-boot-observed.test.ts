#!/usr/bin/env tsx
/**
 * Unit Test: createSandboxObserved — the boot-progress hook
 *
 * Tests:
 *   1. daytonaBootPhaseOf() — the two-word phase map over Daytona states
 *   2. the create is stamped with DAYTONA_BOOT_LABEL beside the caller's
 *      labels, and the SDK wall clock is OFF (timeout 0)
 *   3. progress: the row found by label, every state change, every build-log
 *      line (a multi-line chunk becomes several events), phases attached
 *   4. the create's own verdicts pass through untouched (resolve / reject)
 *   5. abort: rejects with DaytonaBootAbortedError naming phase/state/id,
 *      deletes the row known now, and deletes what the abandoned create yields
 *   6. an abort after the create settled is a no-op (no unhandled rejection)
 *
 * Usage:
 *   npx tsx tests/unit/daytona-boot-observed.test.ts
 */

import {
  DAYTONA_BOOT_LABEL,
  DaytonaBootAbortedError,
  createSandboxObserved,
  daytonaBootPhaseOf,
  type DaytonaBootClient,
  type DaytonaBootProgress,
} from "../../src/index.ts";

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

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message} (expected ${e}, got ${a})`);
  }
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A row as the control plane reports it: state set by the test, deletes recorded. */
interface FakeRow {
  id: string;
  state: string | undefined;
  refreshes: number;
  deletes: number;
  refreshData(): Promise<void>;
  delete(): Promise<void>;
}

function fakeRow(id: string, state: string): FakeRow {
  return {
    id,
    state,
    refreshes: 0,
    deletes: 0,
    async refreshData() {
      this.refreshes++;
    },
    async delete() {
      this.deletes++;
    },
  };
}

/**
 * A Daytona stand-in: create() hands back a promise the test settles, list()
 * answers with the row once `visible`, and every create call is recorded.
 */
function fakeClient(row: FakeRow | null, opts: { hidden?: boolean } = {}) {
  const calls: Array<{ params: Record<string, unknown>; options: Record<string, unknown> }> = [];
  let visible = row !== null && !opts.hidden;
  let logSink: ((chunk: string) => void) | undefined;
  let resolveCreate!: (sandbox: unknown) => void;
  let rejectCreate!: (err: unknown) => void;
  const created = new Promise<unknown>((resolve, reject) => {
    resolveCreate = resolve;
    rejectCreate = reject;
  });
  const client: DaytonaBootClient = {
    create(params, options) {
      calls.push({ params: params as Record<string, unknown>, options });
      logSink = options.onSnapshotCreateLogs;
      return created as never;
    },
    async *list(query) {
      const labels = (query as { labels?: Record<string, string> }).labels ?? {};
      if (visible && row && labels[DAYTONA_BOOT_LABEL]) yield row as never;
    },
  };
  return {
    client,
    calls,
    show: () => {
      visible = true;
    },
    log: (chunk: string) => logSink?.(chunk),
    resolveCreate,
    rejectCreate,
  };
}

async function testPhaseMap(): Promise<void> {
  console.log("\n[1] daytonaBootPhaseOf — two words over Daytona's states");
  assertEqual(daytonaBootPhaseOf("pending_build"), "image_pull", "pending_build is image_pull");
  assertEqual(daytonaBootPhaseOf("building_snapshot"), "image_pull", "building_snapshot is image_pull");
  assertEqual(daytonaBootPhaseOf("pulling_snapshot"), "image_pull", "pulling_snapshot is image_pull");
  assertEqual(daytonaBootPhaseOf("creating"), "boot", "creating is boot");
  assertEqual(daytonaBootPhaseOf("starting"), "boot", "starting is boot");
  assertEqual(daytonaBootPhaseOf("started"), "boot", "started is boot");
  assertEqual(daytonaBootPhaseOf(null), "boot", "no state yet is boot (the only fact known)");
  assertEqual(daytonaBootPhaseOf(undefined), "boot", "undefined state is boot");
}

async function testCreateShape(): Promise<void> {
  console.log("\n[2] the create call: boot label beside the caller's labels, SDK wall clock off");
  const row = fakeRow("sbx-shape", "started");
  const fake = fakeClient(row);
  const run = createSandboxObserved(
    fake.client,
    { image: "alpine:3.20", labels: { evolve_role: "trial" } } as never,
    { pollMs: 5 }
  );
  fake.resolveCreate(row);
  const out = await run;
  assert(out === (row as unknown), "resolves with what the SDK create resolved");
  assertEqual(fake.calls.length, 1, "exactly one create");
  const labels = fake.calls[0].params.labels as Record<string, string>;
  assertEqual(labels.evolve_role, "trial", "the caller's labels survive");
  assert(
    typeof labels[DAYTONA_BOOT_LABEL] === "string" && labels[DAYTONA_BOOT_LABEL].length >= 32,
    "the boot label is a fresh id"
  );
  assertEqual(fake.calls[0].params.image, "alpine:3.20", "the image passes through");
  assertEqual(fake.calls[0].options.timeout, 0, "timeout 0 — the SDK's own wall clock is off");
  assert(typeof fake.calls[0].options.onSnapshotCreateLogs === "function", "the build log is subscribed");
}

async function testProgress(): Promise<void> {
  console.log("\n[3] progress: row found by label, state changes, build-log lines, phases");
  const listed = fakeRow("sbx-progress", "pending_build");
  const fake = fakeClient(listed, { hidden: true });
  const events: DaytonaBootProgress[] = [];
  const run = createSandboxObserved(fake.client, { image: "img:1" } as never, {
    pollMs: 5,
    onProgress: (p) => events.push(p),
  });
  await tick(12);
  assertEqual(events.length, 0, "nothing reported while the row is not listable yet");

  // The build speaks before the poller finds the row: still image_pull.
  fake.log("#1 [internal] load build definition\n#2 [1/1] FROM docker.io/library/img:1\n");
  assertEqual(
    events.map((e) => [e.signal, e.phase, e.state, e.sandboxId, e.line]),
    [
      ["build_log", "image_pull", null, null, "#1 [internal] load build definition"],
      ["build_log", "image_pull", null, null, "#2 [1/1] FROM docker.io/library/img:1"],
    ],
    "a multi-line chunk is one event per non-empty line, phase image_pull, before any state"
  );

  // The control plane now has the row: the next poll finds it by label.
  fake.show();
  await tick(12);
  const found = events[2];
  assertEqual(
    [found?.signal, found?.phase, found?.state, found?.sandboxId],
    ["state", "image_pull", "pending_build", "sbx-progress"],
    "the row found by label is a state event carrying id and state"
  );

  listed.state = "building_snapshot";
  await tick(12);
  listed.state = "building_snapshot";
  await tick(12);
  listed.state = "starting";
  await tick(12);
  const states = events.filter((e) => e.signal === "state").map((e) => [e.state, e.phase]);
  assertEqual(
    states,
    [
      ["pending_build", "image_pull"],
      ["building_snapshot", "image_pull"],
      ["starting", "boot"],
    ],
    "every state CHANGE is one event (an unchanged read is silence); starting is boot"
  );
  assert(listed.refreshes >= 3, `the found row is refreshed on the clock (${listed.refreshes} refreshes)`);

  fake.resolveCreate(listed);
  await run;
  const refreshesAtResolve = listed.refreshes;
  await tick(20);
  assertEqual(listed.refreshes, refreshesAtResolve, "the watcher stops once the create settled");
}

async function testVerdictsPassThrough(): Promise<void> {
  console.log("\n[4] the create's own verdicts pass through untouched");
  const fake = fakeClient(fakeRow("sbx-fail", "building_snapshot"));
  const run = createSandboxObserved(fake.client, { image: "img:1" } as never, { pollMs: 5 });
  const boom = new Error("Sandbox sbx-fail failed to start with status: build_failed, error reason: no space");
  fake.rejectCreate(boom);
  let caught: unknown;
  try {
    await run;
  } catch (e) {
    caught = e;
  }
  assert(caught === boom, "a rejected create rejects with the SDK's own error object");
}

async function testAbort(): Promise<void> {
  console.log("\n[5] abort: typed error naming where the boot was, both deletes");
  const row = fakeRow("sbx-abort", "building_snapshot");
  const fake = fakeClient(row);
  const controller = new AbortController();
  const run = createSandboxObserved(fake.client, { image: "img:1" } as never, {
    pollMs: 5,
    signal: controller.signal,
  });
  await tick(12);
  controller.abort();
  let caught: unknown;
  try {
    await run;
  } catch (e) {
    caught = e;
  }
  assert(caught instanceof DaytonaBootAbortedError, "rejects with DaytonaBootAbortedError");
  const err = caught as DaytonaBootAbortedError;
  assertEqual(err.phase, "image_pull", "names the phase from the last state read");
  assertEqual(err.state, "building_snapshot", "carries the provider state");
  assertEqual(err.sandboxId, "sbx-abort", "carries the sandbox id");
  assert(/image_pull/.test(err.message) && /building_snapshot/.test(err.message) && /sbx-abort/.test(err.message),
    "the message states phase, state and id");
  await tick(5);
  assertEqual(row.deletes, 1, "the row known at abort time is deleted best-effort");

  // The abandoned create resolves LATER with a box: that box is deleted too.
  const late = fakeRow("sbx-abort", "started");
  fake.resolveCreate(late);
  await tick(5);
  assertEqual(late.deletes, 1, "whatever the abandoned create yields later is deleted");

  console.log("\n[5b] abort before any row exists: phase boot, no ids, nothing to delete");
  const fake2 = fakeClient(null);
  const c2 = new AbortController();
  const run2 = createSandboxObserved(fake2.client, { image: "img:1" } as never, {
    pollMs: 5,
    signal: c2.signal,
  });
  await tick(8);
  c2.abort();
  let caught2: unknown;
  try {
    await run2;
  } catch (e) {
    caught2 = e;
  }
  const err2 = caught2 as DaytonaBootAbortedError;
  assert(caught2 instanceof DaytonaBootAbortedError, "typed even with no row");
  assertEqual([err2.phase, err2.state, err2.sandboxId], ["boot", null, null], "boot / no state / no id");
  assert(/not yet reported/.test(err2.message) && /not yet created/.test(err2.message), "the message says nothing was reported yet");
  fake2.rejectCreate(new Error("never mind"));
  await tick(5);
  assert(true, "a late rejection of the abandoned create is swallowed");
}

async function testLateAbortIsNoop(): Promise<void> {
  console.log("\n[6] an abort after the create settled is a no-op");
  const row = fakeRow("sbx-late", "started");
  const fake = fakeClient(row);
  const controller = new AbortController();
  let unhandled: unknown = null;
  const onUnhandled = (reason: unknown) => {
    unhandled = reason;
  };
  process.on("unhandledRejection", onUnhandled);
  const run = createSandboxObserved(fake.client, { image: "img:1" } as never, {
    pollMs: 5,
    signal: controller.signal,
  });
  fake.resolveCreate(row);
  const out = await run;
  controller.abort();
  await tick(10);
  process.off("unhandledRejection", onUnhandled);
  assert(out === (row as unknown), "the settled create's box is returned");
  assertEqual(row.deletes, 0, "a late abort deletes nothing");
  assert(unhandled === null, "no unhandled rejection from the late abort");
}

async function main(): Promise<void> {
  console.log("Daytona Provider — createSandboxObserved unit tests");
  await testPhaseMap();
  await testCreateShape();
  await testProgress();
  await testVerdictsPassThrough();
  await testAbort();
  await testLateAbortIsNoop();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
