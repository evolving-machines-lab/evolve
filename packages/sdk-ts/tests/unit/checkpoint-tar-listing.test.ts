#!/usr/bin/env tsx
/**
 * Unit Test: Verbose tar listing parse (parseTarListing + the locale pin)
 *
 * This is the one place in the SDK where another program's TEXT decides which
 * files a caller gets back. It runs `tar` on the USER'S machine, so neither
 * the tar variant nor the locale is ours to choose — and the old parse
 * answered an unrecognised line with `continue`, i.e. the entry silently
 * disappeared from downloadFiles() and the call still reported success.
 *
 * What is pinned here:
 *   - real BSD tar output (captured verbatim from bsdtar 3.5.3) parses, with
 *     files, directories and symlinks each landing in the right bucket;
 *   - GNU tar's documented layout parses the same way;
 *   - a line the parse does not recognise now THROWS TarListingParseError
 *     naming the line, instead of dropping the file;
 *   - the locale pin is proven against a REAL archive listed by the real tar
 *     on this machine: the same file that survives under LC_ALL=C is the one
 *     a localized listing loses.
 *
 * Usage:
 *   npm run test:unit:checkpoint-tar-listing
 *   npx tsx tests/unit/checkpoint-tar-listing.test.ts
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  parseTarListing,
  TarListingParseError,
  TAR_LISTING_ENV,
} from "../../src/storage/index.ts";

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

function assertDeepEqual(actual: unknown, expected: unknown, message: string): void {
  const match = JSON.stringify(actual) === JSON.stringify(expected);
  if (match) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(
      `  ✗ ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`
    );
  }
}

function assertThrows(fn: () => unknown, substring: string, message: string): void {
  try {
    fn();
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

// =============================================================================
// FIXTURES — real listings, not invented ones
// =============================================================================

/**
 * bsdtar 3.5.3 (the tar macOS ships), LC_ALL=C, captured verbatim. Note the
 * two date shapes in one listing: recent entries carry HH:MM and no year,
 * entries older than six months carry a year and no time.
 */
const BSD_LISTING = [
  "drwxr-xr-x  0 someone wheel       0 Aug 16 09:29 src/",
  "lrwxr-xr-x  0 someone wheel       0 Aug 16 09:29 src/link.txt -> a.txt",
  "-rw-r--r--  0 someone wheel       5 Aug 16 09:29 src/a.txt",
  "drwxr-xr-x  0 someone wheel       0 Aug 16 09:29 src/nested/",
  "-rw-r--r--  0 someone wheel       1 Jan  1  2020 src/nested/old.bin",
].join("\n");

/** GNU tar's documented `-tvzf` layout: owner/group joined, ISO date. */
const GNU_LISTING = [
  "drwxr-xr-x someone/someone   0 2025-01-01 14:23 src/",
  "lrwxrwxrwx someone/someone   0 2025-01-01 14:23 src/link.txt -> a.txt",
  "-rw-r--r-- someone/someone   5 2025-01-01 14:23 src/a.txt",
  "drwxr-xr-x someone/someone   0 2025-01-01 14:23 src/nested/",
  "-rw-r--r-- someone/someone   1 2020-01-01 01:01 src/nested/old.bin",
].join("\n");

/**
 * The SAME bsdtar, same archive, under fr_FR.UTF-8 — the line that used to be
 * dropped in silence. It carries no HH:MM (the file is over six months old)
 * and "janv." is not an English three-letter month, so neither pattern
 * matches.
 */
const LOCALIZED_UNPARSEABLE_LINE =
  "-rw-r--r--  0 someone wheel       1  1 janv.  2020 src/nested/old.bin";

// =============================================================================
// TESTS
// =============================================================================

function testBsdListing(): void {
  console.log("\n[1] parseTarListing() - real BSD tar output");

  const entries = parseTarListing(BSD_LISTING);
  assertDeepEqual(entries.filePaths, ["src/a.txt", "src/nested/old.bin"], "Regular files listed");
  assertDeepEqual(entries.dirPaths, ["src", "src/nested"], "Directories listed, trailing slash dropped");
  assertDeepEqual(entries.symlinkPaths, ["src/link.txt"], "Symlink recorded WITHOUT its target");
  assert(
    !entries.filePaths.includes("src/link.txt"),
    "Symlink stays out of the file list (downloadFiles must not follow it)"
  );
  assert(
    entries.filePaths.includes("src/nested/old.bin"),
    "The >6-months-old entry (year, no HH:MM) survives the parse"
  );
}

function testGnuListing(): void {
  console.log("\n[2] parseTarListing() - GNU tar output");

  const entries = parseTarListing(GNU_LISTING);
  assertDeepEqual(entries.filePaths, ["src/a.txt", "src/nested/old.bin"], "Regular files listed");
  assertDeepEqual(entries.dirPaths, ["src", "src/nested"], "Directories listed");
  assertDeepEqual(entries.symlinkPaths, ["src/link.txt"], "Symlink target stripped");
}

function testUnparseableLineIsLoud(): void {
  console.log("\n[3] parseTarListing() - an unreadable line FAILS, it does not vanish");

  // The whole point of the fix: this used to return a SHORTER list and no error.
  assertThrows(
    () => parseTarListing(LOCALIZED_UNPARSEABLE_LINE),
    "Could not read a file path",
    "A localized date line throws instead of being skipped"
  );

  let named = false;
  try {
    parseTarListing(LOCALIZED_UNPARSEABLE_LINE);
  } catch (e) {
    named =
      e instanceof TarListingParseError &&
      e.line === LOCALIZED_UNPARSEABLE_LINE &&
      e.message.includes("janv.");
  }
  assert(named, "The error is typed (TarListingParseError) and names the offending line");

  // A good listing with ONE bad line in it fails as a whole — a partial answer
  // is exactly what this fix removes.
  assertThrows(
    () => parseTarListing(`${BSD_LISTING}\n${LOCALIZED_UNPARSEABLE_LINE}`),
    "Refusing to return a partial file list",
    "One bad line fails the whole listing, no partial result"
  );

  // Entry-type validation is unchanged and still comes first.
  assertThrows(
    () => parseTarListing("brw-r--r--  0 someone wheel  0 Aug 16 09:29 src/dev"),
    "unsupported entry type",
    "An unsupported entry type still throws its own error"
  );
}

/**
 * The locale pin, proven against the real tar on this machine rather than
 * against a fixture: build an archive holding a file older than six months,
 * list it the way listTarFiles does, and list it again under a localized
 * locale.
 */
function testLocalePinAgainstRealTar(): void {
  console.log("\n[4] TAR_LISTING_ENV - proven against this machine's real tar");

  const dir = mkdtempSync(join(tmpdir(), "evolve-tar-listing-"));
  try {
    mkdirSync(join(dir, "src", "nested"), { recursive: true });
    writeFileSync(join(dir, "src", "a.txt"), "hello");
    writeFileSync(join(dir, "src", "nested", "old.bin"), "x");
    symlinkSync("a.txt", join(dir, "src", "link.txt"));
    // Older than six months, which is what makes tar print a year instead of
    // a time — and, in a localized run, a localized month name.
    const longAgo = new Date("2020-01-01T01:01:00Z");
    utimesSync(join(dir, "src", "nested", "old.bin"), longAgo, longAgo);

    const archive = join(dir, "arch.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", dir, "src"]);

    const listUnder = (env: Record<string, string>): string =>
      execFileSync("tar", ["-tvzf", archive], {
        env: { ...process.env, ...env },
        encoding: "utf8",
      });

    const pinned = parseTarListing(listUnder({ ...TAR_LISTING_ENV }));
    assert(
      pinned.filePaths.includes("src/nested/old.bin"),
      "Under the pinned C locale the old file is listed"
    );
    assert(pinned.symlinkPaths.includes("src/link.txt"), "Under the pin the symlink is recognised");

    // Not every tar localizes (GNU tar prints ISO dates whatever the locale),
    // and not every machine has fr_FR installed. Only assert the difference
    // where it actually exists — the claim is about THIS tar, not all tars.
    let localized: string | null = null;
    try {
      localized = listUnder({ LC_ALL: "fr_FR.UTF-8", LANG: "fr_FR.UTF-8" });
    } catch {
      localized = null;
    }
    if (localized === null || localized === listUnder({ ...TAR_LISTING_ENV })) {
      console.log(
        "  – this tar/locale combination does not localize the listing; nothing to prove here"
      );
    } else {
      assertThrows(
        () => parseTarListing(localized as string),
        "Could not read a file path",
        "The SAME archive listed under fr_FR.UTF-8 fails loudly instead of losing the file"
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// =============================================================================
// MAIN
// =============================================================================

function main(): void {
  console.log("=".repeat(60));
  console.log("Checkpoint Tar Listing Parse Unit Tests");
  console.log("=".repeat(60));

  testBsdListing();
  testGnuListing();
  testUnparseableLineIsLoud();
  testLocalePinAgainstRealTar();

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main();
