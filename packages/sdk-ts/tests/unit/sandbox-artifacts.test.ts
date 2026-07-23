#!/usr/bin/env tsx
/**
 * Unit Test: Sandbox Artifact Listing — transport-resilient decode
 *
 * Covers the base64-wrapped, NUL-delimited `find` listing protocol:
 *   - decodeFindListing() round-trips filenames with spaces, newlines, UTF-8.
 *   - the listing survives a transport that STRIPS NUL bytes (Daytona's
 *     session-log transport), whereas the raw NUL-delimited bytes do not.
 *   - collectSandboxArtifacts() end-to-end against a mock sandbox whose
 *     transport strips NULs now decodes correctly and reads every file.
 *   - malformed metadata (odd field count) is still rejected.
 *
 * Usage:
 *   npm run test:unit:sandbox-artifacts
 *   npx tsx tests/unit/sandbox-artifacts.test.ts
 */

import {
  collectSandboxArtifacts,
  decodeFindListing,
} from "../../src/sandbox-artifacts.ts";
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

async function assertThrows(
  fn: () => unknown,
  substring: string,
  message: string,
): Promise<void> {
  try {
    await fn();
    failed++;
    console.log(`  ✗ ${message} (did not throw)`);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes(substring)) {
      passed++;
      console.log(`  ✓ ${message}`);
    } else {
      failed++;
      console.log(`  ✗ ${message} (threw "${msg}", expected to contain "${substring}")`);
    }
  }
}

/**
 * Model the in-box command exactly: `find ... -printf '%p\0%s\0' | base64 -w0`.
 * Builds the raw NUL-delimited record stream from (path,size) pairs, then
 * base64-encodes the bytes — the string a well-behaved transport delivers.
 */
function boxListing(entries: Array<[string, number]>): string {
  const parts: Buffer[] = [];
  for (const [path, size] of entries) {
    parts.push(Buffer.from(path, "utf8"), Buffer.from([0]));
    parts.push(Buffer.from(String(size), "utf8"), Buffer.from([0]));
  }
  return Buffer.concat(parts).toString("base64");
}

/** A transport that strips every NUL byte from stdout (Daytona's behavior). */
function stripNuls(stdout: string): string {
  return stdout.replace(/\0/g, "");
}

// =============================================================================
// TESTS: decodeFindListing
// =============================================================================

function testDecodeBasic(): void {
  console.log("\n[1] decodeFindListing() — round-trip");

  assertEqual(decodeFindListing(""), [], "empty listing -> []");
  assertEqual(decodeFindListing("   "), [], "whitespace-only listing -> []");

  assertEqual(
    decodeFindListing(boxListing([["/w/a.txt", 10]])),
    ["/w/a.txt", "10"],
    "single file",
  );

  assertEqual(
    decodeFindListing(boxListing([["/w/a.txt", 10], ["/w/b.log", 3]])),
    ["/w/a.txt", "10", "/w/b.log", "3"],
    "two files preserve order",
  );
}

function testDecodeAwkwardNames(): void {
  console.log("\n[2] decodeFindListing() — awkward filenames");

  // Spaces, newline, tab, and UTF-8 inside a single filename must survive,
  // because NUL (never legal in a path) is the only delimiter.
  const spacey = "/w/my report (final).txt";
  const newliney = "/w/weird\nname.txt";
  const tabby = "/w/col\tumn.csv";
  const utf8y = "/w/données_café_日本語.md";

  assertEqual(
    decodeFindListing(boxListing([[spacey, 1]])),
    [spacey, "1"],
    "filename with spaces + parens",
  );
  assertEqual(
    decodeFindListing(boxListing([[newliney, 2]])),
    [newliney, "2"],
    "filename with an embedded newline",
  );
  assertEqual(
    decodeFindListing(boxListing([[tabby, 3]])),
    [tabby, "3"],
    "filename with an embedded tab",
  );
  assertEqual(
    decodeFindListing(boxListing([[utf8y, 4]])),
    [utf8y, "4"],
    "filename with multi-byte UTF-8",
  );

  // All together, multiple records.
  assertEqual(
    decodeFindListing(boxListing([[spacey, 1], [newliney, 2], [utf8y, 4]])),
    [spacey, "1", newliney, "2", utf8y, "4"],
    "mixed awkward filenames in one listing",
  );
}

function testDecodeSurvivesNulStrip(): void {
  console.log("\n[3] decodeFindListing() — survives NUL-stripping transport");

  const entries: Array<[string, number]> = [
    ["/w/weird\nname.txt", 2],
    ["/w/my report.txt", 100],
    ["/w/café.md", 7],
  ];
  const wire = boxListing(entries);

  // The base64 payload contains no NUL bytes, so a NUL-stripping transport is a
  // no-op on it and the decode is identical to the untouched path.
  assertEqual(
    stripNuls(wire),
    wire,
    "base64 payload contains no NUL bytes (transport is a no-op)",
  );
  assertEqual(
    decodeFindListing(stripNuls(wire)),
    ["/w/weird\nname.txt", "2", "/w/my report.txt", "100", "/w/café.md", "7"],
    "decode after NUL-stripping transport is correct",
  );

  // Contrast: the OLD raw-NUL protocol is destroyed by the same transport —
  // proves the base64 wrapper is what fixes the Daytona failure.
  const rawNul = "/w/a.txt\x0010\x00/w/b.txt\x003\x00";
  const oldAfterStrip = stripNuls(rawNul).split("\0");
  assert(
    oldAfterStrip.length === 1 && oldAfterStrip[0] === "/w/a.txt10/w/b.txt3",
    "raw-NUL protocol collapses to one unusable field after stripping",
  );
}

// =============================================================================
// TESTS: collectSandboxArtifacts() end-to-end (mock sandbox)
// =============================================================================

interface MockOptions {
  /** Transport applied to every command's stdout before the SDK sees it. */
  transport?: (stdout: string) => string;
  /** Raw stdout to return for the find|base64 listing command (pre-transport). */
  listingStdout: string;
  /** Contents keyed by absolute path, returned by files.read. */
  contents: Record<string, string>;
}

function makeSandbox(opts: MockOptions): { sandbox: SandboxInstance; reads: string[] } {
  const transport = opts.transport ?? ((s: string) => s);
  const reads: string[] = [];
  const sandbox = {
    sandboxId: "mock",
    commands: {
      async run(command: string) {
        // Root existence/readability probe emits MISSING/UNREADABLE lines; a
        // healthy tree emits nothing.
        if (command.includes("MISSING")) {
          return { exitCode: 0, stdout: transport(""), stderr: "" };
        }
        // The artifact listing command.
        if (command.includes("base64 -w0") && command.includes("find")) {
          return { exitCode: 0, stdout: transport(opts.listingStdout), stderr: "" };
        }
        throw new Error(`unexpected command: ${command}`);
      },
    },
    files: {
      async read(path: string) {
        reads.push(path);
        if (!(path in opts.contents)) {
          throw new Error(`unexpected read: ${path}`);
        }
        return opts.contents[path];
      },
    },
  } as unknown as SandboxInstance;
  return { sandbox, reads };
}

async function testCollectUnderNulStrip(): Promise<void> {
  console.log("\n[4] collectSandboxArtifacts() — Daytona NUL-strip transport");

  const workdir = "/workspace";
  const entries: Array<[string, number]> = [
    ["/workspace/out/result.json", 12],
    ["/workspace/out/weird\nname.txt", 5],
    ["/workspace/out/café.md", 7],
  ];
  const { sandbox, reads } = makeSandbox({
    transport: stripNuls, // simulate Daytona stripping NUL bytes
    listingStdout: boxListing(entries),
    contents: {
      "/workspace/out/result.json": "{}",
      "/workspace/out/weird\nname.txt": "hi",
      "/workspace/out/café.md": "md",
    },
  });

  const files = await collectSandboxArtifacts(sandbox, workdir, ["out"]);

  assertEqual(
    Object.keys(files).sort(),
    ["out/café.md", "out/result.json", "out/weird\nname.txt"],
    "collected relative keys for all three files under NUL-strip transport",
  );
  assertEqual(files["out/result.json"], "{}", "content read for result.json");
  assertEqual(files["out/weird\nname.txt"], "hi", "content read for newline-name file");
  assertEqual(files["out/café.md"], "md", "content read for UTF-8 file");
  assert(reads.length === 3, "read() called exactly once per file");
}

async function testCollectEmpty(): Promise<void> {
  console.log("\n[5] collectSandboxArtifacts() — empty (readable) root");

  const { sandbox } = makeSandbox({
    transport: stripNuls,
    listingStdout: boxListing([]), // find matched nothing -> empty base64
    contents: {},
  });
  const files = await collectSandboxArtifacts(sandbox, "/workspace", ["out"]);
  assertEqual(Object.keys(files), [], "empty listing yields no files (not an error)");
}

async function testCollectMalformed(): Promise<void> {
  console.log("\n[6] collectSandboxArtifacts() — malformed metadata rejected");

  // Odd number of fields (a path with no size) must trip the guard.
  const rawOdd = Buffer.concat([
    Buffer.from("/workspace/out/a.txt", "utf8"),
    Buffer.from([0]),
  ]).toString("base64");
  const { sandbox } = makeSandbox({
    transport: stripNuls,
    listingStdout: rawOdd,
    contents: {},
  });
  await assertThrows(
    () => collectSandboxArtifacts(sandbox, "/workspace", ["out"]),
    "malformed artifact metadata",
    "odd field count throws malformed-metadata",
  );
}

// =============================================================================
// RUNNER
// =============================================================================

async function main(): Promise<void> {
  console.log("Sandbox Artifact Listing — transport-resilient decode\n" + "=".repeat(60));

  testDecodeBasic();
  testDecodeAwkwardNames();
  testDecodeSurvivesNulStrip();
  await testCollectUnderNulStrip();
  await testCollectEmpty();
  await testCollectMalformed();

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
