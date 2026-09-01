#!/usr/bin/env tsx
/**
 * Unit Test: `evolve dataset publish --json --watch` over a PIPED stdout —
 * every NDJSON event reaches the consumer the moment it is emitted, never
 * held until exit.
 *
 * The other CLI suites capture io.out in-process, which can never see a
 * process-level buffer: the built bin is spawned here with stdout as a real
 * pipe (`stdio: pipe`, the shape of `evolve ... | consumer`), exactly as the
 * 2026-09-01 publish that showed a consumer nothing between preflight.ok
 * and the terminal line for 40 minutes was run. The proof is CAUSAL, not a
 * stopwatch: the fixture server holds its answer to each watch poll until
 * the consumer has RECEIVED the line the previous poll caused (import.created
 * before poll 1, import.progress step k-1 before poll k). A CLI that
 * buffered its stdout until exit could never satisfy a gate — the server
 * would wait, the CLI would wait on the server, and the bounded gate would
 * trip and fail the test loudly instead of hanging it.
 *
 * Every event rides the same io.out (cli/index.ts defaultIO — one
 * process.stdout.write per line), so what is pinned here for the classic
 * door's stream holds for the resumable door's `import.registered` line
 * too; the 256 MiB door itself is not crossed from a child process — a
 * corpus that size has no place in a unit run.
 *
 * Reads from dist like cli-bin.test.ts: `npm run test:unit` builds first
 * (pretest:unit); run standalone after `npm run build`.
 *
 * Usage:
 *   npm run test:unit:cli-ndjson-pipe
 *   npx tsx tests/unit/cli-ndjson-pipe.test.ts
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { listen, sessionServer } from "./hosted-session-server.ts";

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

async function main(): Promise<void> {
  console.log("\n=== evolve dataset publish --json --watch: NDJSON flushes through a pipe as emitted ===\n");

  assert(existsSync(BIN_PATH), 'dist/cli/index.js exists (run "npm run build" first)');
  if (!existsSync(BIN_PATH)) {
    console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
    process.exit(1);
  }

  // What the consumer has received, in arrival order, and a way for a
  // gate to wait for the next arrival.
  const arrived: Array<{ kind: string; step?: number }> = [];
  let wake: (() => void) | null = null;
  const seen = (want: (event: { kind: string; step?: number }) => boolean): boolean =>
    arrived.some(want);
  const waitFor = async (
    want: (event: { kind: string; step?: number }) => boolean,
  ): Promise<number> => {
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
            ? waitFor((e) => e.kind === "import.created")
            : waitFor((e) => e.kind === "import.progress" && e.step === poll - 1);
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

  const stderr: string[] = [];
  let leftover = "";
  const child = spawn(
    process.execPath,
    [
      BIN_PATH, "dataset", "publish", "--dir", dir, "--name", "my-bench", "--version", "1.0",
      "--skip-preflight", "--json", "--watch", "--api-key", "test-key", "--base-url", url(),
    ],
    // A real pipe on stdout — the consumer shape under test. stdin ignored:
    // a CLI that waited on it would hang the suite instead of failing it.
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  child.stdout.on("data", (data: Buffer) => {
    leftover += data.toString("utf8");
    let newline: number;
    while ((newline = leftover.indexOf("\n")) !== -1) {
      const line = leftover.slice(0, newline);
      leftover = leftover.slice(newline + 1);
      let parsed: { kind?: unknown; progress?: { step?: unknown } } = {};
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        // A non-JSON line is itself a failure — recorded as such below.
      }
      const step = parsed.progress?.step;
      arrived.push({
        kind: typeof parsed.kind === "string" ? parsed.kind : `<not NDJSON: ${line.slice(0, 40)}>`,
        ...(typeof step === "number" ? { step } : {}),
      });
      wake?.();
    }
  });
  child.stderr.on("data", (data: Buffer) => stderr.push(data.toString("utf8")));
  const code = await new Promise<number>((resolve) => child.on("close", (c) => resolve(c ?? -1)));
  server.close();
  rmSync(dir, { recursive: true, force: true });

  assert(code === 0, `the watched publish settled READY and exited 0 (got ${code})`);
  assert(stderr.length === 0, `nothing on stderr${stderr.length ? `: ${stderr.join("").trim()}` : ""}`);
  assert(leftover === "", "stdout ended on a newline — no partial trailing line");
  assert(
    arrived.every((e) => !e.kind.startsWith("<not NDJSON")),
    "every stdout line is one NDJSON document",
  );
  assert(gateWaits.length === PROGRESS_POLLS, `the server answered ${PROGRESS_POLLS} watch polls (got ${gateWaits.length})`);
  assert(
    gateWaits.every((waited) => waited !== -1),
    `every poll's gate was satisfied — the consumer held the previous line BEFORE the next phase was served (waits ms: ${gateWaits.join(", ")})`,
  );
  assert(
    gateWaits.every((waited) => waited !== -1 && waited < 1_000),
    `each line reached the consumer within a second of its emission, not at exit (waits ms: ${gateWaits.join(", ")})`,
  );
  const kinds = arrived.map((e) => e.kind);
  assert(kinds[0] === "import.created", `the stream opens with import.created (got ${kinds[0]})`);
  assert(kinds[kinds.length - 1] === "import.final", `and settles to import.final (got ${kinds[kinds.length - 1]})`);
  const steps = arrived.filter((e) => e.kind === "import.progress").map((e) => e.step);
  assert(
    JSON.stringify(steps) === JSON.stringify([1, 2, 3]),
    `progress arrived in emission order, one line per server write (got ${JSON.stringify(steps)})`,
  );

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
