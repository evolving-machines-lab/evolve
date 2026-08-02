#!/usr/bin/env tsx
/**
 * Unit Test: E2BFiles.read() — text-vs-binary decided by content, byte-exact
 *
 * read() used to steer on an extension table: listed extensions rode
 * format:"bytes", everything else rode format:"text" — a LOSSY UTF-8 decode.
 * Binary bytes under an unlisted extension (.bin) came back as U+FFFD soup
 * (campaign J4: ~1.82x U+FFFD inflation on a 4096-byte payload). The fix
 * reads bytes always and decides from CONTENT: NUL sniff marks binary, then
 * a STRICT BOM-preserving UTF-8 decode decides string vs Uint8Array — both
 * branches rebuild the exact bytes.
 *
 * Usage:
 *   npx tsx tests/unit/e2b-files-read.test.ts
 */

import { E2BFiles } from "../../src/index.ts";

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
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

/**
 * A files double that behaves like the real E2B SDK: format "bytes" returns
 * the stored bytes, format "text" is a LOSSY UTF-8 decode of them (invalid
 * sequences become U+FFFD, never an error) — so an extension-steered read
 * would mangle exactly the way the old code did.
 */
function sandboxOf(bytes: Uint8Array) {
  const reads: Array<Record<string, unknown> | undefined> = [];
  const sandbox = {
    files: {
      read: async (_path: string, opts?: Record<string, unknown>) => {
        reads.push(opts);
        if (opts?.format === "bytes") return bytes;
        return new TextDecoder().decode(bytes);
      },
    },
  };
  return { sandbox, reads };
}

// =============================================================================
// TESTS
// =============================================================================

async function testBinaryByContentNotExtension(): Promise<void> {
  console.log("\n[1] binary is decided by CONTENT; a .bin payload survives byte-exact");

  // The E2E-proven mangle: these bytes are not valid UTF-8 (0xff/0xfe leads,
  // a NUL) and .bin sat in no extension table, so the old extension-steered
  // read sent them through the lossy text format and returned U+FFFD soup.
  const bytes = Uint8Array.from([0x00, 0xff, 0xfe, 0x80, 0x9c, 0xc3, 0x28, 0x01]);
  const { sandbox, reads } = sandboxOf(bytes);
  const files = new E2BFiles(sandbox as any);

  const result = await files.read("/workspace/blob.bin");
  assert(result instanceof Uint8Array, "non-UTF8 content reads back as bytes, whatever the name");
  assertEqual(Array.from(result as Uint8Array), Array.from(bytes), "every byte survives exactly");
  assert(reads.every((r) => r?.format === "bytes"), "the wire read is always format:'bytes' — no lossy text path exists");

  // NUL is the binary tell even when the bytes happen to decode as UTF-8
  // (the platform's agent-home sniff, git's own heuristic).
  const nulled = Uint8Array.from([0x68, 0x00, 0x69]);
  const { sandbox: nulBox } = sandboxOf(nulled);
  const nulRead = await new E2BFiles(nulBox as any).read("/workspace/data.txt");
  assert(nulRead instanceof Uint8Array, "a NUL byte marks binary even inside valid UTF-8");
}

async function testTextByContentNotExtension(): Promise<void> {
  console.log("\n[2] valid UTF-8 is a string, even under a binary-looking name");

  const text = "héllo → wörld\n";
  const { sandbox } = sandboxOf(new TextEncoder().encode(text));
  const files = new E2BFiles(sandbox as any);

  const result = await files.read("/workspace/report.png");
  assertEqual(result, text, "the extension plays no part — valid UTF-8 reads back as a string");

  // ignoreBOM: a BOM is content, not framing. The default decoder would eat
  // it and the string would no longer re-encode to the file's exact bytes.
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]);
  const { sandbox: bomBox } = sandboxOf(bom);
  const bomRead = await new E2BFiles(bomBox as any).read("/workspace/bom.txt");
  assertEqual(
    Array.from(new TextEncoder().encode(bomRead as string)),
    Array.from(bom),
    "a leading BOM survives the decode, so the string rebuilds the identical bytes"
  );
}

// =============================================================================
// RUNNER
// =============================================================================

const tests = [testBinaryByContentNotExtension, testTextByContentNotExtension];

(async () => {
  console.log("=== E2BFiles.read(): content-sniffed, byte-exact Tests ===");
  try {
    for (const test of tests) {
      await test();
    }
    console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
    if (failed > 0) process.exit(1);
  } catch (err) {
    console.error("Unexpected error:", err);
    process.exit(1);
  }
})();
