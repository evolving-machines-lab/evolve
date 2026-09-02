/**
 * Shared test fixture: the REAL minimal upload-session server behind the
 * resumable publish door. One home, four suites — the transport suite
 * (hosted-resumable.test.ts) drives uploadArchiveResumable() straight at
 * it, the client suite (hosted-client.test.ts) drives publish() through
 * it, the CLI suite (cli.test.ts) drives `dataset publish` end to end
 * over it (the finalize rides node:http, which no fetch mock can see, so
 * only a real server can host those flows), and the piped-consumer suite
 * (cli-ndjson-pipe.test.ts) spawns the built bin against it.
 *
 * It verifies each chunk's Upload-Checksum, advances the offset, answers
 * HEAD probes, and assembles at complete. `faults` lets one test inject
 * exactly one behavior at one moment. A hook may answer with a promise:
 * the request is then HELD (its body already read) until the promise
 * settles, and its answer resolves whether the default path runs — the
 * causal gates of the piped-consumer suite (cli-ndjson-pipe.test.ts) hold
 * a chunk or the finalize until the consumer has received a line.
 */
import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const sha256 = (data: Buffer): string =>
  createHash("sha256").update(data).digest("hex");

export interface SessionState {
  id: string;
  size: number;
  sha256: string;
  fields: Record<string, string>;
  received: Buffer[];
  offset: number;
  patchOffsets: number[];
  completed: number;
}

export interface SessionServerFaults {
  onCreate?: (res: ServerResponse) => boolean;
  onPatch?: (
    state: SessionState,
    req: IncomingMessage,
    res: ServerResponse,
  ) => boolean | Promise<boolean>;
  onComplete?: (state: SessionState, res: ServerResponse) => boolean | Promise<boolean>;
  /**
   * Register-first: when set, the create 201 carries this `import_id` — the
   * pre-created import a watcher may attach to mid-upload. Unset = the
   * pre-register-first server, whose 201 has no such field.
   */
  importId?: string;
  /**
   * Serve a request OUTSIDE the upload-session routes (the CLI suite drives
   * a whole `dataset publish --watch` through this server, so the watch's
   * import and dataset-detail polls land here). Return true when handled;
   * false falls through to the 404.
   */
  onOther?: (req: IncomingMessage, res: ServerResponse, body: Buffer) => boolean;
}

export function sessionServer(faults: SessionServerFaults): {
  server: Server;
  sessions: Map<string, SessionState>;
  url: () => string;
} {
  const sessions = new Map<string, SessionState>();
  let nextId = 1;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const url = req.url ?? "";
      if (req.method === "POST" && url === "/api/datasets/publish/uploads") {
        if (faults.onCreate?.(res)) return;
        const parsed = JSON.parse(body.toString()) as Record<string, unknown>;
        const state: SessionState = {
          id: `up-${nextId++}`,
          size: parsed.size as number,
          sha256: parsed.sha256 as string,
          fields: Object.fromEntries(
            Object.entries(parsed).filter(([key]) => key !== "size" && key !== "sha256"),
          ) as Record<string, string>,
          received: [],
          offset: 0,
          patchOffsets: [],
          completed: 0,
        };
        sessions.set(state.id, state);
        res.statusCode = 201;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            id: state.id,
            state: "RECEIVING",
            offset: 0,
            size: state.size,
            ...(faults.importId !== undefined ? { import_id: faults.importId } : {}),
          }),
        );
        return;
      }
      const match = /^\/api\/datasets\/publish\/uploads\/([\w-]+)(\/complete)?$/.exec(url);
      const state = match ? sessions.get(match[1]) : undefined;
      if (!match || !state) {
        if (faults.onOther?.(req, res, body)) return;
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: "upload_session_not_found", message: "no" } }));
        return;
      }
      if (req.method === "HEAD") {
        res.statusCode = 200;
        res.setHeader("Upload-Offset", String(state.offset));
        res.setHeader("Upload-Length", String(state.size));
        res.end();
        return;
      }
      if (req.method === "PATCH") {
        const offset = Number(req.headers["upload-offset"]);
        state.patchOffsets.push(offset);
        if (await faults.onPatch?.(state, req, res)) return;
        if (offset !== state.offset) {
          res.statusCode = 409;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({
              error: {
                code: "upload_offset_mismatch",
                message: "not the next byte",
                details: { expected_offset: state.offset },
              },
            }),
          );
          return;
        }
        const declared = /^sha256 (.+)$/.exec(String(req.headers["upload-checksum"] ?? ""));
        const digest = declared ? Buffer.from(declared[1], "base64").toString("hex") : null;
        if (digest !== sha256(body)) {
          res.statusCode = 400;
          res.setHeader("content-type", "application/json");
          res.end(
            JSON.stringify({ error: { code: "upload_chunk_digest_mismatch", message: "bad chunk" } }),
          );
          return;
        }
        state.received.push(body);
        state.offset += body.length;
        res.statusCode = 204;
        res.setHeader("Upload-Offset", String(state.offset));
        res.end();
        return;
      }
      if (req.method === "POST" && match[2] === "/complete") {
        if (await faults.onComplete?.(state, res)) return;
        if (state.offset !== state.size) {
          res.statusCode = 409;
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { code: "upload_incomplete", message: "missing bytes" } }));
          return;
        }
        state.completed += 1;
        res.statusCode = 202;
        res.setHeader("content-type", "application/json");
        // The 202 echoes what the real door echoes: the classic publish
        // body, name AND version from the create's own fields.
        res.end(
          JSON.stringify({
            id: "version-1",
            status: "QUEUED",
            name: state.fields.name,
            version: state.fields.version,
          }),
        );
        return;
      }
      res.statusCode = 405;
      res.end();
    });
  });
  return {
    server,
    sessions,
    url: () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no address");
      return `http://127.0.0.1:${address.port}`;
    },
  };
}

export function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
