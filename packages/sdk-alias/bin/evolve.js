#!/usr/bin/env node
// The alias package's `evolve` command is the real package's CLI. The real
// package exports no CLI subpath, so the CLI file is found beside the real
// package's resolved entry: dist/index.cjs and dist/cli/index.js share dist/.
// The CLI runs in a child process because its own bin gate runs it only when
// it is the process entry; the child inherits stdio, so streams and exit codes
// pass through unchanged, and a signal to this process reaches the child.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join } from "node:path";

const entry = createRequire(import.meta.url).resolve("@evolvingmachines/evolve");
const cli = join(dirname(entry), "cli", "index.js");
const forwarded = ["SIGINT", "SIGTERM", "SIGHUP"];

const child = spawn(process.execPath, [...process.execArgv, cli, ...process.argv.slice(2)], {
  stdio: "inherit",
});
for (const signal of forwarded) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) {
    // Die by the same signal: drop the forwarders first, or the re-raised
    // signal lands in them and this process ends with code 1 instead.
    for (const s of forwarded) process.removeAllListeners(s);
    process.kill(process.pid, signal);
    process.exit(128 + constants.signals[signal]);
  }
  process.exit(code ?? 1);
});
