/**
 * Streaming multipart upload — how an archive gets on the wire without ever
 * being in memory.
 *
 * Why not fetch(): undici's fetch retains the ENTIRE request body in live
 * ArrayBuffers while sending, whatever shape the body takes. Measured on
 * Node v24.18.0 against a throttled local server with forced GC, a 300 MB
 * file cost 315 MB of live ArrayBuffers as a file-backed Blob
 * (`fs.openAsBlob`, the API built for this) inside FormData, and the same
 * as a bare ReadableStream body — while `node:http` with per-chunk
 * backpressure cost 2 MB. fs.openAsBlob is also v19.8+ (nodejs.org/api/fs
 * "Added in: v19.8.0") and this SDK's documented floor is Node 18, so the
 * fetch route fails both requirements and `node:http` satisfies both.
 *
 * The body grammar is exactly the one the FormData path spoke and the one
 * the Python SDK's `_multipart_file_body` speaks: metadata as named parts
 * FIRST (the server refuses a bad name before the corpus arrives — that
 * only works if the name arrives first), then the file as the `archive`
 * part, then the closing boundary. Field names and filenames here are the
 * SDK's own fixed literals ("name", "version", "run_command", ...), never
 * caller data, so no header escaping is needed — do not route arbitrary
 * form fields through this.
 *
 * Content-Length is computed exactly (preamble + file size + epilogue), so
 * the request is identity-framed — no chunked transfer encoding for a proxy
 * to refuse. Redirects are not followed: a redirected upload would replay
 * the Authorization header at whatever host the server names, which is why
 * the Python SDK refuses redirects everywhere (evolve/_http.py); an upload
 * route never legitimately redirects.
 *
 * The wait is BOUNDED: 600 s of socket inactivity destroys the request with
 * the typed EvolveUploadTimeoutError. Same semantics and constant as the
 * Python lane (UPLOAD_TIMEOUT_SEC = 600 via urllib's per-operation socket
 * timeout, evolve/hosted.py) — inactivity, not wall clock, so a slow but
 * moving multi-GB upload survives while a dead server does not. The old
 * fetch path was bounded too (undici's 300 s response-headers default), so
 * an unbounded wait here would have been a regression, not parity.
 */
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { ClientRequest, IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";

/**
 * Socket-inactivity budget for an archive upload — the Python lane's
 * UPLOAD_TIMEOUT_SEC (600, evolve/hosted.py) in milliseconds. The two SDKs
 * hold ONE bound; change them together or not at all.
 */
export const UPLOAD_TIMEOUT_MS = 600_000;

/**
 * The upload's socket went silent past the budget — a dead or wedged server,
 * never a verdict on the archive. Typed so callers can tell a timeout from a
 * refused upload (EvolveApiError) or a local read failure.
 */
export class EvolveUploadTimeoutError extends Error {
  readonly name = "EvolveUploadTimeoutError";
  constructor(url: string, timeoutMs: number) {
    super(
      `upload to ${url} timed out: no socket activity for ${Math.round(timeoutMs / 1000)}s`
    );
  }
}

export interface MultipartFilePost {
  /** Absolute URL — the transport knows nothing of baseUrl or auth policy. */
  url: string;
  method: "POST" | "PUT";
  /** Extra headers (Authorization). Content-Type/-Length are computed here. */
  headers: Record<string, string>;
  /** Metadata parts, emitted before the file. undefined values are omitted. */
  fields: Record<string, string | undefined>;
  /** The archive to stream from disk as the `archive` part. */
  file: { path: string; filename: string };
  /**
   * Socket-inactivity bound override, for tests that prove the timeout
   * without waiting ten minutes. Production callers take the default.
   */
  timeoutMs?: number;
}

/** One chunk onto the wire, resolved when flushed — real backpressure. */
function writeChunk(req: ClientRequest, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    req.write(chunk, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * POST (or PUT) one file as a multipart/form-data body, streaming it from
 * disk in O(read-buffer) memory, and return a WHATWG Response so callers
 * keep the exact error mapping (`throwApiError`) and `.json()` reads they
 * use on fetch responses.
 */
export async function postMultipartFile(post: MultipartFilePost): Promise<Response> {
  const boundary = `----evolve${randomUUID().replace(/-/g, "")}`;
  const head: string[] = [];
  for (const [name, value] of Object.entries(post.fields)) {
    if (value === undefined) continue;
    head.push(
      `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
    );
  }
  head.push(
    `--${boundary}\r\nContent-Disposition: form-data; name="archive"; ` +
      `filename="${post.file.filename}"\r\nContent-Type: application/gzip\r\n\r\n`
  );
  const preamble = Buffer.from(head.join(""), "utf8");
  const closing = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  const { size } = await stat(post.file.path);

  const target = new URL(post.url);
  const requestFn = target.protocol === "https:" ? httpsRequest : httpRequest;
  const req = requestFn(target, {
    method: post.method,
    headers: {
      ...post.headers,
      "Content-Type": `multipart/form-data; boundary=${boundary}`,
      "Content-Length": String(preamble.length + size + closing.length),
    },
  });

  // The bounded await: socket inactivity past the budget destroys the
  // request with the typed error — send, response wait, and body read are
  // all covered by the one socket this rides. destroy(err) surfaces the
  // error on every pending operation; the flag keeps it the story even
  // where a stream layer rewraps the destruction.
  const timeoutMs = post.timeoutMs ?? UPLOAD_TIMEOUT_MS;
  let timedOut: EvolveUploadTimeoutError | undefined;
  req.setTimeout(timeoutMs, () => {
    timedOut = new EvolveUploadTimeoutError(post.url, timeoutMs);
    req.destroy(timedOut);
  });

  // The response can arrive BEFORE the body finishes sending: the
  // metadata-first grammar exists precisely so the server can refuse a bad
  // name without receiving the corpus. Once a response exists, a socket
  // error is aftermath (the server hung up on a body it already refused),
  // not the story.
  let response: IncomingMessage | undefined;
  const responseArrived = new Promise<IncomingMessage>((resolve, reject) => {
    req.on("response", (res) => {
      response = res;
      resolve(res);
    });
    req.on("error", (err) => {
      if (response === undefined) reject(err);
    });
  });
  // Handled below on every path; this keeps a rejection that races ahead of
  // the catch block from ever counting as unhandled.
  responseArrived.catch(() => {});

  try {
    await writeChunk(req, preamble);
    for await (const chunk of createReadStream(post.file.path)) {
      await writeChunk(req, chunk as Buffer);
    }
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      req.once("error", onError);
      req.end(closing, () => {
        req.off("error", onError);
        resolve();
      });
    });
  } catch (sendError) {
    // If the refusal already landed (a polite server answers early and keeps
    // draining — the normal shape; measured in tests/unit), it is the story,
    // not the broken pipe behind it. If not, destroy NOW and surface the
    // send error: waiting can only hang, and a server that slams the socket
    // right after responding loses that response to the EPIPE race anyway —
    // measured, the same outcome the fetch path had. The immediate destroy
    // also keeps stray late write completions from crashing the process.
    if (response === undefined) {
      req.destroy();
      throw timedOut ?? sendError;
    }
  }

  const res = await responseArrived.catch((err) => {
    throw timedOut ?? err;
  });
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of res) chunks.push(chunk as Buffer);
  } catch (readError) {
    throw timedOut ?? readError;
  }
  const body = Buffer.concat(chunks);

  const status = res.statusCode ?? 0;
  const headers = new Headers();
  for (const [name, value] of Object.entries(res.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const one of value) headers.append(name, one);
  }
  // Response() refuses a body on the null-body statuses.
  const bodyAllowed = status !== 204 && status !== 205 && status !== 304;
  return new Response(bodyAllowed ? body : null, {
    status,
    statusText: res.statusMessage ?? "",
    headers,
  });
}
