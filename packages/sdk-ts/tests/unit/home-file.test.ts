#!/usr/bin/env tsx
/**
 * Unit Test: files the SDK writes into the config home are handed to their owner
 *
 * The one seam every per-run config write goes through (mcp/home-file.ts): the
 * prepare command (missing directories made one level at a time and printed),
 * the hand-over command (the directories that write made plus the file, to the
 * named owner or else the home's owner), the write sequence, fail-loud on a
 * refused step, and the commands under a real /bin/sh with a fake stat/chown.
 */

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import {
  HomeFileError,
  homeFileChain,
  homeFileOwnershipCommand,
  homeFilePrepareCommand,
  validateHomeOwner,
  writeHomeFile,
} from "../../src/mcp/home-file.ts";
import type { SandboxInstance, SandboxCommandHandle, SandboxCommandResult, ProcessInfo } from "../../src/types.ts";

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

function expectThrows(fn: () => unknown, pattern: RegExp, message: string): void {
  try {
    fn();
    assert(false, `${message} (did not throw)`);
  } catch (error) {
    assert(pattern.test((error as Error).message), `${message} (${(error as Error).message})`);
  }
}

function createNoopHandle(): SandboxCommandHandle {
  return {
    processId: "p1",
    wait: async (): Promise<SandboxCommandResult> => ({ exitCode: 0, stdout: "", stderr: "" }),
    kill: async (): Promise<boolean> => true,
  };
}

/** Records every call in order; `answers` scripts what each `run` returns. */
function createRecordingSandbox(answers: SandboxCommandResult[] = []) {
  const calls: string[] = [];
  const sandbox: SandboxInstance = {
    sandboxId: "sbx-1",
    commands: {
      run: async (command: string): Promise<SandboxCommandResult> => {
        calls.push(`run ${command}`);
        return answers.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn: async (): Promise<SandboxCommandHandle> => createNoopHandle(),
      list: async (): Promise<ProcessInfo[]> => [],
      kill: async (): Promise<boolean> => true,
    },
    files: {
      read: async (): Promise<string> => {
        throw new Error("ENOENT");
      },
      write: async (path: string, content: string | Buffer | ArrayBuffer | Uint8Array): Promise<void> => {
        calls.push(`write ${path} ${typeof content === "string" ? content : "<bytes>"}`);
      },
      writeBatch: async (): Promise<void> => {},
      makeDir: async (path: string): Promise<void> => {
        calls.push(`makeDir ${path}`);
      },
    },
    getHost: async (): Promise<string> => "http://localhost:3000",
    kill: async (): Promise<void> => {},
    pause: async (): Promise<void> => {},
  };
  return { sandbox, calls };
}

const FILE = "/home/agent/.zcode/v2/provider_config.json";
const DIRS = ["/home/agent/.zcode", "/home/agent/.zcode/v2"];

function testChainAndOwner(): void {
  console.log("\n[1] the chain, and what an owner may look like");
  assert(JSON.stringify(homeFileChain("/home/agent", FILE)) === JSON.stringify([...DIRS, FILE]), "two directories and the file, in creation order");
  assert(JSON.stringify(homeFileChain("/", "/.factory/x.json")) === JSON.stringify(["/.factory", "/.factory/x.json"]), "a home of / works");
  expectThrows(() => homeFileChain("/home/agent", "/app/.factory/mcp.json"), /not inside the config home/, "a path outside the home is refused");
  expectThrows(() => homeFileChain("/home/agent", "/home/agentx/.zcode/x"), /not inside the config home/, "a sibling sharing the prefix is outside too");
  assert(validateHomeOwner("agent") === "agent" && validateHomeOwner("1001") === "1001" && validateHomeOwner("1001:1001") === "1001:1001", "a name, a uid or uid:gid pass");
  expectThrows(() => validateHomeOwner("agent; rm -rf /"), /homeOwner must be/, "anything a shell could read is refused, typed on the field");
  expectThrows(() => validateHomeOwner("agent:staff"), /homeOwner must be/, "a group by name is refused (chown wants numbers there)");
}

function testPrepareCommand(): void {
  console.log("\n[2] the prepare command makes missing directories one level at a time and prints each one made");
  const cmd = homeFilePrepareCommand("/home/agent", FILE);
  assert(cmd === `for d in '/home/agent/.zcode' '/home/agent/.zcode/v2'; do [ -d "$d" ] || { mkdir "$d" && printf '%s\\n' "$d" || exit 1; }; done`, "the chain's directories, in order, existing ones skipped");
  assert(homeFilePrepareCommand("/root", "/root/.claude.json") === "true", "a file directly in the home needs no directory");
}

function testOwnershipCommand(): void {
  console.log("\n[3] the hand-over command");
  const named = homeFileOwnershipCommand("/home/agent", FILE, ["/home/agent/.zcode/v2"], { owner: "agent", mode: "600" });
  assert(named === `o='agent' && chown -h "$o" '/home/agent/.zcode/v2' '${FILE}' && chmod 600 '${FILE}'`, "a named owner: chown -h over the directories this write made and the file, then the mode");
  const fallback = homeFileOwnershipCommand("/home/agent", FILE, []);
  assert(fallback === `o="$(stat -c %u:%g '/home/agent')" && { [ "\${o%%:*}" = "$(id -u)" ] || chown -h "$o" '${FILE}'; }`, "no owner: the home's owner, skipped when it is the writer; nothing pre-existing is re-owned");
  expectThrows(() => homeFileOwnershipCommand("/home/agent", FILE, [], { owner: "a b" }), /homeOwner must be/, "an owner the shell could read never reaches the command");
}

async function testWriteSequence(): Promise<void> {
  console.log("\n[4] writeHomeFile: prepare, write, hand over — the hand-over names only what the prepare made");
  const made = createRecordingSandbox([{ exitCode: 0, stdout: "/home/agent/.zcode/v2\n/etc/passwd\n", stderr: "" }]);
  await writeHomeFile(made.sandbox, FILE, "{}", { homeDir: "/home/agent", owner: "agent", mode: "600" });
  assert(made.calls.length === 3 && made.calls[0] === `run ${homeFilePrepareCommand("/home/agent", FILE)}`, "first the prepare command");
  assert(made.calls[1] === `write ${FILE} {}`, "then the bytes");
  assert(
    made.calls[2] === `run ${homeFileOwnershipCommand("/home/agent", FILE, ["/home/agent/.zcode/v2"], { owner: "agent", mode: "600" })}`,
    "then the hand-over over the one directory the prepare reported — a printed name outside the chain is ignored",
  );

  const none = createRecordingSandbox();
  await writeHomeFile(none.sandbox, "/home/user/.qwen/settings.json", "{}");
  assert(none.calls[2] === `run ${homeFileOwnershipCommand("/home/user", "/home/user/.qwen/settings.json", [])}`, "nothing made, no owner given: only the file, to the default home's owner");

  let refused = false;
  const outside = createRecordingSandbox();
  try {
    await writeHomeFile(outside.sandbox, "/etc/evolve.json", "{}", { homeDir: "/home/user" });
  } catch (error) {
    refused = /not inside the config home/.test((error as Error).message);
  }
  assert(refused && outside.calls.length === 0, "a path outside the home is refused before any command or write");
}

async function testFailLoud(): Promise<void> {
  console.log("\n[5] a refused step fails the write, typed, naming the path and the stderr");
  const prep = createRecordingSandbox([{ exitCode: 1, stdout: "", stderr: "mkdir: cannot create directory '/home/agent/.zcode': Permission denied" }]);
  let error: unknown;
  try {
    await writeHomeFile(prep.sandbox, FILE, "{}", { homeDir: "/home/agent", owner: "agent" });
  } catch (e) {
    error = e;
  }
  assert(error instanceof HomeFileError && error.step === "prepare" && error.exitCode === 1, "prepare exit 1 → HomeFileError(prepare, 1)");
  assert(error instanceof HomeFileError && error.path === FILE && error.message.includes(FILE) && error.message.includes("Permission denied"), "…naming the path and carrying the stderr");
  assert(prep.calls.length === 1, "nothing is written after a failed prepare");

  const hand = createRecordingSandbox([{ exitCode: 0, stdout: "", stderr: "" }, { exitCode: 1, stdout: "", stderr: "chown: invalid user: 'agent'" }]);
  error = undefined;
  try {
    await writeHomeFile(hand.sandbox, FILE, "{}", { homeDir: "/home/agent", owner: "agent", mode: "600" });
  } catch (e) {
    error = e;
  }
  assert(error instanceof HomeFileError && error.step === "hand-over" && error.message.includes("invalid user"), "hand-over exit 1 → HomeFileError(hand-over) with the stderr");
  assert(error instanceof Error && error.name === "HomeFileError", "the error is named");
}

/** A fake bin dir on PATH: `chown` records its argv (and can be told to fail); `stat` answers like GNU stat for a path that exists. */
function fakeBin(root: string, opts: { statOwner?: string; chownExit?: number }): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(root, "chown.log");
  writeFileSync(join(bin, "chown"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit ${opts.chownExit ?? 0}\n`, { mode: 0o755 });
  if (opts.statOwner) {
    writeFileSync(
      join(bin, "stat"),
      `#!/bin/sh\neval "last=\\\${$#}"\n[ -e "$last" ] || { echo "stat: cannot stat '$last'" >&2; exit 1; }\nprintf '%s\\n' ${JSON.stringify(opts.statOwner)}\n`,
      { mode: 0o755 },
    );
  }
  return bin;
}

function runSh(command: string, bin: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function testUnderRealShell(): void {
  console.log("\n[6] under a real /bin/sh");
  const root = mkdtempSync(join(tmpdir(), "evolve-home-file-"));
  try {
    const home = join(root, "home");
    mkdirSync(join(home, ".zcode"), { recursive: true });
    const file = join(home, ".zcode", "v2", "provider_config.json");
    const plain = fakeBin(join(root, "plain"), {});

    // prepare: .zcode exists and is left alone; v2 is made and reported.
    const prep = runSh(homeFilePrepareCommand(home, file), plain);
    assert(prep.status === 0 && prep.stdout.trim() === join(home, ".zcode", "v2"), `prepare made and printed only the missing level (got ${JSON.stringify(prep.stdout)})`);
    const again = runSh(homeFilePrepareCommand(home, file), plain);
    assert(again.status === 0 && again.stdout === "", "a second prepare makes and prints nothing");
    writeFileSync(join(home, ".zcode", "v2", "blocker"), "");
    const blocked = runSh(homeFilePrepareCommand(home, join(home, ".zcode", "v2", "blocker", "x")), plain);
    assert(blocked.status !== 0, "a chain entry that exists as a FILE fails the prepare loudly");

    writeFileSync(file, "{}");
    chmodSync(file, 0o644);

    // (a) named owner on a home that is ours (the shared-home shape): chown -h still runs, over exactly
    // the given directories and the file, then the mode.
    const named = fakeBin(join(root, "a"), {});
    const a = runSh(homeFileOwnershipCommand(home, file, [join(home, ".zcode", "v2")], { owner: "4242:4242", mode: "600" }), named);
    assert(a.status === 0, `named owner: exit 0 (${a.stderr.trim()})`);
    assert(readFileSync(join(root, "a", "chown.log"), "utf8").trim() === `-h 4242:4242 ${join(home, ".zcode", "v2")} ${file}`, "named owner: chown -h <owner> <made dir> <file>");
    assert((statSync(file).mode & 0o777) === 0o600, "named owner: the mode landed");

    // (b) no owner, the home is ours: nothing changes hands.
    const ours = fakeBin(join(root, "b"), { statOwner: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}` });
    const b = runSh(homeFileOwnershipCommand(home, file, []), ours);
    assert(b.status === 0 && !existsSync(join(root, "b", "chown.log")), "owner == writer: exit 0 and chown never invoked");

    // (c) no owner, the home is someone else's: the file goes to them.
    const theirs = fakeBin(join(root, "c"), { statOwner: "4242:4242" });
    const c = runSh(homeFileOwnershipCommand(home, file, []), theirs);
    assert(c.status === 0 && readFileSync(join(root, "c", "chown.log"), "utf8").trim() === `-h 4242:4242 ${file}`, "owner != writer: chown -h <home owner> <file>");

    // (d) a refused chown, and a missing home, both exit non-zero.
    const refusing = fakeBin(join(root, "d"), { statOwner: "4242:4242", chownExit: 1 });
    assert(runSh(homeFileOwnershipCommand(home, file, []), refusing).status !== 0, "a refused chown exits non-zero");
    assert(runSh(homeFileOwnershipCommand(join(root, "nope"), join(root, "nope", ".x", "f"), []), ours).status !== 0, "a missing home fails the stat, and the command");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Home File Ownership Unit Tests");
  console.log("=".repeat(60));

  testChainAndOwner();
  testPrepareCommand();
  testOwnershipCommand();
  await testWriteSequence();
  await testFailLoud();
  testUnderRealShell();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
