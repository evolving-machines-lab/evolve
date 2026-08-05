#!/usr/bin/env tsx
/**
 * Unit Test: the built `evolve` bin runs when it is reached THROUGH A
 * SYMLINK, which is the only way an installed user ever reaches it.
 *
 * The failure this exists to kill shipped silently. npm writes
 * node_modules/.bin/evolve as a symlink to dist/cli/index.js, so argv[1]
 * is the LINK while Node builds import.meta.url from the dereferenced target.
 * The bin's "am I the entry point" gate compared the two raw, never matched,
 * and main() never ran: the installed bin printed nothing and exited 0.
 * Every other CLI test imports runCli() from src, where the gate is supposed to
 * stay shut, so all of them passed against a bin that did nothing.
 *
 * Read from dist, not src: a symlink test that never executes the shipped file
 * would not have caught it either. `npm run test:unit` builds first
 * (pretest:unit); run standalone after `npm run build`.
 *
 * Usage:
 *   npm run test:unit:cli-bin
 *   npx tsx tests/unit/cli-bin.test.ts
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

console.log("\n=== evolve bin: reached through a symlink ===\n");

// The bin path is package.json's "bin" target. If the build moved it, every
// assertion below would be testing a file no installer ever writes. So the
// path is not hardcoded on faith: package.json is read and its ONE bin entry
// must be named `evolve` and point exactly here. A half-applied rename — the
// manifest still saying evolve-evals, or still aiming at dist/hosted/cli.js —
// fails here instead of shipping a binary nobody can invoke.
const manifest = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
  bin?: Record<string, string>;
};
const binEntries = Object.entries(manifest.bin ?? {});
assert(binEntries.length === 1, "package.json declares exactly one bin");
assert(binEntries[0]?.[0] === "evolve", `the bin is named "evolve" (got "${binEntries[0]?.[0]}")`);
assert(
  binEntries[0]?.[1] === "dist/cli/index.js",
  `the bin points at dist/cli/index.js (got "${binEntries[0]?.[1]}")`,
);
assert(
  join(PACKAGE_ROOT, ...(binEntries[0]?.[1] ?? "").split("/")) === BIN_PATH,
  "the manifest's bin target is the file these tests execute",
);

assert(existsSync(BIN_PATH), `dist/cli/index.js exists (run "npm run build" first)`);
if (!existsSync(BIN_PATH)) {
  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
  process.exit(1);
}

function runNode(entry: string, args: string[]): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [entry, ...args], {
    encoding: "utf8",
    // A CLI that waits on stdin would hang the suite instead of failing it.
    stdio: ["ignore", "pipe", "pipe"],
  });
  return { code: result.status ?? -1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

const workDir = mkdtempSync(join(tmpdir(), "evolve-bin-"));
try {
  // ---- CONTROL: the real path, which is how every earlier test ran it ----
  const direct = runNode(BIN_PATH, ["--help"]);
  assert(direct.code === 0, "real path: exits 0");
  assert(direct.stdout.includes("Usage: evolve"), "real path: prints usage");

  // ---- THE REGRESSION: a bare symlink to the bin ----
  const bareLink = join(workDir, "evolve");
  symlinkSync(BIN_PATH, bareLink);

  const viaLink = runNode(bareLink, ["--help"]);
  assert(viaLink.code === 0, "symlink: exits 0");
  assert(
    viaLink.stdout.includes("Usage: evolve"),
    "symlink: prints usage — NOT the silent no-op that shipped",
  );
  assert(
    viaLink.stdout.trim().length > 0,
    "symlink: produces output at all (empty stdout WAS the bug)",
  );

  // `help` as a positional takes a different parse path than the --help flag.
  const helpCommand = runNode(bareLink, ["help"]);
  assert(helpCommand.code === 0, "symlink: `help` command exits 0");
  assert(helpCommand.stdout.includes("Usage: evolve"), "symlink: `help` command prints usage");

  // A no-op exits 0 for every argv, so proving it RAN needs a non-zero code
  // that only the real parser produces.
  const usageError = runNode(bareLink, ["not-a-command"]);
  assert(usageError.code === 2, "symlink: an unknown command exits 2, so the parser really ran");
  assert(usageError.stderr.length > 0, "symlink: the usage error reaches stderr");

  // ---- THE INSTALLED SHAPE: symlinked package dir + symlinked .bin entry ----
  // What `npm install` (and a workspace link) actually leaves on disk: the .bin
  // entry points into a package directory that is itself a symlink, so argv[1]
  // needs both links resolved before it can equal import.meta.url.
  const nodeModules = join(workDir, "node_modules");
  mkdirSync(join(nodeModules, "@evolvingmachines"), { recursive: true });
  mkdirSync(join(nodeModules, ".bin"), { recursive: true });
  symlinkSync(PACKAGE_ROOT, join(nodeModules, "@evolvingmachines", "sdk"));
  const binLink = join(nodeModules, ".bin", "evolve");
  symlinkSync(
    join("..", "@evolvingmachines", "sdk", "dist", "cli", "index.js"),
    binLink,
  );

  const viaBin = runNode(binLink, ["--help"]);
  assert(viaBin.code === 0, "node_modules/.bin entry: exits 0");
  assert(
    viaBin.stdout.includes("Usage: evolve"),
    "node_modules/.bin entry: prints usage through both links",
  );

  // ---- THE MOVE DID NOT BREAK THE SPEC LOOKUP ----
  // The -c vocabulary is read from spec/openapi.yaml at a path relative to the
  // running file ("../../spec/openapi.yaml"). Moving the CLI from dist/hosted/
  // to dist/cli/ kept that depth on purpose; a flat dist/cli.js would have
  // resolved one directory too high and turned every -c config into "the spec
  // could not be found". Only the built bin can prove it.
  const configPath = join(workDir, "job.yaml");
  writeFileSync(
    configPath,
    ["datasets:", "  - name: deep-swe", "agents:", "  - name: codex", "    model_name: gpt-5.5", ""].join("\n"),
  );
  const printConfig = runNode(BIN_PATH, ["run", "-c", configPath, "--print-config"]);
  assert(printConfig.code === 0, `--print-config through the built bin exits 0 (stderr: ${printConfig.stderr.trim()})`);
  assert(
    printConfig.stdout.includes('"deep-swe"'),
    "--print-config validated the config against the spec it still finds from dist/cli/",
  );

  // ---- THE GATE STILL SHUTS: importing the module must not run main() ----
  // This is what the gate is for. A fix that simply always ran main() would
  // pass every assertion above and turn every library import into a CLI run.
  const consumer = join(workDir, "consumer.mjs");
  writeFileSync(
    consumer,
    `import ${JSON.stringify(pathToFileURL(BIN_PATH).href)};\nconsole.log("IMPORTED_OK");\n`,
  );
  const imported = runNode(consumer, ["--help"]);
  assert(imported.code === 0, "import: the consumer exits 0");
  assert(imported.stdout.includes("IMPORTED_OK"), "import: the consumer ran");
  assert(
    !imported.stdout.includes("Usage: evolve"),
    "import: main() stayed shut — importing the module is not a CLI run",
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
if (failed > 0) process.exit(1);
