/**
 * Resumable archive upload — the client half of the chunked publish door.
 *
 * Above RESUMABLE_UPLOAD_THRESHOLD_BYTES a dataset corpus — or a job
 * archive, the same protocol on the job upload door — stops riding one
 * multipart POST (where a link that drops at GiB 7 of 8 restarts from byte
 * zero) and rides the platform's upload sessions instead: open a session
 * declaring the archive's exact size and whole-archive sha256, PATCH
 * strictly sequential chunks, and complete into the exact 202 the classic
 * door answers. The loop is Harbor's own resumable client, re-expressed
 * against our door (REFERENCES/Harbor src/harbor/storage/resumable.py):
 * 6 MiB chunks (:21), at most 4 attempts (:20) with 0.5 * 2^(n-1) backoff
 * capped at 4 s (:129, tenacity's wait_exponential mirrored), the offset
 * re-read from the server after any transport error and the file handle
 * re-seeked there (:130-135), a served offset that fails to advance treated
 * as a hard error (:143-146), and the attempt budget reset whenever a chunk
 * lands (:149) — inactivity is what is bounded, not total transfer time.
 *
 * MEMORY: one chunk buffer (6 MiB) lives at a time, read straight off the
 * file descriptor — never the whole archive (the F1 incident's law). fetch
 * holding a 6 MiB body whole is exactly the bounded cost this transfer
 * shape exists to make acceptable; the multi-GB single-request path keeps
 * its node:http streaming transport (upload.ts) for the same reason.
 *
 * RATE LIMITS ARE DELAYS, NOT OUTCOMES: a 429/503 on any request of the
 * protocol (open, probe, chunk, finalize) is waited out — the server's
 * Retry-After, read by the one law (retry-after.ts), floored at Harbor's
 * backoff and capped at RESUMABLE_UPLOAD_MAX_RETRY_AFTER_SEC — and the SAME
 * request goes again at the SAME offset, at most
 * RESUMABLE_UPLOAD_MAX_RATE_LIMIT_WAITS times per request. The chunk is
 * safe to re-send: the platform refuses a rate-limited PATCH before its
 * first body byte (swarm_dashboard lib/evaluations/api-errors.ts, the
 * limiter inside the auth step; the heap gate in the PATCH route likewise),
 * and were a chunk ever applied under a lost 429 the re-send's 409 lands
 * in the offset re-probe below. Harbor's publisher retries transport
 * errors only and has no 429 handling (publisher.py:44-48, 165-170) —
 * this bound is the recorded extension for a door with a per-user rate
 * limiter in front of every chunk.
 *
 * REFUSALS RETURN, ERRORS THROW: any non-2xx the protocol cannot recover
 * from (a create refusal, a chunk digest mismatch, the finalize's typed
 * refusals, a 429/503 still standing after its waits) comes back as its
 * WHATWG Response so the caller keeps the shared throwApiError mapping;
 * only transport failure past the attempt budget throws.
 */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

import { readRetryAfterSec } from "./retry-after";

/**
 * Switch point: archives at or under this ride the classic single POST
 * (proven, streaming, one request); above it the upload is chunked so a
 * dropped link resumes from the last acknowledged chunk. Harbor switches at
 * its own chunk size (6 MiB — storage.py:62-67); ours is deliberately
 * higher: the single-POST door already holds the contract well into the
 * hundreds of MiB, and below this the session bookkeeping is pure overhead.
 * The deviation is recorded in the spec (createDatasetUpload description).
 *
 * `let`, not `const`: publish() reads this binding at CALL time
 * (hosted/index.ts), and the unit suites lower it through
 * setResumableUploadThresholdBytes below so a KB fixture corpus rides the
 * resumable door — the same seam the Python suite gets for free by
 * monkeypatching hosted.RESUMABLE_UPLOAD_THRESHOLD_BYTES
 * (test_hosted_upload_progress.py). Production never reassigns it.
 */
export let RESUMABLE_UPLOAD_THRESHOLD_BYTES = 256 * 1024 * 1024;

/**
 * Test seam mirroring the Python SDK's module-global monkeypatch: ESM
 * forbids assigning to an imported binding from outside the module, so the
 * TS suites lower (and afterwards restore) the live binding through this
 * setter instead. Not re-exported from the package entry — it is not API.
 */
export function setResumableUploadThresholdBytes(bytes: number): void {
  RESUMABLE_UPLOAD_THRESHOLD_BYTES = bytes;
}

/** Harbor's chunk size, verbatim (resumable.py:21) — and one S3 part each. */
export const RESUMABLE_UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;

/** Harbor's attempt budget, verbatim (resumable.py:20). */
export const RESUMABLE_UPLOAD_MAX_ATTEMPTS = 4;

/**
 * The rate-limit bound, per request of the protocol: a 429/503 is waited
 * out and the same request sent again at most this many times, then the
 * refusal returns typed. Harbor's publisher retries transport errors only
 * (publisher.py:44-48, 165-170) and has no 429 handling at all — ours is
 * the recorded extension for a hosted door with a per-user rate limiter in
 * front of every chunk PATCH (the live failure: an 8 GB publish died on ONE
 * 429 rate_limited with retryAfterSec=9, 2026-09-01).
 */
export const RESUMABLE_UPLOAD_MAX_RATE_LIMIT_WAITS = 3;

/** Cap on one honored Retry-After — a server asking for longer waits this long. */
export const RESUMABLE_UPLOAD_MAX_RETRY_AFTER_SEC = 60;

/** Per-request inactivity bound — the same 600 s both SDKs hold everywhere. */
const REQUEST_TIMEOUT_MS = 600_000;

export interface ResumableUploadPost {
  /** Absolute base URL — the transport knows nothing of config policy. */
  baseUrl: string;
  /**
   * The session door's path: the dataset publish door by default
   * (`/api/datasets/publish/uploads`), or the job upload door
   * (`/api/jobs/upload/uploads`) — the same protocol on both (swarm_dashboard
   * lib/evaluations/import/upload-session-verbs.ts binds one verbs module
   * under each door), so the loop below is spelled once.
   */
  sessionsPath?: string;
  /** Extra headers (Authorization). Content headers are computed here. */
  headers: Record<string, string>;
  /** The archive to chunk from disk. */
  file: { path: string };
  /** Create-session metadata (name/version/org); undefined values omitted. */
  fields: Record<string, string | undefined>;
  /**
   * Client-side upload progress: called `(sentBytes, totalBytes)` after each
   * server-ACKNOWLEDGED chunk — the served offset IS the sent count, so a
   * resumed transfer reports the true position, never a re-count. Same
   * signature as the single-request transport's onBytes (upload.ts).
   */
  onBytes?: (sentBytes: number, totalBytes: number) => void;
  /**
   * Register-first: called once with the pre-created import id the session
   * open answered (`import_id`), before the first chunk goes out — the SAME
   * id the finalize's 202 carries, so a watcher may attach mid-upload. Not
   * called when the server registered nothing (an older server, or a
   * name@version that already had a version row).
   */
  onRegistered?: (importId: string) => void;
  /** Chunk-size override for tests that prove the loop without 6 MiB buffers. */
  chunkBytes?: number;
  /** Per-request timeout override, for tests. Production takes the default. */
  timeoutMs?: number;
}

/** sha256 (hex) of a whole file, streamed off disk. */
async function fileSha256(path: string): Promise<string> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Harbor's backoff: 0.5 * 2^(attempt-1), capped at 4 s (resumable.py:129). */
function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 4000);
}

/**
 * How long one 429/503 is waited: the server's Retry-After (readRetryAfterSec's
 * one law — body first, header second), never below Harbor's backoff for this
 * wait (an absent or zero delay is not an instant re-send — the one thing a
 * rate limit forbids), never above RESUMABLE_UPLOAD_MAX_RETRY_AFTER_SEC.
 * Exported for its unit test only — not API.
 */
export function retryAfterWaitMs(retryAfterSec: number | undefined, wait: number): number {
  const asked = retryAfterSec === undefined ? 0 : retryAfterSec * 1000;
  return Math.min(Math.max(asked, backoffMs(wait)), RESUMABLE_UPLOAD_MAX_RETRY_AFTER_SEC * 1000);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One bounded fetch; AbortController because a dead server must not hang the loop. */
async function boundedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const isRateLimited = (res: Response): boolean => res.status === 429 || res.status === 503;

/**
 * One request of the protocol under the rate-limit law (module header): a
 * 429/503 is waited and the SAME request sent again, at most
 * RESUMABLE_UPLOAD_MAX_RATE_LIMIT_WAITS times, then the refusal returns as
 * its Response for the typed mapping. Transport errors pass straight
 * through to each caller's own seam — the chunk loop's re-probe, the
 * finalize's bounded attempts.
 */
async function sendHonoringRetryAfter(send: () => Promise<Response>): Promise<Response> {
  for (let waits = 0; ; waits += 1) {
    const response = await send();
    if (!isRateLimited(response) || waits >= RESUMABLE_UPLOAD_MAX_RATE_LIMIT_WAITS) return response;
    // This refusal is spent, so its body is read here; the one that ends
    // the waits returns above unread, envelope intact for throwApiError.
    const text = await response.text().catch(() => "");
    await sleep(retryAfterWaitMs(readRetryAfterSec(text, response), waits + 1));
  }
}

/**
 * The finalize POST, over node:http rather than fetch — the same reason
 * upload.ts exists: fetch (undici) holds its own fixed internal deadlines
 * (headersTimeout, 300 s by default) that no RequestInit can raise, and a
 * multi-GB finalize legitimately keeps the response silent longer than that
 * while the server streams the assembled archive through its digest pass
 * (measured live: 301 s for 2.5 GiB on a residential downlink — the fetch
 * path aborted at exactly 300 s, twice, and each aborted attempt burned a
 * full server-side digest pass). Here the ONLY bound is ours: `timeoutMs`
 * of response silence, then a destroy and a thrown Error. The chunk/probe
 * verbs stay on fetch on purpose — their responses arrive in seconds and
 * a second transport would buy them nothing.
 */
function postCompletion(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const target = new URL(url);
    const requestFn = target.protocol === "https:" ? httpsRequest : httpRequest;
    const req = requestFn(target, { method: "POST", headers });
    const timer = setTimeout(() => {
      req.destroy(new Error(`finalize timed out: no response for ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    timer.unref?.();
    req.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    req.on("response", (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      res.on("end", () => {
        clearTimeout(timer);
        const responseHeaders = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (typeof value === "string") responseHeaders.set(name, value);
          else if (Array.isArray(value)) for (const one of value) responseHeaders.append(name, one);
        }
        const status = res.statusCode ?? 0;
        const bodyAllowed = status !== 204 && status !== 205 && status !== 304;
        resolve(
          new Response(bodyAllowed ? Buffer.concat(chunks) : null, {
            status,
            statusText: res.statusMessage ?? "",
            headers: responseHeaders,
          }),
        );
      });
    });
    req.end();
  });
}

/**
 * Upload one on-disk archive through an upload session and return the
 * finalize's Response (the classic publish 202 on success). See the module
 * header for the return-vs-throw contract.
 */
export async function uploadArchiveResumable(post: ResumableUploadPost): Promise<Response> {
  const timeoutMs = post.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const chunkBytes = post.chunkBytes ?? RESUMABLE_UPLOAD_CHUNK_BYTES;
  const { size } = await stat(post.file.path);
  const sha256 = await fileSha256(post.file.path);

  const sessionsUrl = `${post.baseUrl}${post.sessionsPath ?? "/api/datasets/publish/uploads"}`;
  const jsonHeaders = { ...post.headers, "Content-Type": "application/json" };

  // 1. Open the session. A refusal here (bad name, name taken, over the cap)
  // is the caller's to map; nothing has been transferred yet.
  const body: Record<string, string | number> = { size, sha256 };
  for (const [name, value] of Object.entries(post.fields)) {
    if (value !== undefined) body[name] = value;
  }
  const created = await sendHonoringRetryAfter(() =>
    boundedFetch(
      sessionsUrl,
      { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) },
      timeoutMs,
    ),
  );
  if (!created.ok) return created;
  const session = (await created.json()) as { id: string; import_id?: string | null };
  const sessionUrl = `${sessionsUrl}/${session.id}`;
  // Register-first: the open pre-created the import — hand its id over
  // before the first byte moves, so the caller can print/attach a watcher
  // while the transfer runs.
  if (typeof session.import_id === "string" && session.import_id !== "") {
    post.onRegistered?.(session.import_id);
  }

  // The server's current offset — what HEAD re-reads after any stumble
  // (Harbor's recovery, resumable.py:130-135).
  const probeOffset = async (): Promise<number> => {
    const probe = await sendHonoringRetryAfter(() =>
      boundedFetch(sessionUrl, { method: "HEAD", headers: post.headers }, timeoutMs),
    );
    if (!probe.ok) throw new Error(`upload session probe failed: HTTP ${probe.status}`);
    const offset = Number(probe.headers.get("upload-offset"));
    if (!Number.isInteger(offset)) {
      throw new Error("upload session probe did not return Upload-Offset");
    }
    return offset;
  };

  // 2. The sequential chunk loop.
  const handle = await open(post.file.path, "r");
  try {
    let offset = 0;
    let attempts = 0;
    const buffer = Buffer.alloc(chunkBytes);
    while (offset < size) {
      const length = Math.min(chunkBytes, size - offset);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      if (bytesRead !== length) {
        throw new Error(
          `archive shrank mid-upload: read ${bytesRead} of ${length} bytes at offset ${offset}`,
        );
      }
      const chunk = buffer.subarray(0, length);
      const chunkDigest = createHash("sha256").update(chunk).digest();
      let response: Response;
      try {
        // Under the rate-limit law: a 429/503 waits and re-sends THIS chunk
        // at THIS offset — the buffer is untouched until the loop advances.
        response = await sendHonoringRetryAfter(() =>
          boundedFetch(
            sessionUrl,
            {
              method: "PATCH",
              headers: {
                ...post.headers,
                "Content-Type": "application/offset+octet-stream",
                "Upload-Offset": String(offset),
                // TUS's checksum-extension spelling; required by our door.
                "Upload-Checksum": `sha256 ${chunkDigest.toString("base64")}`,
              },
              // A fresh copy: fetch may read the body after the loop reuses
              // the buffer for the next chunk.
              body: new Uint8Array(chunk),
            },
            timeoutMs,
          ),
        );
      } catch (transportError) {
        // The dropped-link seam. Bounded attempts, Harbor's backoff, then
        // the offset re-read — the chunks that were acknowledged stay sent.
        attempts += 1;
        if (attempts >= RESUMABLE_UPLOAD_MAX_ATTEMPTS) throw transportError;
        await sleep(backoffMs(attempts));
        try {
          offset = await probeOffset();
        } catch {
          // The link is still down — the probe spends nothing but this
          // attempt; the next round re-probes (Harbor's outer retry wraps
          // its probes the same way, resumable.py:34-40).
        }
        continue;
      }
      if (response.status === 409) {
        // Someone advanced the session past us (a resumed racer), or our
        // view is stale — the answer is the server's offset, not a guess.
        attempts += 1;
        if (attempts >= RESUMABLE_UPLOAD_MAX_ATTEMPTS) return response;
        offset = await probeOffset();
        continue;
      }
      if (!response.ok) return response;
      const served = Number(response.headers.get("upload-offset"));
      if (!Number.isInteger(served) || served <= offset) {
        // Harbor's own hard error: an offset that does not advance would
        // loop forever (resumable.py:143-146).
        throw new Error("resumable upload did not advance Upload-Offset");
      }
      offset = served;
      attempts = 0;
      post.onBytes?.(offset, size);
    }

    // 3. Finalize — idempotent server-side, so a lost response is retried
    // (and a rate-limited one waited, the same law as every request above).
    let lastError: unknown;
    for (let attempt = 1; attempt <= RESUMABLE_UPLOAD_MAX_ATTEMPTS; attempt++) {
      try {
        return await sendHonoringRetryAfter(() =>
          postCompletion(`${sessionUrl}/complete`, post.headers, timeoutMs),
        );
      } catch (transportError) {
        lastError = transportError;
        if (attempt < RESUMABLE_UPLOAD_MAX_ATTEMPTS) await sleep(backoffMs(attempt));
      }
    }
    throw lastError;
  } finally {
    await handle.close();
  }
}
