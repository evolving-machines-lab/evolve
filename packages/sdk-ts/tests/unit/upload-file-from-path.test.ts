#!/usr/bin/env tsx
/**
 * Unit Test: uploadFileFromPath() — the memory-bounded upload
 *
 * uploadFiles() takes a FileMap, i.e. the bytes as a VALUE, so uploading a
 * large artifact costs one full-size Buffer per concurrent upload. Callers that
 * move big files under concurrency need the path instead, so the provider can
 * stream it off disk.
 *
 * What this pins down:
 *   - a provider offering writeFromPath() gets the PATH, and the file is never
 *     read into this process;
 *   - a provider without it still works, via the read-and-write fallback;
 *   - relative paths resolve under the working directory and absolute paths are
 *     used as-is (the uploadFiles() convention);
 *   - the parent directory is created before the write.
 *
 * Usage:
 *   npm run test:unit:upload-from-path
 *   npx tsx tests/unit/upload-file-from-path.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Agent comes from the BUILT bundle (the cost-api.test.ts convention):
// importing src/agent.ts directly pulls in raw .md prompt assets that tsx
// cannot load. `pretest:unit` builds, so dist is always current.
import { Agent } from "../../dist/index.js";
import type { SandboxInstance } from "../../src/types.ts";

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

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message} (expected ${b}, got ${a})`);
  }
}

type Recorder = {
  commands: string[];
  writes: Array<{ path: string; bytes: number }>;
  fromPath: Array<{ sandboxPath: string; localPath: string }>;
};

/** A sandbox whose files seam optionally offers writeFromPath(). */
function mockSandbox(opts: { supportsFromPath: boolean }): {
  sandbox: SandboxInstance;
  rec: Recorder;
} {
  const rec: Recorder = { commands: [], writes: [], fromPath: [] };
  const files: Record<string, unknown> = {
    read: async () => "",
    write: async (path: string, content: string | Buffer | ArrayBuffer | Uint8Array) => {
      const bytes =
        typeof content === "string"
          ? Buffer.byteLength(content)
          : (content as ArrayBuffer | Uint8Array | Buffer).byteLength;
      rec.writes.push({ path, bytes });
    },
    writeBatch: async () => {},
    makeDir: async () => {},
  };
  if (opts.supportsFromPath) {
    files.writeFromPath = async (sandboxPath: string, localPath: string) => {
      rec.fromPath.push({ sandboxPath, localPath });
    };
  }
  const sandbox = {
    sandboxId: "sbx-test",
    commands: {
      run: async (command: string) => {
        rec.commands.push(command);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      spawn: async () => {
        throw new Error("not used");
      },
      list: async () => [],
      kill: async () => true,
    },
    files,
    getHost: async () => "host",
    kill: async () => {},
    pause: async () => {},
  } as unknown as SandboxInstance;
  return { sandbox, rec };
}

/** An Agent with its sandbox pre-attached, so no provider is ever booted. */
function agentWith(sandbox: SandboxInstance, workingDir = "/workspace"): Agent {
  const agent = new Agent({ type: "claude" } as any, {});
  const internals = agent as unknown as {
    sandbox: SandboxInstance;
    workingDir: string;
  };
  internals.sandbox = sandbox;
  internals.workingDir = workingDir;
  return agent;
}

// =============================================================================
// TESTS
// =============================================================================

async function testStreamsWhenProviderCan(fixture: string): Promise<void> {
  console.log("\nProvider offering writeFromPath()");
  const local = join(fixture, "bundle.tgz");
  writeFileSync(local, Buffer.alloc(1024, 7));

  const { sandbox, rec } = mockSandbox({ supportsFromPath: true });
  await agentWith(sandbox).uploadFileFromPath("/tmp/harness.tgz", local);

  assertEqual(
    rec.fromPath,
    [{ sandboxPath: "/tmp/harness.tgz", localPath: local }],
    "hands the provider the PATH, not the bytes",
  );
  // THE property: nothing read the file into this process. That is what makes
  // N concurrent uploads of a large artifact safe.
  assertEqual(rec.writes, [], "never falls back to a value write");
}

async function testFallbackWhenProviderCannot(fixture: string): Promise<void> {
  console.log("\nProvider without writeFromPath()");
  const local = join(fixture, "small.txt");
  writeFileSync(local, "hello");

  const { sandbox, rec } = mockSandbox({ supportsFromPath: false });
  await agentWith(sandbox).uploadFileFromPath("/tmp/small.txt", local);

  assertEqual(rec.writes.length, 1, "falls back to a single write");
  assertEqual(rec.writes[0]?.path, "/tmp/small.txt", "writes to the requested path");
  assertEqual(rec.writes[0]?.bytes, 5, "writes the file's actual contents");
}

async function testPathResolution(fixture: string): Promise<void> {
  console.log("\nPath resolution (the uploadFiles() convention)");
  const local = join(fixture, "f.bin");
  writeFileSync(local, "x");

  const absolute = mockSandbox({ supportsFromPath: true });
  await agentWith(absolute.sandbox, "/workspace").uploadFileFromPath("/etc/thing", local);
  assertEqual(
    absolute.rec.fromPath[0]?.sandboxPath,
    "/etc/thing",
    "an absolute sandbox path is used as-is",
  );

  const relative = mockSandbox({ supportsFromPath: true });
  await agentWith(relative.sandbox, "/workspace").uploadFileFromPath("sub/thing", local);
  assertEqual(
    relative.rec.fromPath[0]?.sandboxPath,
    "/workspace/sub/thing",
    "a relative sandbox path resolves under the working directory",
  );
}

async function testMakesParentDirectory(fixture: string): Promise<void> {
  console.log("\nParent directory");
  const local = join(fixture, "g.bin");
  writeFileSync(local, "x");

  const { sandbox, rec } = mockSandbox({ supportsFromPath: true });
  await agentWith(sandbox).uploadFileFromPath("/deep/nested/thing.tgz", local);

  assert(
    rec.commands.some((c) => c.includes("mkdir -p /deep/nested")),
    "creates the destination's parent before writing",
  );
}

async function testMissingLocalFileThrows(fixture: string): Promise<void> {
  console.log("\nMissing local file");
  const { sandbox } = mockSandbox({ supportsFromPath: false });
  let threw = false;
  try {
    await agentWith(sandbox).uploadFileFromPath("/tmp/x", join(fixture, "does-not-exist"));
  } catch {
    threw = true;
  }
  // The fallback path reads the file, so a missing source must surface rather
  // than upload nothing silently.
  assert(threw, "a nonexistent local file is an error, not a silent no-op");
}

// =============================================================================
// RUNNER
// =============================================================================

async function main(): Promise<void> {
  console.log("uploadFileFromPath() — the memory-bounded upload\n" + "=".repeat(60));

  const fixture = mkdtempSync(join(tmpdir(), "upload-from-path-"));
  try {
    await testStreamsWhenProviderCan(fixture);
    await testFallbackWhenProviderCannot(fixture);
    await testPathResolution(fixture);
    await testMakesParentDirectory(fixture);
    await testMissingLocalFileThrows(fixture);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }

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
