#!/usr/bin/env tsx
/**
 * Unit Test: uploadArchiveResumable() — the chunked-resumable archive upload
 *
 * Above RESUMABLE_UPLOAD_THRESHOLD_BYTES a dataset corpus rides upload
 * sessions instead of one fragile request, so a dropped link resumes from
 * the last acknowledged chunk. The loop is Harbor's resumable client
 * re-expressed against our door (REFERENCES/Harbor
 * src/harbor/storage/resumable.py:106-149): sequential offset PATCHes, the
 * offset re-read with HEAD after any stumble, bounded attempts that reset on
 * progress, a non-advancing offset treated as a hard error.
 *
 * What this pins down, against a REAL local HTTP server holding a REAL
 * in-memory session (offsets, per-chunk checksum verification, assembly):
 *   - the wire shape: JSON create (size + whole-archive sha256 + fields),
 *     application/offset+octet-stream PATCHes with Upload-Offset and the
 *     TUS-spelled Upload-Checksum, the finalize POST;
 *   - the archive arrives EXACTLY (whole-file sha256 over the reassembly);
 *   - THE RESUME SEAM: a socket killed mid-transfer costs one HEAD re-probe
 *     and the transfer continues from the acknowledged offset — earlier
 *     chunks are never re-sent;
 *   - a re-probe that itself dies (the link still down) spends only that
 *     round's attempt — the transfer survives and completes (fb41406);
 *   - a 409 offset conflict re-probes and continues (the racer law);
 *   - typed refusals return as their Response (create 413, chunk digest
 *     mismatch 400) — the caller keeps the shared throwApiError mapping;
 *   - a server that keeps dropping exhausts RESUMABLE_UPLOAD_MAX_ATTEMPTS
 *     and throws the transport error;
 *   - an offset that does not advance is a hard error, never a spin;
 *   - a finalize whose response is lost is retried (the server's complete is
 *     idempotent by state) and the 202 still comes back;
 *   - THE RATE-LIMIT SEAM: a 429/503 on any request of the protocol is a
 *     delay, not an outcome — the server's Retry-After is waited (read by
 *     the ONE law, body first, header second; never below Harbor's backoff
 *     for that wait, never above RESUMABLE_UPLOAD_MAX_RETRY_AFTER_SEC) and
 *     the SAME request goes again at the SAME offset, at most
 *     RESUMABLE_UPLOAD_MAX_RATE_LIMIT_WAITS times per request, then the
 *     refusal returns as its Response for the typed mapping. The live
 *     failure this pins: an 8 GB publish died rc=1 on one 429 rate_limited
 *     (retryAfterSec=9) during part streaming, 2026-09-01.
 *
 * Usage:
 *   npx tsx tests/unit/hosted-resumable.test.ts
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listen, sessionServer, sha256 } from "./hosted-session-server.ts";
import {
  RESUMABLE_UPLOAD_CHUNK_BYTES,
  RESUMABLE_UPLOAD_MAX_ATTEMPTS,
  RESUMABLE_UPLOAD_MAX_RATE_LIMIT_WAITS,
  RESUMABLE_UPLOAD_MAX_RETRY_AFTER_SEC,
  RESUMABLE_UPLOAD_THRESHOLD_BYTES,
  retryAfterWaitMs,
  uploadArchiveResumable,
} from "../../src/hosted/resumable.ts";

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

// The session-server fixture lives in hosted-session-server.ts (one home,
// shared with the client and CLI suites).

const CHUNK = 64 * 1024;

async function main(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "evolve-resumable-test-"));
  const archive = randomBytes(CHUNK * 3 + 1234); // 3 full chunks + a small tail
  const archivePath = join(dir, "corpus.tar.gz");
  writeFileSync(archivePath, archive);

  console.log("\nconstants — Harbor parity");
  assert(
    RESUMABLE_UPLOAD_CHUNK_BYTES === 6 * 1024 * 1024,
    "chunk size is Harbor's 6 MiB (resumable.py:21)"
  );
  assert(RESUMABLE_UPLOAD_MAX_ATTEMPTS === 4, "attempt budget is Harbor's 4 (resumable.py:20)");
  assert(
    RESUMABLE_UPLOAD_THRESHOLD_BYTES === 256 * 1024 * 1024,
    "threshold is 256 MiB (recorded deviation from Harbor's 6 MiB — spec carries the reason)"
  );

  console.log("\nhappy path — the archive arrives exactly");
  {
    const { server, sessions, url } = sessionServer({});
    await listen(server);
    const progress: Array<[number, number]> = [];
    const res = await uploadArchiveResumable({
      baseUrl: url(),
      headers: { Authorization: "Bearer k" },
      file: { path: archivePath },
      fields: { name: "deep-swe", version: "1.1", org: undefined },
      chunkBytes: CHUNK,
      onBytes: (sent, total) => progress.push([sent, total]),
    });
    assert(res.status === 202, "the finalize's 202 comes back");
    const body = (await res.json()) as Record<string, unknown>;
    assert(body.id === "version-1", "the import body is the caller's to read");
    const state = [...sessions.values()][0];
    assert(state.fields.name === "deep-swe" && !("org" in state.fields),
      "create carried the fields; undefined ones omitted");
    const reassembled = Buffer.concat(state.received);
    assert(sha256(reassembled) === sha256(archive), "reassembled bytes hash identical");
    assert(state.received.length === 4, "3 full chunks + the small tail");
    // Upload progress on THIS transport too — above the threshold is exactly
    // the multi-GB shape the progress feature exists for.
    assert(progress.length === 4, "onBytes fired once per acknowledged chunk");
    assert(progress.every(([, total]) => total === archive.length),
      "totalBytes is the archive's size on every call");
    assert(progress[progress.length - 1]?.[0] === archive.length,
      "the last call reports sent == total");
    assert(progress.every(([sent], i) => i === 0 || progress[i - 1][0] < sent),
      "sent advances monotonically");
    server.close();
  }

  console.log("\nregister-first — the create's import_id reaches onRegistered before any byte");
  {
    const { server, url } = sessionServer({ importId: "imp-42" });
    await listen(server);
    const registered: string[] = [];
    let bytesAtRegister = -1;
    let sentSoFar = 0;
    const res = await uploadArchiveResumable({
      baseUrl: url(),
      headers: { Authorization: "Bearer k" },
      file: { path: archivePath },
      fields: { name: "deep-swe", version: "1.1" },
      chunkBytes: CHUNK,
      onBytes: (sent) => (sentSoFar = sent),
      onRegistered: (importId) => {
        registered.push(importId);
        bytesAtRegister = sentSoFar;
      },
    });
    assert(res.status === 202, "the transfer still completes normally");
    assert(registered.length === 1, "onRegistered fired exactly once");
    assert(registered[0] === "imp-42", "with the import id the create answered");
    assert(bytesAtRegister === 0, "BEFORE the first acknowledged chunk — attachable from byte zero");
    server.close();
  }

  console.log("\nregister-first — a server that registered nothing calls nothing");
  {
    const { server, url } = sessionServer({}); // no import_id in the 201
    await listen(server);
    const registered: string[] = [];
    const res = await uploadArchiveResumable({
      baseUrl: url(),
      headers: { Authorization: "Bearer k" },
      file: { path: archivePath },
      fields: { name: "deep-swe", version: "1.1" },
      chunkBytes: CHUNK,
      onRegistered: (importId) => registered.push(importId),
    });
    assert(res.status === 202, "the transfer completes as before");
    assert(registered.length === 0, "an absent import_id (older server / nothing registered) stays silence");
    server.close();
  }

  console.log("\nthe resume seam — a dropped socket costs one probe, never a restart");
  {
    let dropped = false;
    const { server, sessions, url } = sessionServer({
      onPatch: (state, _req, res) => {
        // Kill the SECOND chunk's first attempt after the offset was noted —
        // the client must re-probe and land the same offset again.
        if (state.patchOffsets.length === 2 && !dropped) {
          dropped = true;
          res.destroy();
          return true;
        }
        return false;
      },
    });
    await listen(server);
    const res = await uploadArchiveResumable({
      baseUrl: url(),
      headers: { Authorization: "Bearer k" },
      file: { path: archivePath },
      fields: { name: "deep-swe" },
      chunkBytes: CHUNK,
      timeoutMs: 5_000,
    });
    assert(res.status === 202, "the transfer completed after the drop");
    const state = [...sessions.values()][0];
    assert(sha256(Buffer.concat(state.received)) === sha256(archive), "bytes still exact");
    assert(
      state.patchOffsets.filter((offset) => offset === CHUNK).length === 2,
      "the dropped chunk was re-sent at ITS OWN offset (once dropped, once landed)"
    );
    assert(
      state.patchOffsets.filter((offset) => offset === 0).length === 1,
      "chunk 1 was never re-sent — resume, not restart"
    );
    server.close();
  }

  console.log("\na failed re-probe spends an attempt, never the transfer");
  {
    // The link that killed a chunk mid-flight is usually still down when
    // the recovery HEAD goes out. That probe failure must cost nothing but
    // the round's attempt (the next round re-probes — Harbor's outer retry
    // wraps its probes the same way, resumable.py:34-40); before fb41406 it
    // propagated out of the recovery seam and killed the whole transfer.
    let dropped = false;
    let probesKilled = 0;
    const { server, sessions, url } = sessionServer({
      onPatch: (state, _req, res) => {
        if (state.patchOffsets.length === 2 && !dropped) {
          dropped = true;
          res.destroy(); // mid-chunk link kill — the chunk never lands
          return true;
        }
        return false;
      },
    });
    server.prependListener("request", (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "HEAD" && probesKilled === 0) {
        probesKilled += 1;
        res.end = ((..._args: unknown[]) => {
          res.destroy(); // the FIRST re-probe dies on the wire too
          return res;
        }) as typeof res.end;
      }
    });
    await listen(server);
    const res = await uploadArchiveResumable({
      baseUrl: url(),
      headers: { Authorization: "Bearer k" },
      file: { path: archivePath },
      fields: { name: "deep-swe" },
      chunkBytes: CHUNK,
      timeoutMs: 5_000,
    });
    assert(res.status === 202, "the transfer survived the dead probe and completed");
    assert(probesKilled === 1, "the first re-probe genuinely failed on the wire");
    const state = [...sessions.values()][0];
    assert(sha256(Buffer.concat(state.received)) === sha256(archive), "bytes still exact");
    assert(
      state.patchOffsets.filter((offset) => offset === CHUNK).length === 2,
      "exactly one attempt spent: the killed chunk went out twice (killed, then landed)"
    );
    assert(
      state.patchOffsets.filter((offset) => offset === 0).length === 1,
      "chunk 1 was never re-sent after the dead probe — resume, not restart"
    );
    server.close();
  }

  console.log("\nthe lost-ack seam — the server landed the chunk, the response died");
  {
    // Chunk 2 is APPLIED server-side and only its ACK dies on the wire. The
    // client must learn the advanced offset from HEAD and send chunk 3 —
    // never chunk 2 again (a blind re-send would 409).
    const { server, sessions, url } = sessionServer({});
    let patchCount = 0;
    server.prependListener("request", (req: IncomingMessage, res: ServerResponse) => {
      if (req.method === "PATCH" && ++patchCount === 2) {
        // Land the chunk normally, then cut the wire instead of answering.
        res.end = ((..._args: unknown[]) => {
          res.destroy();
          return res;
        }) as typeof res.end;
      }
    });
    await listen(server);
    const res = await uploadArchiveResumable({
      baseUrl: url(),
      headers: {},
      file: { path: archivePath },
      fields: {},
      chunkBytes: CHUNK,
      timeoutMs: 5_000,
    });
    assert(res.status === 202, "the transfer completed after the lost ack");
    const state = [...sessions.values()][0];
    assert(sha256(Buffer.concat(state.received)) === sha256(archive), "bytes exact — nothing duplicated");
    assert(
      state.patchOffsets.filter((offset) => offset === CHUNK).length === 1,
      "the landed-but-unheard chunk was NOT re-sent — the probe carried the truth"
    );
    server.close();
  }

  console.log("\na 409 offset conflict re-probes and continues");
  {
    let conflicted = false;
    const { server, sessions, url } = sessionServer({
      onPatch: (state, _req, res) => {
        if (state.patchOffsets.length === 2 && !conflicted) {
          conflicted = true;
          res.statusCode = 409;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { code: "upload_offset_mismatch", message: "racer" } }));
          return true;
        }
        return false;
      },
    });
    await listen(server);
    const res = await uploadArchiveResumable({
      baseUrl: url(),
      headers: { Authorization: "Bearer k" },
      file: { path: archivePath },
      fields: {},
      chunkBytes: CHUNK,
      timeoutMs: 5_000,
    });
    assert(res.status === 202, "conflict recovered through the HEAD probe");
    const state = [...sessions.values()][0];
    assert(sha256(Buffer.concat(state.received)) === sha256(archive), "bytes exact after conflict");
    server.close();
  }

  console.log("\ntyped refusals return as their Response");
  {
    const { server, url } = sessionServer({
      onCreate: (res) => {
        res.statusCode = 413;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { code: "import_too_large", message: "over the cap" } }));
        return true;
      },
    });
    await listen(server);
    const res = await uploadArchiveResumable({
      baseUrl: url(),
      headers: {},
      file: { path: archivePath },
      fields: {},
      chunkBytes: CHUNK,
      timeoutMs: 5_000,
    });
    assert(res.status === 413, "a create refusal comes back for throwApiError to map");
    server.close();
  }

  console.log("\na server that keeps dropping exhausts the attempt budget");
  {
    const { server, url } = sessionServer({
      onPatch: (_state, _req, res) => {
        res.destroy();
        return true;
      },
    });
    await listen(server);
    let threw = false;
    try {
      await uploadArchiveResumable({
        baseUrl: url(),
        headers: {},
        file: { path: archivePath },
        fields: {},
        chunkBytes: CHUNK,
        timeoutMs: 2_000,
      });
    } catch {
      threw = true;
    }
    assert(threw, `throws after ${RESUMABLE_UPLOAD_MAX_ATTEMPTS} transport failures`);
    server.close();
  }

  console.log("\nan offset that does not advance is a hard error, never a spin");
  {
    const { server, url } = sessionServer({
      onPatch: (state, _req, res) => {
        res.statusCode = 204;
        res.setHeader("Upload-Offset", String(state.offset)); // stuck
        res.end();
        return true;
      },
    });
    await listen(server);
    let message = "";
    try {
      await uploadArchiveResumable({
        baseUrl: url(),
        headers: {},
        file: { path: archivePath },
        fields: {},
        chunkBytes: CHUNK,
        timeoutMs: 5_000,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assert(message.includes("did not advance"), "the non-advancing offset throws (Harbor's law)");
    server.close();
  }

  console.log("\na lost finalize response is retried — idempotent complete");
  {
    let completeCalls = 0;
    const { server, sessions, url } = sessionServer({
      onComplete: (_state, res) => {
        completeCalls += 1;
        if (completeCalls === 1) {
          res.destroy();
          return true;
        }
        return false;
      },
    });
    await listen(server);
    const res = await uploadArchiveResumable({
      baseUrl: url(),
      headers: {},
      file: { path: archivePath },
      fields: { name: "deep-swe" },
      chunkBytes: CHUNK,
      timeoutMs: 5_000,
    });
    assert(res.status === 202 && completeCalls === 2, "the second complete answered the 202");
    assert([...sessions.values()][0].completed === 1, "the server published exactly once");
    server.close();
  }

  console.log("\nthe finalize wait is bounded by OUR budget, not a transport's hidden one");
  {
    // A finalize whose headers arrive late (the server is mid-digest over a
    // multi-GB archive) must be WAITED OUT — the live failure this pins was
    // fetch's own 300 s headersTimeout aborting a 301 s digest pass, twice,
    // each abort burning a full server-side pass. node:http has no hidden
    // deadline; the delay here stands in for the long silent pass.
    const { server, url } = sessionServer({
      onComplete: (_state, res) => {
        setTimeout(() => {
          res.statusCode = 202;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ id: "version-1", status: "QUEUED" }));
        }, 1_500);
        return true;
      },
    });
    await listen(server);
    const res = await uploadArchiveResumable({
      baseUrl: url(),
      headers: {},
      file: { path: archivePath },
      fields: {},
      chunkBytes: CHUNK,
      timeoutMs: 10_000,
    });
    assert(res.status === 202, "a finalize slower than a fetch default still completes");
    server.close();
  }

  {
    // And the bound is REAL: a finalize that never answers is destroyed at
    // timeoutMs and, once the attempts are spent, throws — never a hang.
    const { server, url } = sessionServer({
      onComplete: () => true, // swallow: no response, ever
    });
    await listen(server);
    let message = "";
    const started = Date.now();
    try {
      await uploadArchiveResumable({
        baseUrl: url(),
        headers: {},
        file: { path: archivePath },
        fields: {},
        chunkBytes: CHUNK,
        timeoutMs: 700,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    assert(message.includes("finalize timed out"), "the silent finalize throws OUR typed timeout");
    assert(Date.now() - started < 30_000, "and does so within the bounded attempts, not a hang");
    server.close();
  }

  console.log("\nthe rate-limit seam — constants and the one wait law");
  {
    assert(RESUMABLE_UPLOAD_MAX_RATE_LIMIT_WAITS === 3, "at most 3 Retry-After waits per request");
    assert(RESUMABLE_UPLOAD_MAX_RETRY_AFTER_SEC === 60, "each wait capped at 60 s");
    assert(retryAfterWaitMs(9, 1) === 9_000, "the server's 9 s is honored as 9 s");
    assert(retryAfterWaitMs(3600, 1) === 60_000, "an hour-long Retry-After is capped at the 60 s bound");
    assert(retryAfterWaitMs(undefined, 1) === 500, "no reading at all → Harbor's backoff for wait 1 (0.5 s)");
    assert(retryAfterWaitMs(undefined, 3) === 2_000, "no reading at all → Harbor's backoff for wait 3 (2 s)");
    assert(retryAfterWaitMs(0, 2) === 1_000, "a zero delay is floored at the backoff — never an instant re-send");
  }

  const rateLimitBody = (retryAfterSec?: number) =>
    JSON.stringify({
      error: {
        code: "rate_limited",
        message: "Rate limit exceeded; retry after the Retry-After delay",
        ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
      },
    });

  console.log("\nthe rate-limit seam — a 429 mid-transfer is a delay, not a failure");
  {
    // The live failure: chunk 2's first PATCH answers 429 rate_limited with
    // the delay in the envelope (retryAfterSec, the body-first law). The
    // transfer must wait that long, re-send THE SAME chunk at THE SAME
    // offset, and complete — chunk 1 never re-sent.
    let refusedAt = 0;
    let resentAt = 0;
    const { server, sessions, url } = sessionServer({
      onPatch: (state, _req, res) => {
        if (state.patchOffsets.length === 2 && refusedAt === 0) {
          refusedAt = Date.now();
          res.statusCode = 429;
          res.setHeader("content-type", "application/json");
          res.end(rateLimitBody(0.7));
          return true;
        }
        if (state.patchOffsets.length === 3 && resentAt === 0) resentAt = Date.now();
        return false;
      },
    });
    await listen(server);
    const res = await uploadArchiveResumable({
      baseUrl: url(),
      headers: { Authorization: "Bearer k" },
      file: { path: archivePath },
      fields: { name: "deep-swe" },
      chunkBytes: CHUNK,
      timeoutMs: 5_000,
    });
    assert(res.status === 202, "the transfer completed after the 429");
    const state = [...sessions.values()][0];
    assert(sha256(Buffer.concat(state.received)) === sha256(archive), "bytes still exact");
    assert(
      state.patchOffsets.filter((offset) => offset === CHUNK).length === 2,
      "the refused chunk was re-sent at ITS OWN offset (once refused, once landed)"
    );
    assert(
      state.patchOffsets.filter((offset) => offset === 0).length === 1,
      "chunk 1 was never re-sent — the session resumed, not restarted"
    );
    assert(
      resentAt - refusedAt >= 650,
      `the envelope's 0.7 s was waited before the re-send (measured ${resentAt - refusedAt} ms)`
    );
    server.close();
  }

  console.log("\nthe rate-limit seam — a 503 with only the header is read by the same law");
  {
    let refusedAt = 0;
    let resentAt = 0;
    const { server, sessions, url } = sessionServer({
      onPatch: (state, _req, res) => {
        if (state.patchOffsets.length === 1 && refusedAt === 0) {
          refusedAt = Date.now();
          res.statusCode = 503;
          res.setHeader("Retry-After", "0.7"); // no body at all
          res.end();
          return true;
        }
        if (state.patchOffsets.length === 2 && resentAt === 0) resentAt = Date.now();
        return false;
      },
    });
    await listen(server);
    const res = await uploadArchiveResumable({
      baseUrl: url(),
      headers: {},
      file: { path: archivePath },
      fields: {},
      chunkBytes: CHUNK,
      timeoutMs: 5_000,
    });
    assert(res.status === 202, "the transfer completed after the 503");
    const state = [...sessions.values()][0];
    assert(sha256(Buffer.concat(state.received)) === sha256(archive), "bytes still exact");
    assert(resentAt - refusedAt >= 650, `the header's 0.7 s was waited (measured ${resentAt - refusedAt} ms)`);
    server.close();
  }

  console.log("\nthe rate-limit seam — a server that never relents spends the waits, then the refusal returns typed");
  {
    const { server, sessions, url } = sessionServer({
      onPatch: (_state, _req, res) => {
        res.statusCode = 429;
        res.setHeader("content-type", "application/json");
        res.end(rateLimitBody(0.01)); // floored at the backoff: 0.5 + 1 + 2 s of waits
        return true;
      },
    });
    await listen(server);
    const started = Date.now();
    const res = await uploadArchiveResumable({
      baseUrl: url(),
      headers: {},
      file: { path: archivePath },
      fields: {},
      chunkBytes: CHUNK,
      timeoutMs: 5_000,
    });
    assert(res.status === 429, "the 429 comes back as its Response for throwApiError to map — typed, never a hang");
    const body = (await res.json()) as { error?: { code?: string } };
    assert(body.error?.code === "rate_limited", "with the server's own envelope intact");
    const state = [...sessions.values()][0];
    assert(
      state.patchOffsets.length === 1 + RESUMABLE_UPLOAD_MAX_RATE_LIMIT_WAITS,
      `the chunk went out exactly 1 + ${RESUMABLE_UPLOAD_MAX_RATE_LIMIT_WAITS} times (got ${state.patchOffsets.length})`
    );
    assert(state.patchOffsets.every((offset) => offset === 0), "every attempt at the same offset — nothing skipped");
    const elapsed = Date.now() - started;
    assert(elapsed >= 3_400 && elapsed < 10_000, `three floored waits were spent (0.5 + 1 + 2 s; measured ${elapsed} ms)`);
    server.close();
  }

  console.log("\nthe rate-limit seam — the wait budget is per request, so a long transfer is never starved");
  {
    // Two chunks, each refused twice before landing: the budget belongs to
    // each request, so a limiter that stalls every chunk a few times still
    // lets a thousand-chunk transfer through — only a request that stays
    // refused past the budget ends it.
    const refusals = new Map<number, number>();
    const { server, sessions, url } = sessionServer({
      onPatch: (_state, req, res) => {
        const offset = Number(req.headers["upload-offset"]);
        const count = refusals.get(offset) ?? 0;
        if (offset < CHUNK * 2 && count < 2) {
          refusals.set(offset, count + 1);
          res.statusCode = 429;
          res.setHeader("content-type", "application/json");
          res.end(rateLimitBody(0.01));
          return true;
        }
        return false;
      },
    });
    await listen(server);
    const res = await uploadArchiveResumable({
      baseUrl: url(),
      headers: {},
      file: { path: archivePath },
      fields: {},
      chunkBytes: CHUNK,
      timeoutMs: 5_000,
    });
    assert(res.status === 202, "four refusals across two chunks — the transfer still completes");
    const state = [...sessions.values()][0];
    assert(sha256(Buffer.concat(state.received)) === sha256(archive), "bytes exact");
    assert(
      state.patchOffsets.filter((offset) => offset === 0).length === 3 &&
        state.patchOffsets.filter((offset) => offset === CHUNK).length === 3,
      "each stalled chunk went out 1 + 2 times, at its own offset"
    );
    server.close();
  }

  console.log("\nthe rate-limit seam — the session open and the finalize honor the same law");
  {
    let createRefused = false;
    let completeRefused = false;
    const { server, sessions, url } = sessionServer({
      onCreate: (res) => {
        if (createRefused) return false;
        createRefused = true;
        res.statusCode = 429;
        res.setHeader("content-type", "application/json");
        res.end(rateLimitBody(0.01));
        return true;
      },
      onComplete: (_state, res) => {
        if (completeRefused) return false;
        completeRefused = true;
        res.statusCode = 429;
        res.setHeader("content-type", "application/json");
        res.end(rateLimitBody(0.01));
        return true;
      },
    });
    await listen(server);
    const res = await uploadArchiveResumable({
      baseUrl: url(),
      headers: {},
      file: { path: archivePath },
      fields: { name: "deep-swe" },
      chunkBytes: CHUNK,
      timeoutMs: 5_000,
    });
    assert(res.status === 202 && createRefused && completeRefused, "a refused open and a refused finalize were both waited out");
    assert(sessions.size === 1, "the open was retried, not the whole transfer — one session");
    assert([...sessions.values()][0]?.completed === 1, "the server published exactly once");
    server.close();
  }

  rmSync(dir, { recursive: true, force: true });
  console.log(`\n═══ ${passed} passed, ${failed} failed ═══`);
  if (failed > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
