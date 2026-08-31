#!/usr/bin/env tsx
/**
 * Unit Test: postMultipartFile() — the streaming archive upload
 *
 * Every archive that leaves this SDK (dataset corpus, agent tarball, skill
 * folder, job tree) rides this transport, because both FormData-with-a-Blob
 * and fetch itself hold the whole body in live memory while sending (the F1
 * incident: ~10x a corpus's size in RSS; a 7.7 GB corpus crashed the
 * machine). This transport streams the file from disk over `node:http` with
 * per-chunk backpressure.
 *
 * What this pins down, against a REAL local HTTP server (no fetch mock — the
 * whole point is that fetch is not involved):
 *   - the wire grammar: metadata parts FIRST, then the file as the `archive`
 *     part, closing boundary last — byte-compatible with what the FormData
 *     path sent and identical to the Python SDK's `_multipart_file_body`;
 *   - the archive bytes arrive exactly (sha256), with the declared filename
 *     and application/gzip part type;
 *   - Content-Length is exact and identity-framed — no chunked transfer
 *     encoding for a proxy to refuse;
 *   - undefined fields are omitted, Authorization rides through, PUT works
 *     (the agent upsert lane);
 *   - the reply comes back as a WHATWG Response (status + json), so callers
 *     keep the shared throwApiError mapping;
 *   - an early refusal — the server answering and hanging up BEFORE reading
 *     the body, which the metadata-first grammar exists to allow — surfaces
 *     as that response, never as a broken-pipe crash or a hang;
 *   - a dead socket (no response at all) rejects with the transport error.
 *
 * Usage:
 *   npm run test:unit:upload-stream
 *   npx tsx tests/unit/hosted-upload-stream.test.ts
 */

import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { postMultipartFile } from "../../src/hosted/upload.ts";

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

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: Buffer;
}

interface Part {
  name: string;
  filename?: string;
  type?: string;
  data: Buffer;
}

/** Parse a captured multipart body into its ordered parts. */
function parseMultipart(body: Buffer, contentType: string): Part[] {
  const match = /boundary=(.+)$/.exec(contentType);
  if (!match) throw new Error(`no boundary in content-type: ${contentType}`);
  const delim = Buffer.from(`--${match[1]}`);
  const parts: Part[] = [];
  let at = body.indexOf(delim);
  while (at !== -1) {
    const next = body.indexOf(delim, at + delim.length);
    if (next === -1) break; // the closing `--boundary--`
    // Between delimiters: \r\n headers \r\n\r\n data \r\n
    const segment = body.subarray(at + delim.length + 2, next - 2);
    const headerEnd = segment.indexOf("\r\n\r\n");
    const headerText = segment.subarray(0, headerEnd).toString("utf8");
    const data = segment.subarray(headerEnd + 4);
    const name = /name="([^"]*)"/.exec(headerText)?.[1] ?? "";
    const filename = /filename="([^"]*)"/.exec(headerText)?.[1];
    const type = /Content-Type: (.+)/.exec(headerText)?.[1];
    parts.push({ name, filename, type, data: Buffer.from(data) });
    at = next;
  }
  return parts;
}

/** A capture server: records the raw request, answers with `reply`. */
async function withServer(
  handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void,
  run: (base: string, calls: Captured[]) => Promise<void>
): Promise<void> {
  const calls: Captured[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      calls.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    await run(`http://127.0.0.1:${port}`, calls);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function jsonReply(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

// =============================================================================
// TESTS
// =============================================================================

async function testWireGrammar(fixture: string): Promise<void> {
  console.log("\n[1] The wire grammar: fields first, exact bytes, exact length");
  const archive = gzipSync(Buffer.from("the corpus"));
  const archivePath = join(fixture, "corpus.tar.gz");
  writeFileSync(archivePath, archive);

  await withServer(
    (_req, res) => jsonReply(res, 201, { ok: true }),
    async (base, calls) => {
      const res = await postMultipartFile({
        url: `${base}/api/datasets/publish`,
        method: "POST",
        headers: { Authorization: "Bearer test-key" },
        fields: { name: "my-set", version: "0.1", note: undefined },
        file: { path: archivePath, filename: "corpus.tar.gz" },
      });

      assertEqual(res.status, 201, "the reply is a WHATWG Response with the server's status");
      assertEqual(await res.json(), { ok: true }, "res.json() reads the server's body");

      const call = calls[0];
      assertEqual(call.method, "POST", "uses POST");
      assertEqual(call.url, "/api/datasets/publish", "the URL carries nothing");
      assertEqual(call.headers.authorization, "Bearer test-key", "Authorization rides through");
      assertEqual(
        call.headers["content-length"],
        String(call.body.length),
        "Content-Length is exact"
      );
      assertEqual(call.headers["transfer-encoding"], undefined, "never chunked — identity-framed");

      const parts = parseMultipart(call.body, call.headers["content-type"] ?? "");
      // Metadata first, so the server can refuse a bad name before receiving
      // a multi-gigabyte corpus — the order every multipart route keeps.
      assertEqual(
        parts.map((p) => p.name),
        ["name", "version", "archive"],
        "metadata parts precede the archive part; undefined fields are omitted"
      );
      assertEqual(parts[0]?.data.toString(), "my-set", "field value rides verbatim");
      const filePart = parts[2];
      assertEqual(filePart?.filename, "corpus.tar.gz", "the archive part carries its filename");
      assertEqual(filePart?.type, "application/gzip", "the archive part is application/gzip");
      assert(sha256(filePart!.data) === sha256(archive), "the archive bytes arrive exactly");
    }
  );
}

async function testPutMethod(fixture: string): Promise<void> {
  console.log("\n[2] PUT — the agent upsert lane");
  const archivePath = join(fixture, "source.tar.gz");
  writeFileSync(archivePath, gzipSync(Buffer.from("agent source")));

  await withServer(
    (_req, res) => jsonReply(res, 200, { name: "acme-cli" }),
    async (base, calls) => {
      const res = await postMultipartFile({
        url: `${base}/api/agents/acme-cli`,
        method: "PUT",
        headers: { Authorization: "Bearer test-key" },
        fields: { run_command: "acme-cli --headless" },
        file: { path: archivePath, filename: "source.tar.gz" },
      });
      assertEqual(res.status, 200, "PUT succeeds");
      assertEqual(calls[0]?.method, "PUT", "the method is PUT on the wire");
    }
  );
}

async function testEarlyRefusal(fixture: string): Promise<void> {
  console.log("\n[3] Early refusal — the server answers before reading the body");
  // Big enough that the client is still writing when the refusal lands.
  const archivePath = join(fixture, "big.tar.gz");
  writeFileSync(archivePath, Buffer.alloc(8 * 1024 * 1024, 7));

  const server = createServer((req, res) => {
    // Refuse at the headers — the exact move the metadata-first grammar
    // invites — while draining the rest of the body, as a real HTTP server
    // does. (A server that instead SLAMS the socket right after responding
    // loses its response to the EPIPE race — that shape lands in [4] as a
    // transport error, the same outcome the fetch path had.)
    res.statusCode = 400;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: { code: "invalid_name", message: "no" } }));
    req.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    const res = await postMultipartFile({
      url: `http://127.0.0.1:${port}/api/datasets/publish`,
      method: "POST",
      headers: { Authorization: "Bearer test-key" },
      fields: { name: "bad/../name" },
      file: { path: archivePath, filename: "corpus.tar.gz" },
    });
    assertEqual(res.status, 400, "the refusal surfaces as the response, not a pipe error");
    const body = (await res.json()) as { error: { code: string } };
    assertEqual(body.error.code, "invalid_name", "the typed refusal body survives");
  } catch (err) {
    failed++;
    console.log(`  ✗ early refusal surfaced as an error instead: ${(err as Error).message}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testDeadSocketRejects(fixture: string): Promise<void> {
  console.log("\n[4] A dead socket rejects with the transport error");
  const archivePath = join(fixture, "small.tar.gz");
  writeFileSync(archivePath, gzipSync(Buffer.from("x")));

  const server = createServer((req) => {
    // Kill the connection without ever answering.
    req.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  try {
    let threw = false;
    try {
      await postMultipartFile({
        url: `http://127.0.0.1:${port}/api/skills`,
        method: "POST",
        headers: {},
        fields: {},
        file: { path: archivePath, filename: "skill.tar.gz" },
      });
    } catch {
      threw = true;
    }
    assert(threw, "no response at all is an error, never a hang or a silent success");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function testMissingFileRejects(fixture: string): Promise<void> {
  console.log("\n[5] A missing archive file rejects before/instead of uploading garbage");
  let threw = false;
  try {
    await postMultipartFile({
      url: "http://127.0.0.1:9/api/skills",
      method: "POST",
      headers: {},
      fields: {},
      file: { path: join(fixture, "does-not-exist.tar.gz"), filename: "skill.tar.gz" },
    });
  } catch {
    threw = true;
  }
  assert(threw, "a nonexistent archive path rejects");
}

// =============================================================================
// RUNNER
// =============================================================================

async function main(): Promise<void> {
  console.log("postMultipartFile() — the streaming archive upload\n" + "=".repeat(60));

  const fixture = mkdtempSync(join(tmpdir(), "upload-stream-"));
  try {
    await testWireGrammar(fixture);
    await testPutMethod(fixture);
    await testEarlyRefusal(fixture);
    await testDeadSocketRejects(fixture);
    await testMissingFileRejects(fixture);
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
