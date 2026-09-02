#!/usr/bin/env tsx
/**
 * Unit Test: `evolve dataset publish --json --watch` over a PIPED stdout —
 * every NDJSON event reaches the consumer the moment it is emitted, never
 * held until exit — and the transfer itself is part of that stream.
 *
 * The other CLI suites capture io.out in-process, which can never see a
 * process-level buffer: the built bin is spawned here with stdout as a real
 * pipe (`stdio: pipe`, the shape of `evolve ... | consumer`), exactly as the
 * 2026-09-01 publish that showed a consumer nothing between preflight.ok
 * and the terminal line for 40 minutes was run. The proof is CAUSAL, not a
 * stopwatch: the fixture server holds its answer to a request until the
 * consumer has RECEIVED the line an earlier answer caused. A CLI that
 * buffered its stdout until exit — or emitted nothing — could never satisfy
 * a gate: the server would wait, the CLI would wait on the server, and the
 * bounded gate would trip and fail the test loudly instead of hanging it.
 *
 * Two scenarios, one per door:
 *
 *  1. The single-request door, a kilobyte corpus: the watch polls are gated
 *     (import.created before poll 1, import.progress step k-1 before poll k).
 *  2. The resumable chunked door, crossed FOR REAL — a corpus whose archive
 *     is over the 256 MiB threshold (a child process cannot reach the
 *     in-process seam that lowers it, so the corpus is built to cross it:
 *     incompressible bytes, which the packer stores rather than deflates).
 *     This is the door of the 2026-09-01 silence — one line, then nothing
 *     for 20 minutes while the chunks streamed (backlog B28, owner ruling
 *     2026-09-02). The chunk PATCH that arrives past 90 % of the archive is
 *     held until the consumer holds the 90 % `upload.progress` line, and the
 *     finalize is held until the consumer holds the 100 % line: progress
 *     that only appears after the 202, or never, trips both gates.
 *
 * Reads from dist like cli-bin.test.ts: `npm run test:unit` builds first
 * (pretest:unit); run standalone after `npm run build`.
 *
 * Usage:
 *   npm run test:unit:cli-ndjson-pipe
 *   npx tsx tests/unit/cli-ndjson-pipe.test.ts
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { listen, sessionServer, type SessionState } from "./hosted-session-server.ts";

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
const BIN_PATH = join(PACKAGE_ROOT, "dist", "cli", "index.js");

/** How long a gate waits for the consumer before giving up — generous for a
 * pipe that flushes in milliseconds, far below the suite's patience. */
const GATE_TIMEOUT_MS = 5_000;
const PROGRESS_POLLS = 3;

/** The resumable door's switch, verbatim (src/hosted/resumable.ts) — an
 * archive OVER this many bytes rides the chunked door. */
const RESUMABLE_THRESHOLD_BYTES = 256 * 1024 * 1024;
/** The scenario-2 corpus: one incompressible blob this big, stored by the
 * packer as-is, so the archive crosses the threshold by ~16 MiB. */
const BLOB_BLOCK_BYTES = 16 * 1024 * 1024;
const BLOB_BLOCKS = 17;

/** One NDJSON line as the consumer read it. */
interface ArrivedEvent {
  kind: string;
  step?: number;
  sent_bytes?: number;
  total_bytes?: number;
  elapsed_sec?: number;
}

/**
 * The consumer: what it has received, in arrival order, and a way for a
 * server-side gate to wait for the next arrival.
 */
function consumer() {
  const arrived: ArrivedEvent[] = [];
  const stderr: string[] = [];
  let leftover = "";
  let wake: (() => void) | null = null;
  const seen = (want: (event: ArrivedEvent) => boolean): boolean => arrived.some(want);
  /** Milliseconds waited until the consumer held a matching line, or -1 on timeout. */
  const waitFor = async (want: (event: ArrivedEvent) => boolean): Promise<number> => {
    const started = Date.now();
    while (!seen(want)) {
      if (Date.now() - started > GATE_TIMEOUT_MS) return -1;
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 50);
      });
      wake = null;
    }
    return Date.now() - started;
  };
  const attach = (child: ChildProcess): void => {
    child.stdout?.on("data", (data: Buffer) => {
      leftover += data.toString("utf8");
      let newline: number;
      while ((newline = leftover.indexOf("\n")) !== -1) {
        const line = leftover.slice(0, newline);
        leftover = leftover.slice(newline + 1);
        let parsed: Partial<ArrivedEvent> & { progress?: { step?: unknown } } = {};
        try {
          parsed = JSON.parse(line) as typeof parsed;
        } catch {
          // A non-JSON line is itself a failure — recorded as such below.
        }
        const event: ArrivedEvent = {
          kind: typeof parsed.kind === "string" ? parsed.kind : `<not NDJSON: ${line.slice(0, 40)}>`,
        };
        const step = parsed.progress?.step;
        if (typeof step === "number") event.step = step;
        for (const key of ["sent_bytes", "total_bytes", "elapsed_sec"] as const) {
          const value = parsed[key];
          if (typeof value === "number") event[key] = value;
        }
        arrived.push(event);
        wake?.();
      }
    });
    child.stderr?.on("data", (data: Buffer) => stderr.push(data.toString("utf8")));
  };
  return { arrived, stderr, waitFor, attach, leftover: () => leftover };
}

function publishArgs(dir: string, baseUrl: string): string[] {
  return [
    BIN_PATH, "dataset", "publish", "--dir", dir, "--name", "my-bench", "--version", "1.0",
    "--skip-preflight", "--json", "--watch", "--api-key", "test-key", "--base-url", baseUrl,
  ];
}

/** Spawn the bin with a REAL pipe on stdout — the consumer shape under
 * test. stdin ignored: a CLI that waited on it would hang the suite instead
 * of failing it. Resolves with the exit code. */
function spawnPublish(args: string[], sink: ReturnType<typeof consumer>): Promise<number> {
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  sink.attach(child);
  return new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
}

function detailBody(state: string, active: boolean): Record<string, unknown> {
  const version = {
    version: "1.0",
    state,
    created_at: "2026-08-20T00:00:00Z",
    task_count: 1,
    manifest: null,
    source: null,
  };
  return {
    name: "my-bench",
    title: null,
    description: null,
    visibility: "private",
    active_version: active ? version : null,
    versions: [version],
    selected_version: version,
    tasks: { items: [], next_cursor: null, has_more: false },
    upstream: null,
    created_at: "2026-08-20T00:00:00Z",
    updated_at: "2026-08-20T00:00:00Z",
  };
}

/** The common shape of both scenarios' verdicts on the whole stream. */
function assertCleanStream(
  code: number,
  sink: ReturnType<typeof consumer>,
  closing: string,
): void {
  assert(code === 0, `the watched publish settled READY and exited 0 (got ${code})`);
  assert(
    sink.stderr.length === 0,
    `nothing on stderr${sink.stderr.length ? `: ${sink.stderr.join("").trim()}` : ""}`,
  );
  assert(sink.leftover() === "", "stdout ended on a newline — no partial trailing line");
  assert(
    sink.arrived.every((e) => !e.kind.startsWith("<not NDJSON")),
    "every stdout line is one NDJSON document",
  );
  const kinds = sink.arrived.map((e) => e.kind);
  assert(
    kinds[kinds.length - 1] === closing,
    `the stream settles to ${closing} (got ${kinds[kinds.length - 1]})`,
  );
}

async function scenarioSingleRequestDoor(): Promise<void> {
  console.log("\n--- single-request door: the watch stream flushes through the pipe as emitted ---\n");
  const sink = consumer();
  // The gate results, in poll order: milliseconds the server waited for the
  // consumer to hold the previous line, or -1 when the gate timed out.
  const gateWaits: number[] = [];
  let polls = 0;
  const { server, url } = sessionServer({
    onOther: (req, res, _body) => {
      const reqUrl = req.url ?? "";
      const json = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };
      if (req.method === "POST" && reqUrl === "/api/datasets/publish") {
        json(202, {
          id: "version-1", status: "QUEUED", name: "my-bench", version: "1.0", failure: null, warnings: [],
        });
        return true;
      }
      if (reqUrl.startsWith("/api/datasets/imports/version-1")) {
        polls += 1;
        const poll = polls;
        // Hold this answer until the consumer holds what the previous
        // answer caused — the causal proof.
        const gate =
          poll === 1
            ? sink.waitFor((e) => e.kind === "import.created")
            : sink.waitFor((e) => e.kind === "import.progress" && e.step === poll - 1);
        void gate.then((waited) => {
          gateWaits.push(waited);
          const status = poll < PROGRESS_POLLS ? "RUNNING" : "COMPLETED";
          json(200, {
            id: "version-1", status, name: "my-bench", version: "1.0", task_count: 1,
            failure: null, warnings: [], progress: { phase: "build", step: poll },
          });
        });
        return true;
      }
      if (reqUrl.startsWith("/api/datasets/my-bench")) {
        json(200, detailBody("READY", true));
        return true;
      }
      return false;
    },
  });
  await listen(server);

  const dir = mkdtempSync(join(tmpdir(), "evolve-cli-ndjson-pipe-"));
  mkdirSync(join(dir, "tasks", "abc"), { recursive: true });
  writeFileSync(join(dir, "tasks", "abc", "task.toml"), 'schema_version = "1.1"\n');

  const code = await spawnPublish(publishArgs(dir, url()), sink);
  server.close();
  rmSync(dir, { recursive: true, force: true });

  assertCleanStream(code, sink, "import.final");
  assert(gateWaits.length === PROGRESS_POLLS, `the server answered ${PROGRESS_POLLS} watch polls (got ${gateWaits.length})`);
  assert(
    gateWaits.every((waited) => waited !== -1),
    `every poll's gate was satisfied — the consumer held the previous line BEFORE the next phase was served (waits ms: ${gateWaits.join(", ")})`,
  );
  assert(
    gateWaits.every((waited) => waited !== -1 && waited < 1_000),
    `each line reached the consumer within a second of its emission, not at exit (waits ms: ${gateWaits.join(", ")})`,
  );
  const kinds = sink.arrived.map((e) => e.kind);
  // This door registers nothing, so the transfer's own lines open the
  // stream; the follow opens with import.created once the 202 lands.
  const transferLines = kinds.filter((k) => k === "upload.progress").length;
  assert(
    transferLines >= 1 && kinds.slice(0, transferLines).every((k) => k === "upload.progress"),
    `the transfer's upload.progress lines come first (${transferLines} of them, before anything else)`,
  );
  assert(
    kinds[transferLines] === "import.created",
    `then import.created opens the follow (got ${kinds[transferLines]})`,
  );
  const steps = sink.arrived.filter((e) => e.kind === "import.progress").map((e) => e.step);
  assert(
    JSON.stringify(steps) === JSON.stringify([1, 2, 3]),
    `progress arrived in emission order, one line per server write (got ${JSON.stringify(steps)})`,
  );
}

/** Write the scenario-2 corpus: one task.toml and one incompressible blob
 * of BLOB_BLOCKS × BLOB_BLOCK_BYTES (the same random block repeated —
 * deflate's 32 KiB window cannot fold a 16 MiB period, and the packer's
 * head sample sees random bytes and stores the entry). */
function writeOversizedCorpus(dir: string): number {
  mkdirSync(join(dir, "tasks", "abc"), { recursive: true });
  writeFileSync(join(dir, "tasks", "abc", "task.toml"), 'schema_version = "1.1"\n');
  const block = randomBytes(BLOB_BLOCK_BYTES);
  const fd = openSync(join(dir, "tasks", "abc", "corpus.bin"), "w");
  try {
    for (let i = 0; i < BLOB_BLOCKS; i++) writeSync(fd, block);
  } finally {
    closeSync(fd);
  }
  return BLOB_BLOCK_BYTES * BLOB_BLOCKS;
}

/** The 10 %-step a progress line sits on — the CLI's own cadence rule. */
const stepOf = (e: ArrivedEvent): number =>
  e.total_bytes !== undefined && e.total_bytes > 0 && e.sent_bytes !== undefined
    ? Math.floor((e.sent_bytes / e.total_bytes) * 10)
    : -1;

async function scenarioResumableDoor(): Promise<void> {
  console.log("\n--- resumable door (archive > 256 MiB): upload.progress reaches the pipe DURING the transfer ---\n");
  const sink = consumer();
  // [0] = the held chunk PATCH past 90 %, [1] = the held finalize.
  const gateWaits: number[] = [];
  let heldPatch = false;
  const { server, sessions, url } = sessionServer({
    importId: "imp-42",
    onPatch: async (state: SessionState) => {
      // The previous chunk's bytes are never read back here — drop them so
      // the fixture holds one chunk, not the whole archive, in memory.
      state.received.length = 0;
      if (!heldPatch && state.offset >= 0.9 * state.size) {
        heldPatch = true;
        // Hold the first chunk past 90 % until the consumer holds the 90 %
        // line — bytes are still moving, and the line must already be out.
        gateWaits.push(await sink.waitFor((e) => e.kind === "upload.progress" && stepOf(e) >= 9));
      }
      return false;
    },
    onComplete: async () => {
      // Hold the finalize (and so the 202, and so import.created) until the
      // consumer holds the 100 % line.
      gateWaits.push(
        await sink.waitFor(
          (e) => e.kind === "upload.progress" && e.sent_bytes !== undefined && e.sent_bytes === e.total_bytes,
        ),
      );
      return false;
    },
    onOther: (req, res) => {
      const reqUrl = req.url ?? "";
      const json = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(body));
      };
      if (reqUrl.startsWith("/api/datasets/imports/version-1")) {
        json(200, {
          id: "version-1", status: "COMPLETED", name: "my-bench", version: "1.0", task_count: 1,
          failure: null, warnings: [], progress: null,
        });
        return true;
      }
      if (reqUrl.startsWith("/api/datasets/my-bench")) {
        json(200, detailBody("READY", true));
        return true;
      }
      return false;
    },
  });
  await listen(server);

  const dir = mkdtempSync(join(tmpdir(), "evolve-cli-ndjson-pipe-big-"));
  const corpusBytes = writeOversizedCorpus(dir);

  const code = await spawnPublish(publishArgs(dir, url()), sink);
  server.close();
  rmSync(dir, { recursive: true, force: true });

  assertCleanStream(code, sink, "import.final");
  const session = [...sessions.values()][0];
  assert(
    session !== undefined && session.size > RESUMABLE_THRESHOLD_BYTES && session.completed === 1,
    `the corpus rode the resumable door — archive ${session?.size ?? "?"} bytes > ${RESUMABLE_THRESHOLD_BYTES}, finalized once (corpus ${corpusBytes} bytes)`,
  );
  const kinds = sink.arrived.map((e) => e.kind);
  assert(kinds[0] === "import.registered", `the stream opens with import.registered (got ${kinds[0]})`);
  const progress = sink.arrived.filter((e) => e.kind === "upload.progress");
  assert(
    progress.length >= 1 && progress.length <= 11,
    `upload.progress rides the stream at the 10 % cadence — at most 11 lines (got ${progress.length})`,
  );
  assert(
    gateWaits.length === 2 && gateWaits.every((waited) => waited !== -1),
    `both gates were satisfied — the 90 % line was out while the chunk past 90 % was held, and the 100 % line before the finalize (waits ms: ${gateWaits.join(", ")})`,
  );
  assert(
    gateWaits.every((waited) => waited !== -1 && waited < 1_000),
    `each progress line reached the consumer within a second of its emission (waits ms: ${gateWaits.join(", ")})`,
  );
  const createdAt = kinds.indexOf("import.created");
  const lastProgressAt = kinds.lastIndexOf("upload.progress");
  assert(
    createdAt !== -1 && lastProgressAt !== -1 && lastProgressAt < createdAt && kinds.indexOf("upload.progress") > 0,
    "every upload.progress line sits between import.registered and import.created — during the transfer, not after the 202",
  );
  assert(
    progress.every((e) => e.total_bytes === session?.size),
    `total_bytes is the archive's size on every line (${session?.size ?? "?"})`,
  );
  assert(
    progress.every((e, i) => i === 0 || (e.sent_bytes ?? -1) > (progress[i - 1].sent_bytes ?? -1)),
    "sent_bytes strictly increases line over line",
  );
  assert(
    progress.every((e, i) => i === 0 || stepOf(e) > stepOf(progress[i - 1])),
    "one line per 10 % step crossed — never two lines on the same step",
  );
  assert(
    progress[progress.length - 1]?.sent_bytes === session?.size,
    "the last line is the 100 % line — sent_bytes equals total_bytes",
  );
  assert(
    progress.every((e) => typeof e.elapsed_sec === "number" && Number.isFinite(e.elapsed_sec) && e.elapsed_sec >= 0),
    "elapsed_sec is a finite non-negative number on every line",
  );
  assert(
    progress.every((e, i) => i === 0 || (e.elapsed_sec ?? -1) >= (progress[i - 1].elapsed_sec ?? -1)),
    "elapsed_sec never runs backwards",
  );
}

async function main(): Promise<void> {
  console.log("\n=== evolve dataset publish --json --watch: NDJSON flushes through a pipe as emitted ===\n");

  assert(existsSync(BIN_PATH), 'dist/cli/index.js exists (run "npm run build" first)');
  if (!existsSync(BIN_PATH)) {
    console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
    process.exit(1);
  }

  await scenarioSingleRequestDoor();
  await scenarioResumableDoor();

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
