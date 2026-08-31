#!/usr/bin/env tsx
/**
 * Unit Test: publish memory guard — the F1 regression fence
 *
 * The defect this fences (proven live 2026-08-30): the directory publish
 * built its tar.gz IN MEMORY and wrapped it in a FormData Blob, costing ~10x
 * the corpus size in RSS — measured 7.8x (1559 MB peak for a 200 MB corpus)
 * through the real datasets().publish() path on this very harness before the
 * fix, and a 37 GB Node process (crashed machine) on a 7.7 GB corpus in the
 * wild. The fix streams tar+gzip to a temp FILE and streams that file onto
 * the wire over node:http (fetch is unusable here: undici retains the whole
 * request body in live ArrayBuffers while sending — measured, see
 * hosted/upload.ts).
 *
 * This test runs the REAL publish path — tarGzipDirectoryToFile +
 * postMultipartFile via datasets().publish() — on a 200 MB incompressible
 * corpus in a CHILD process against a local draining server, and asserts the
 * child's peak RSS stays under 3x the corpus (the old path sat at ~7.8x; the
 * new one measures ~1.1x, most of it toolchain baseline).
 *
 * Usage:
 *   npm run test:unit:upload-memory
 *   npx tsx tests/unit/hosted-upload-memory.test.ts
 */

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const MB = 1024 * 1024;
const CORPUS_MB = 200;
const RSS_CAP_MB = 3 * CORPUS_MB;

// =============================================================================
// CHILD: publish the corpus, report peak RSS
// =============================================================================

if (process.env.MEM_CHILD === "1") {
  let peakRss = 0;
  const sampler = setInterval(() => {
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
  }, 20);
  const { datasets } = await import("../../src/hosted/index.ts");
  const client = datasets({
    apiKey: "test-key",
    baseUrl: `http://127.0.0.1:${process.env.MEM_PORT}`,
  });
  await client.publish({
    name: "mem-fixture",
    version: "1.0.0",
    source: { directory: process.env.MEM_CORPUS as string },
  });
  clearInterval(sampler);
  console.log(JSON.stringify({ rssPeakMB: Math.round(peakRss / MB) }));
  process.exit(0);
}

// =============================================================================
// PARENT: fixture + server + assertion
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

async function main(): Promise<void> {
  console.log("publish memory guard — the F1 regression fence\n" + "=".repeat(60));

  const corpus = await mkdtemp(join(tmpdir(), "evolve-mem-corpus-"));
  try {
    // Incompressible content: the archive is ~the corpus size, so the upload
    // side is exercised at full weight, not on a gzip-flattered fixture.
    const fh = await open(join(corpus, "big.bin"), "w");
    try {
      for (let written = 0; written < CORPUS_MB; written += 4) {
        await fh.write(randomBytes(4 * MB));
      }
    } finally {
      await fh.close();
    }
    await writeFile(join(corpus, "task.toml"), "id = 'mem'\n");

    const server = createServer((req, res) => {
      let received = 0;
      req.on("data", (chunk: Buffer) => {
        received += chunk.length;
      });
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: "imp-mem",
            name: "mem-fixture",
            version: "1.0.0",
            status: "QUEUED",
            warnings: [],
            received_bytes: received,
          })
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as { port: number };

    try {
      // Re-enter this same file as the child, TypeScript and all: node with
      // the tsx loader (the suite itself runs under tsx).
      const { stdout } = await promisify(execFile)(
        process.execPath,
        ["--import", "tsx", process.argv[1] as string],
        {
          env: {
            ...process.env,
            MEM_CHILD: "1",
            MEM_PORT: String(port),
            MEM_CORPUS: corpus,
          },
          timeout: 300_000,
        }
      );
      const report = JSON.parse(stdout.trim()) as { rssPeakMB: number };
      console.log(`\n  corpus ${CORPUS_MB} MB → child peak RSS ${report.rssPeakMB} MB`);
      assert(
        report.rssPeakMB < RSS_CAP_MB,
        `peak RSS ${report.rssPeakMB} MB stays under ${RSS_CAP_MB} MB (3x corpus; the old in-memory path measured ~7.8x)`
      );
    } finally {
      server.close();
    }
  } finally {
    await rm(corpus, { recursive: true, force: true });
  }

  console.log("\n" + "=".repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

await main();
