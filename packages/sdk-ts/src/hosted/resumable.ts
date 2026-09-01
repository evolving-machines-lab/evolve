/**
 * Resumable archive upload — the client half of the chunked publish door.
 *
 * Above RESUMABLE_UPLOAD_THRESHOLD_BYTES a dataset corpus stops riding one
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
 * REFUSALS RETURN, ERRORS THROW: any non-2xx the protocol cannot recover
 * from (a create refusal, a chunk digest mismatch, the finalize's typed
 * refusals) comes back as its WHATWG Response so the caller keeps the
 * shared throwApiError mapping; only transport failure past the attempt
 * budget throws.
 */
import { createHash } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * Switch point: archives at or under this ride the classic single POST
 * (proven, streaming, one request); above it the upload is chunked so a
 * dropped link resumes from the last acknowledged chunk. Harbor switches at
 * its own chunk size (6 MiB — storage.py:62-67); ours is deliberately
 * higher: the single-POST door already holds the contract well into the
 * hundreds of MiB, and below this the session bookkeeping is pure overhead.
 * The deviation is recorded in the spec (createDatasetUpload description).
 */
export const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 256 * 1024 * 1024;

/** Harbor's chunk size, verbatim (resumable.py:21) — and one S3 part each. */
export const RESUMABLE_UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;

/** Harbor's attempt budget, verbatim (resumable.py:20). */
export const RESUMABLE_UPLOAD_MAX_ATTEMPTS = 4;

/** Per-request inactivity bound — the same 600 s both SDKs hold everywhere. */
const REQUEST_TIMEOUT_MS = 600_000;

export interface ResumableUploadPost {
  /** Absolute base URL — the transport knows nothing of config policy. */
  baseUrl: string;
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

  const sessionsUrl = `${post.baseUrl}/api/datasets/publish/uploads`;
  const jsonHeaders = { ...post.headers, "Content-Type": "application/json" };

  // 1. Open the session. A refusal here (bad name, name taken, over the cap)
  // is the caller's to map; nothing has been transferred yet.
  const body: Record<string, string | number> = { size, sha256 };
  for (const [name, value] of Object.entries(post.fields)) {
    if (value !== undefined) body[name] = value;
  }
  const created = await boundedFetch(
    sessionsUrl,
    { method: "POST", headers: jsonHeaders, body: JSON.stringify(body) },
    timeoutMs,
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
    const probe = await boundedFetch(
      sessionUrl,
      { method: "HEAD", headers: post.headers },
      timeoutMs,
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
        response = await boundedFetch(
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

    // 3. Finalize — idempotent server-side, so a lost response is retried.
    let lastError: unknown;
    for (let attempt = 1; attempt <= RESUMABLE_UPLOAD_MAX_ATTEMPTS; attempt++) {
      try {
        return await postCompletion(`${sessionUrl}/complete`, post.headers, timeoutMs);
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
