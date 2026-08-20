#!/usr/bin/env tsx
/**
 * LIVE E2E: the end-of-output sentinel survives the hosted verifier's shape,
 * against the REAL Daytona daemon session shell.
 *
 * THE BUG THIS EXISTS TO KEEP DEAD. The platform runs a task's verifier as
 * `exec > /verifier.log 2>&1` followed by the command, so the run explains
 * itself even when the box dies mid-command, and it reads that FILE back as
 * the user-facing artifact verifier/test-stdout.txt. `exec >` repoints the
 * SHELL's own fd 1, so a sentinel printed to fd 1 after the command landed
 * INSIDE that file — and no filter on our side can reach a file read.
 *
 * Measured in production 2026-08-20, trial 4f103397 (daytona), where
 * verifier/test-stdout.txt was served to the user ending:
 *
 *     reward=1
 *     EVOLVE-EOS-mt18atit-gdzwvn
 *
 * The unit suite proves the shell semantics in /bin/bash, /bin/sh and
 * /bin/dash ([4o], [4q], [4r]). What it CANNOT reach is the thing that made
 * this a production bug rather than a shell puzzle: Daytona's own session
 * shell, its line-oriented log, and its completion recording. That is what
 * this run covers.
 *
 * LIVE, and it costs a real Daytona sandbox — run it deliberately, not in CI:
 *   DAYTONA_API_KEY=... npx tsx tests/integration/e2e-verifier-sentinel.ts
 *
 * Last run 2026-08-20: all nine checks passed against a real box
 * (68719ce3-88c7-43e4-a587-17b127d8a45f, torn down and verified gone). The
 * verifier log came back as exactly `PASS: checks\nreward=1\n` with no
 * sentinel in it, the caller's own streams carried none either, a later
 * command still reached both stdout and stderr, and the sentinel's original
 * job still held on the real line-oriented log: printf's unterminated line
 * stayed unterminated, echo's newline survived.
 */
import { createDaytonaProvider } from "../../src/index.ts";

/** Public image with bash — no dependency on our own image pipeline. */
const PROBE_IMAGE = "python:3.11-slim";
const LOG_PATH = "/verifier.log";
const RUN_ID = `sentinel-${Date.now().toString(36)}`;

let failures = 0;
function expect(condition: boolean, message: string): void {
  if (condition) {
    console.log(`   PASS  ${message}`);
  } else {
    failures += 1;
    console.log(`   FAIL  ${message}`);
  }
}

async function main(): Promise<void> {
  if (!process.env.DAYTONA_API_KEY) {
    console.error("DAYTONA_API_KEY is required for this live run");
    process.exit(2);
  }
  const provider = createDaytonaProvider({ apiKey: process.env.DAYTONA_API_KEY });

  console.log("[1] create a box");
  const sandbox = await provider.create({
    image: PROBE_IMAGE,
    timeoutMs: 10 * 60 * 1000,
    metadata: { e2e: "daytona-verifier-sentinel", run: RUN_ID },
  });
  console.log(`    sandbox ${sandbox.sandboxId}`);

  try {
    // The platform's own wrapper, verbatim in structure (the worker's
    // redirectedVerifierCommand + a verifier that prints a reward line).
    console.log("\n[2] run the verifier shape: `exec > /verifier.log 2>&1` + the command");
    const verifier = `exec > ${LOG_PATH} 2>&1\nprintf 'PASS: checks\\nreward=1\\n'`;
    const run = await sandbox.commands.run(verifier, { timeoutMs: 120_000 });
    console.log(`    exit=${run.exitCode} stdout=${JSON.stringify(run.stdout)} stderr=${JSON.stringify(run.stderr)}`);

    expect(run.exitCode === 0, "the redirected verifier reports its own status");
    expect(
      !/EVOLVE-EOS-/.test(run.stdout) && !/EVOLVE-EOS-/.test(run.stderr),
      "no sentinel reaches the caller's streams",
    );

    console.log("\n[3] read back the file the platform serves as verifier/test-stdout.txt");
    const read = await sandbox.commands.run(`cat ${LOG_PATH}`, { timeoutMs: 60_000 });
    const logged = read.stdout;
    console.log(`    ${LOG_PATH} = ${JSON.stringify(logged)}`);

    expect(!/EVOLVE-EOS-/.test(logged), "THE FIX: the user's verifier log carries no sentinel");
    expect(logged === "PASS: checks\nreward=1\n", "and holds exactly the verifier's own bytes");

    // The session shell has to be usable afterwards — the property the
    // close-not-restore design exists for, here against the real daemon.
    console.log("\n[4] the box still runs commands, on both streams");
    const after = await sandbox.commands.run(`printf 'AFTER-OUT\\n'; printf 'AFTER-ERR\\n' >&2`, {
      timeoutMs: 60_000,
    });
    console.log(`    exit=${after.exitCode} stdout=${JSON.stringify(after.stdout)} stderr=${JSON.stringify(after.stderr)}`);
    expect(after.exitCode === 0, "a later command still runs");
    expect(after.stdout.includes("AFTER-OUT"), "a later command still reaches stdout");
    expect(after.stderr.includes("AFTER-ERR"), "a later command still reaches STDERR");

    // The sentinel's original job, unchanged: an unterminated last line comes
    // back unterminated, a real newline survives as one.
    console.log("\n[5] the sentinel still does what it was built for");
    const noNewline = await sandbox.commands.run(`printf 'NO-NEWLINE'`, { timeoutMs: 60_000 });
    const withNewline = await sandbox.commands.run(`echo WITH-NEWLINE`, { timeoutMs: 60_000 });
    console.log(`    printf -> ${JSON.stringify(noNewline.stdout)}   echo -> ${JSON.stringify(withNewline.stdout)}`);
    expect(noNewline.stdout === "NO-NEWLINE", "printf's unterminated line stays unterminated");
    expect(withNewline.stdout === "WITH-NEWLINE\n", "echo's real newline survives");
  } finally {
    console.log("\n[6] tear down");
    await sandbox.kill().catch((e: unknown) => {
      console.log(`    kill failed (leaked box ${sandbox.sandboxId}): ${String(e)}`);
    });
  }

  console.log(`\n=== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} FAILED`} ===`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("unexpected:", e);
  process.exit(1);
});
