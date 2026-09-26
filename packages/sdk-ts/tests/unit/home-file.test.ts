#!/usr/bin/env tsx
/**
 * Unit Test: files the SDK writes into the config home belong to the home's owner
 *
 * The one seam every per-run config write goes through (mcp/home-file.ts): the
 * hand-over command it appends, its chain of entries, and — under a real /bin/sh
 * with a fake `stat`/`chown` on PATH — that the owner is read off the home, the
 * hand-over is skipped when the owner is the writer, and a refused chown fails
 * the write instead of leaving an unreadable file behind.
 */

import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

import { homeFileChain, homeFileOwnershipCommand, writeHomeFile } from "../../src/mcp/home-file.ts";
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
    assert(pattern.test((error as Error).message), message);
  }
}

function createNoopHandle(): SandboxCommandHandle {
  return {
    processId: "p1",
    wait: async (): Promise<SandboxCommandResult> => ({ exitCode: 0, stdout: "", stderr: "" }),
    kill: async (): Promise<boolean> => true,
  };
}

/** Records every call in order, so the write's sequence is checkable. */
function createRecordingSandbox() {
  const calls: string[] = [];
  const sandbox: SandboxInstance = {
    sandboxId: "sbx-1",
    commands: {
      run: async (command: string): Promise<SandboxCommandResult> => {
        calls.push(`run ${command}`);
        return { exitCode: 0, stdout: "", stderr: "" };
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

function testChain(): void {
  console.log("\n[1] the chain is every directory below the home on the way to the file, then the file");
  assert(
    JSON.stringify(homeFileChain("/home/agent", "/home/agent/.zcode/v2/provider_config.json")) ===
      JSON.stringify(["/home/agent/.zcode", "/home/agent/.zcode/v2", "/home/agent/.zcode/v2/provider_config.json"]),
    "two directories and the file, in creation order",
  );
  assert(
    JSON.stringify(homeFileChain("/root", "/root/.dsh/evolve-route.patch.yml")) ===
      JSON.stringify(["/root/.dsh", "/root/.dsh/evolve-route.patch.yml"]),
    "one directory and the file",
  );
  assert(
    JSON.stringify(homeFileChain("/", "/.factory/evolve-settings.json")) === JSON.stringify(["/.factory", "/.factory/evolve-settings.json"]),
    "a home of / works",
  );
  expectThrows(
    () => homeFileChain("/home/agent", "/app/.factory/mcp.json"),
    /not inside the config home/,
    "a path outside the home is a programming error, refused before anything is written",
  );
  expectThrows(
    () => homeFileChain("/home/agent", "/home/agentx/.zcode/x"),
    /not inside the config home/,
    "a sibling path that merely shares the home's prefix is outside too",
  );
}

function testCommandText(): void {
  console.log("\n[2] the hand-over command reads the owner off the home, skips itself, chowns the chain, then sets the mode");
  const cmd = homeFileOwnershipCommand("/home/agent", "/home/agent/.zcode/v2/provider_config.json", "600");
  assert(cmd.startsWith(`o="$(stat -c %u:%g '/home/agent')"`), "the owner is stat'ed off the home directory itself");
  assert(cmd.includes(`[ "\${o%%:*}" = "$(id -u)" ] ||`), "the chown is skipped when the home's owner is the account running the SDK");
  assert(
    cmd.includes(`chown -h "$o" '/home/agent/.zcode' '/home/agent/.zcode/v2' '/home/agent/.zcode/v2/provider_config.json'`),
    "chown -h over exactly the chain — non-recursive, symlinks never followed",
  );
  assert(cmd.endsWith(`&& chmod 600 '/home/agent/.zcode/v2/provider_config.json'`), "the mode is set on the file in the same command");
  const plain = homeFileOwnershipCommand("/home/user", "/home/user/.pi/agent/models.json");
  assert(!plain.includes("chmod"), "no mode, no chmod");
  assert(plain.includes(`'/home/user/.pi' '/home/user/.pi/agent' '/home/user/.pi/agent/models.json'`), "the pi chain");
}

async function testWriteSequence(): Promise<void> {
  console.log("\n[3] writeHomeFile: makeDir, write, then the hand-over — one exec, after the bytes are down");
  const { sandbox, calls } = createRecordingSandbox();
  await writeHomeFile(sandbox, "/root/.factory/evolve-settings.json", "{}", { homeDir: "/root" });
  assert(calls.length === 3, "exactly three calls");
  assert(calls[0] === "makeDir /root/.factory", "the file's directory is made first");
  assert(calls[1] === "write /root/.factory/evolve-settings.json {}", "then the bytes");
  assert(calls[2] === `run ${homeFileOwnershipCommand("/root", "/root/.factory/evolve-settings.json")}`, "then the hand-over command");

  const defaulted = createRecordingSandbox();
  await writeHomeFile(defaulted.sandbox, "/home/user/.qwen/settings.json", "{}");
  assert(defaulted.calls[2].includes(`stat -c %u:%g '/home/user'`), "no homeDir given: the SDK's default home is the home");

  let refused = false;
  try {
    await writeHomeFile(createRecordingSandbox().sandbox, "/etc/evolve.json", "{}", { homeDir: "/home/user" });
  } catch (error) {
    refused = /not inside the config home/.test((error as Error).message);
  }
  assert(refused, "a path outside the home is refused before makeDir or write run");
}

/** A fake bin dir on PATH: `chown` records its argv (and can be told to fail); `stat` can lie about the owner. */
function fakeBin(root: string, opts: { statOwner?: string; chownExit?: number }): string {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  const log = join(root, "chown.log");
  writeFileSync(join(bin, "chown"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit ${opts.chownExit ?? 0}\n`, { mode: 0o755 });
  if (opts.statOwner) {
    // Answers like GNU stat: the owner for a path that exists, exit 1 for one that does not.
    writeFileSync(
      join(bin, "stat"),
      `#!/bin/sh\neval "last=\\\${$#}"\n[ -e "$last" ] || { echo "stat: cannot stat '$last'" >&2; exit 1; }\nprintf '%s\\n' ${JSON.stringify(opts.statOwner)}\n`,
      { mode: 0o755 },
    );
  }
  return bin;
}

function runSh(command: string, bin: string): { status: number | null; stderr: string } {
  const result = spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}` },
  });
  return { status: result.status, stderr: result.stderr };
}

function testUnderRealShell(): void {
  console.log("\n[4] under a real /bin/sh");
  const root = mkdtempSync(join(tmpdir(), "evolve-home-file-"));
  try {
    const home = join(root, "home");
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    const file = join(home, ".zcode", "v2", "provider_config.json");
    writeFileSync(file, "{}");
    chmodSync(file, 0o644);

    // (a) the home is ours: the owner equals the writer, so chown never runs; the mode still lands.
    // `stat -c` is GNU/busybox syntax (the boxes'); the host's stat may be BSD, so the owner is faked as ourselves.
    const ours = fakeBin(join(root, "a"), { statOwner: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}` });
    const a = runSh(homeFileOwnershipCommand(home, file, "600"), ours);
    assert(a.status === 0, `owner == writer: exit 0 (${a.stderr.trim()})`);
    assert(!statSync(join(root, "a", "chown.log"), { throwIfNoEntry: false }), "owner == writer: chown was not invoked");
    assert((statSync(file).mode & 0o777) === 0o600, "owner == writer: the file is still chmod 600");

    // (b) the home belongs to someone else: chown -h runs over the chain with the home's uid:gid.
    const theirs = fakeBin(join(root, "b"), { statOwner: "4242:4242" });
    const b = runSh(homeFileOwnershipCommand(home, file), theirs);
    assert(b.status === 0, `owner != writer: exit 0 (${b.stderr.trim()})`);
    const chownArgs = readFileSync(join(root, "b", "chown.log"), "utf8").trim();
    assert(
      chownArgs === `-h 4242:4242 ${join(home, ".zcode")} ${join(home, ".zcode", "v2")} ${file}`,
      `owner != writer: chown -h <home owner> over the chain (got: ${chownArgs})`,
    );

    // (c) a chown the box refuses fails the command — never a silent unreadable file.
    const refusing = fakeBin(join(root, "c"), { statOwner: "4242:4242", chownExit: 1 });
    const c = runSh(homeFileOwnershipCommand(home, file), refusing);
    assert(c.status !== 0, "a refused chown exits non-zero");

    // (d) a home that does not exist fails loudly too.
    const d = runSh(homeFileOwnershipCommand(join(root, "nope"), join(root, "nope", ".x", "f")), ours);
    assert(d.status !== 0, "a missing home fails the stat, and the command");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(60));
  console.log("Home File Ownership Unit Tests");
  console.log("=".repeat(60));

  testChain();
  testCommandText();
  await testWriteSequence();
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
