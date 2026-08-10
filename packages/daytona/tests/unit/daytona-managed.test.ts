#!/usr/bin/env tsx
/**
 * Unit Test: Daytona Evolve-managed mode
 *
 * Managed mode is what makes Daytona reachable with an Evolve API key and no
 * Daytona credential. Two things carry it, and both are tested here:
 *
 *   1. The toolbox base URL. Daytona sends every command and file operation to
 *      a per-sandbox runner it discovers at runtime; managed mode answers that
 *      discovery locally with the Dashboard's toolbox route.
 *   2. The streaming log follow. The Daytona SDK follows logs over a
 *      websocket, which a Dashboard route handler cannot terminate, so managed
 *      mode follows the same endpoint over chunked HTTP and demultiplexes the
 *      stdout/stderr framing itself.
 *
 * Usage:
 *   npx tsx tests/unit/daytona-managed.test.ts
 */

import {
  _testCreateLogDemuxer,
  _testCreateSentinelFilter,
  _testFollowManagedSessionLogs,
  _testReadCommandStreams,
  _testSettledStreams,
  _testStripEndOfOutputSentinel,
  _testWithEndOfOutputSentinel,
  createDaytonaProvider,
  DaytonaCommands,
  DaytonaResourcesError,
} from "../../src/index.ts";

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

const STDOUT_MARK = new Uint8Array([1, 1, 1]);
const STDERR_MARK = new Uint8Array([2, 2, 2]);

function bytes(...parts: Array<Uint8Array | string>): Uint8Array {
  const chunks = parts.map((part) =>
    typeof part === "string" ? new TextEncoder().encode(part) : part,
  );
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// =============================================================================
// [1] Log demultiplexing
// =============================================================================

function testDemuxSplitsStreams(): void {
  console.log("\n[1a] Demuxer splits stdout and stderr");
  let out = "";
  let err = "";
  const demuxer = _testCreateLogDemuxer(
    (chunk) => (out += chunk),
    (chunk) => (err += chunk),
  );

  demuxer.push(bytes(STDOUT_MARK, "hello ", STDERR_MARK, "boom", STDOUT_MARK, "world"));
  demuxer.flush();

  assert(out === "hello world", `stdout is "hello world" (got ${JSON.stringify(out)})`);
  assert(err === "boom", `stderr is "boom" (got ${JSON.stringify(err)})`);
}

function testDemuxHandlesMarkerAcrossChunks(): void {
  console.log("\n[1b] A marker split across two chunks is still a marker");
  let out = "";
  let err = "";
  const demuxer = _testCreateLogDemuxer(
    (chunk) => (out += chunk),
    (chunk) => (err += chunk),
  );

  // The stderr marker is 3 bytes; deliver it one byte at a time so the
  // held-back tail is the only thing that can keep the framing intact.
  demuxer.push(bytes(STDOUT_MARK, "before"));
  demuxer.push(new Uint8Array([2]));
  demuxer.push(new Uint8Array([2]));
  demuxer.push(bytes(new Uint8Array([2]), "after"));
  demuxer.flush();

  assert(out === "before", `stdout stopped at the marker (got ${JSON.stringify(out)})`);
  assert(err === "after", `stderr picked up after it (got ${JSON.stringify(err)})`);
}

function testDemuxHandlesSplitUtf8(): void {
  console.log("\n[1c] A multi-byte character split across chunks is not mangled");
  let out = "";
  const demuxer = _testCreateLogDemuxer(
    (chunk) => (out += chunk),
    () => {},
  );

  // "é" is 0xC3 0xA9. Padding keeps each half outside the held-back tail so
  // the decoder, not the buffer, is what has to hold the partial character.
  const euro = new TextEncoder().encode("é");
  demuxer.push(bytes(STDOUT_MARK, "pad", euro.subarray(0, 1)));
  demuxer.push(bytes(euro.subarray(1), "pad"));
  demuxer.flush();

  assert(out === "padépad", `decoded across the boundary (got ${JSON.stringify(out)})`);
}

function testDemuxKeepsUnframedBytes(): void {
  console.log("\n[1d] Unframed output is delivered, not dropped");
  // Some Daytona daemon builds return combined bytes with NO markers at all —
  // measured on a live ubuntu:22.04 sandbox. Dropping everything before the
  // first marker (which is what the SDK's own demux does) turns that into a
  // command that printed nothing, with exit 0. Unframed bytes are stdout.
  let out = "";
  let err = "";
  const demuxer = _testCreateLogDemuxer(
    (chunk) => (out += chunk),
    (chunk) => (err += chunk),
  );

  demuxer.push(bytes("unframed", STDOUT_MARK, "framed"));
  demuxer.flush();

  assert(out === "unframedframed", `unframed bytes reach stdout (got ${JSON.stringify(out)})`);
  assert(err === "", "nothing leaked into stderr");

  let plainOut = "";
  const plain = _testCreateLogDemuxer(
    (chunk) => (plainOut += chunk),
    () => {},
  );
  plain.push(bytes("hello-managed\noops\n"));
  plain.flush();
  assert(
    plainOut === "hello-managed\noops\n",
    `a wholly unframed stream still arrives (got ${JSON.stringify(plainOut)})`,
  );
}

function testReadCommandStreams(): void {
  console.log("\n[1e] An empty demuxed stream is not the same as no output");
  // The SDK's demux returns "" for a stream whose marker never appears, and ??
  // does not fall through an empty string — so `stdout ?? output` reported
  // every unframed command as silent. Measured: exit 0, stdout "", while
  // output held both lines.
  const unframed = _testReadCommandStreams({
    output: "hello-managed\noops\n",
    stdout: "",
    stderr: "",
  });
  assert(
    unframed.stdout === "hello-managed\noops\n",
    `unframed output becomes stdout (got ${JSON.stringify(unframed.stdout)})`,
  );

  const framed = _testReadCommandStreams({
    output: "combined",
    stdout: "out",
    stderr: "err",
  });
  assert(framed.stdout === "out" && framed.stderr === "err", "a framed response is untouched");

  const stderrOnly = _testReadCommandStreams({ output: "boom", stdout: "", stderr: "boom" });
  assert(
    stderrOnly.stdout === "" && stderrOnly.stderr === "boom",
    "a command that only wrote to stderr keeps stdout empty",
  );

  const silent = _testReadCommandStreams({ output: "", stdout: "", stderr: "" });
  assert(silent.stdout === "" && silent.stderr === "", "a genuinely silent command stays silent");
}

// =============================================================================
// [1f-1h] The end-of-output sentinel
//
// MEASURED 2026-08-03 on a live daytona sandbox (daytonaio/sandbox:0.8.0):
// `printf '%s' 'PM-PROBE-DAYTONA-BYTES-OK'` and `echo` of the same 25 bytes
// land in the session log as the SAME bytes — 01 01 01 <25 bytes> 0a — while
// `wc -c` in the box says 25 and 26. The log is line-oriented and terminates
// the last line itself, so nothing read from it alone can tell the two apart.
// The sentinel is what the box prints to mark where its output really ended.
// =============================================================================

const TOKEN = "EVOLVE-EOS-mfkq2s-a1b2c3";

function testSentinelCommandShape(): void {
  console.log("\n[1f] The command tells the box to mark its own end of output");
  const wrapped = _testWithEndOfOutputSentinel("echo hi", TOKEN);

  // NOTHING is appended to the caller's last line: the command sits in a brace
  // group whose closing brace opens a line of its own, so a command ending in a
  // newline, an `&`, a comment or a heredoc terminator still composes (the
  // shell semantics are run for real in the commands suite, [4l] and [4m]).
  assert(
    wrapped.startsWith("{ :\necho hi\n\n};"),
    `the caller's command runs inside a guarded brace group (got ${JSON.stringify(wrapped)})`,
  );
  assert(
    wrapped.includes(`printf '%s' '${TOKEN}'`) && !wrapped.includes(">&2"),
    "the token is printed to STDOUT only, with no newline of its own",
  );
  // An `exit` evaluated by the session shell ends the session, and Daytona
  // then never records the command as finished — the subshell sets $? for the
  // record without touching the shell that has to keep reading.
  assert(wrapped.includes("__evolve_eos=$?"), "the command's status is captured before the token");
  assert(
    wrapped.trimEnd().endsWith("(exit $__evolve_eos)") && !/(^|[^(])exit \$__evolve_eos/.test(wrapped),
    `the status is restored in a SUBSHELL, never with a bare exit (got ${wrapped})`,
  );
  assert(
    _testWithEndOfOutputSentinel("   ", TOKEN) === "   ",
    "an empty command gets no sentinel — there is no output to bound",
  );
}

function testSentinelStripping(): void {
  console.log("\n[1g] A settled stream sheds the sentinel and the terminator after it");

  assert(
    _testStripEndOfOutputSentinel(`PM-PROBE-DAYTONA-BYTES-OK${TOKEN}\n`, TOKEN) ===
      "PM-PROBE-DAYTONA-BYTES-OK",
    "a command that printed no newline gets none back",
  );
  assert(
    _testStripEndOfOutputSentinel(`PM-PROBE-DAYTONA-BYTES-OK\n${TOKEN}\n`, TOKEN) ===
      "PM-PROBE-DAYTONA-BYTES-OK\n",
    "a command that printed one keeps exactly one",
  );
  assert(_testStripEndOfOutputSentinel(`${TOKEN}\n`, TOKEN) === "", "a silent command stays silent");
  assert(
    _testStripEndOfOutputSentinel(`out${TOKEN}`, TOKEN) === "out",
    "a build that returns the token unterminated sheds it too",
  );
  // `ps` prints this very command line, sentinel and all — and there the token
  // is followed by the rest of the line, never by its end.
  const psLike = `root 42 sh -c cmd; printf '%s' '${TOKEN}'\n`;
  assert(
    _testStripEndOfOutputSentinel(psLike, TOKEN) === psLike,
    "a token the caller printed is left alone",
  );
  // An unframed log hands both streams back as one. There is still exactly one
  // sentinel in it — the command prints only stdout's — and it is still at the
  // end, because it is the last thing the command writes.
  assert(
    _testStripEndOfOutputSentinel(`ERRX\nOUTX${TOKEN}\n`, TOKEN) === "ERRX\nOUTX",
    "a merged, unframed log sheds its one sentinel and keeps the rest",
  );
  // THE BYTES THAT MUST SURVIVE: a command that prints this run's own token
  // mid-stream — `sh -x` traces the very printf that writes it — keeps them.
  const traced = `+ printf %s ${TOKEN}\nreal output\n`;
  assert(
    _testStripEndOfOutputSentinel(traced, TOKEN) === traced,
    "a token ending a line in the MIDDLE of the output is never deleted",
  );
  assert(
    _testStripEndOfOutputSentinel("plain output\n", TOKEN) === "plain output\n",
    "output with no sentinel at all is untouched",
  );
  // stderr is never shed at all — the command prints no sentinel to it — so a
  // stderr stream that ENDS with the token (`sh -x` tracing the printf that
  // writes it) keeps those bytes. settledStreams is what enforces that.
  const tracedStderr = `+ printf %s ${TOKEN}\n`;
  assert(
    _testSettledStreams({ stdout: `out${TOKEN}\n`, stderr: tracedStderr }, TOKEN).stderr ===
      tracedStderr,
    "a settled read sheds stdout's sentinel and leaves stderr alone",
  );
  assert(
    _testSettledStreams({ stdout: `out${TOKEN}\n`, stderr: tracedStderr }, TOKEN).stdout === "out",
    "and stdout still sheds its own",
  );
}

function testSentinelFilterOnALiveStream(): void {
  console.log("\n[1h] A stream still arriving sheds the sentinel without holding output back");

  const collect = () => {
    const seen: string[] = [];
    return { seen, filter: _testCreateSentinelFilter(TOKEN, (chunk) => seen.push(chunk)) };
  };

  // No newline of its own: the transport's terminator is all that follows.
  const printf = collect();
  printf.filter.push(`PM-PROBE-DAYTONA-BYTES-OK${TOKEN}\n`);
  printf.filter.flush();
  assert(
    printf.seen.join("") === "PM-PROBE-DAYTONA-BYTES-OK",
    `printf round-trips byte-exact (got ${JSON.stringify(printf.seen.join(""))})`,
  );

  // Its own newline: the token arrives as its own line, and the real one stays.
  const echo = collect();
  echo.filter.push("PM-PROBE-DAYTONA-BYTES-OK\n");
  echo.filter.push(`${TOKEN}\n`);
  echo.filter.flush();
  assert(
    echo.seen.join("") === "PM-PROBE-DAYTONA-BYTES-OK\n",
    `echo keeps its single newline (got ${JSON.stringify(echo.seen.join(""))})`,
  );
  assert(
    echo.seen[0] === "PM-PROBE-DAYTONA-BYTES-OK\n",
    "and it was delivered LIVE — a line that cannot be the sentinel is never delayed",
  );

  // The token split one byte at a time is still the token.
  const split = collect();
  split.filter.push("tail");
  for (const char of `${TOKEN}\n`) split.filter.push(char);
  split.filter.flush();
  assert(
    split.seen.join("") === "tail",
    `a sentinel split across chunks is still shed (got ${JSON.stringify(split.seen.join(""))})`,
  );

  // Mid-stream: `ps` output carrying this run's own command line. The token is
  // followed by the rest of the line there, never by its end, which is what
  // separates a printed token from a sentinel.
  const middle = collect();
  middle.filter.push(`before ${TOKEN} after\n`);
  middle.filter.flush();
  assert(
    middle.seen.join("") === `before ${TOKEN} after\n`,
    "a token the caller printed is delivered, not swallowed",
  );

  // An UNFRAMED follow (measured: this daemon build streams both streams as
  // one, markers and all absent) still ends with the one sentinel.
  const unframed = collect();
  unframed.filter.push(`ERRX\nOUTX${TOKEN}\n`);
  unframed.filter.flush();
  assert(
    unframed.seen.join("") === "ERRX\nOUTX",
    `a merged stream sheds its sentinel and keeps the rest (got ${JSON.stringify(unframed.seen.join(""))})`,
  );

  // A token ending a line mid-stream — `sh -x` tracing our own printf — is the
  // caller's bytes, and a live filter that deleted them would corrupt output
  // silently.
  const traced = collect();
  traced.filter.push(`+ printf %s ${TOKEN}\n`);
  traced.filter.push("real output\n");
  traced.filter.flush();
  assert(
    traced.seen.join("") === `+ printf %s ${TOKEN}\nreal output\n`,
    `a mid-stream token line is delivered whole (got ${JSON.stringify(traced.seen.join(""))})`,
  );

  // A stream cut mid-token keeps what arrived rather than losing it.
  const cut = collect();
  cut.filter.push(`kept${TOKEN.slice(0, 6)}`);
  cut.filter.flush();
  assert(
    cut.seen.join("") === `kept${TOKEN.slice(0, 6)}`,
    "a half-arrived token is output, not a sentinel",
  );
}

// =============================================================================
// [2] Streaming follow over HTTP
// =============================================================================

async function testFollowUsesHttpChunks(): Promise<void> {
  console.log("\n[2a] Managed follow reads chunked HTTP, not a websocket");
  const realFetch = globalThis.fetch;
  let seenUrl = "";
  let seenAuth: string | null = null;

  globalThis.fetch = (async (url: unknown, init: unknown) => {
    seenUrl = String(url);
    seenAuth = new Headers((init as RequestInit)?.headers as HeadersInit).get("authorization");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(STDOUT_MARK, "tick 1\n"));
        controller.enqueue(bytes(STDOUT_MARK, "tick 2\n"));
        controller.enqueue(bytes(STDERR_MARK, "warn\n"));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  let out = "";
  let err = "";
  try {
    await _testFollowManagedSessionLogs(
      { toolboxUrl: "https://dash.test/api/managed/daytona/toolbox", apiKey: "sk-evolve" },
      "dtn_1",
      "sess_1",
      "cmd_1",
      (chunk) => (out += chunk),
      (chunk) => (err += chunk),
    );
  } finally {
    globalThis.fetch = realFetch;
  }

  assert(
    seenUrl ===
      "https://dash.test/api/managed/daytona/toolbox/dtn_1/process/session/sess_1/command/cmd_1/logs?follow=true",
    `URL is the Dashboard toolbox route with follow=true (got ${seenUrl})`,
  );
  assert(seenAuth === "Bearer sk-evolve", "the Evolve key travels as the bearer credential");
  assert(out === "tick 1\ntick 2\n", `stdout streamed in order (got ${JSON.stringify(out)})`);
  assert(err === "warn\n", `stderr kept separate (got ${JSON.stringify(err)})`);
}

async function testFollowSurfacesUpstreamFailure(): Promise<void> {
  console.log("\n[2b] A failed follow raises instead of silently ending the stream");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("sandbox not found", { status: 404 })) as typeof fetch;

  let threw = false;
  try {
    await _testFollowManagedSessionLogs(
      { toolboxUrl: "https://dash.test/api/managed/daytona/toolbox", apiKey: "sk-evolve" },
      "dtn_1",
      "sess_1",
      "cmd_1",
      () => {},
      () => {},
    );
  } catch {
    threw = true;
  } finally {
    globalThis.fetch = realFetch;
  }

  assert(threw, "a 404 from the toolbox route is an error, not an empty log");
}

// =============================================================================
// [2x] The streamed run over a managed follow — end to end through run()
// =============================================================================

/** run() with the production clocks shrunk so a test measures shape, not time. */
class FastCommands extends DaytonaCommands {
  protected override streamTimings = {
    pollMinMs: 1,
    pollMaxMs: 2,
    drainMs: 20,
    killGraceMs: 5,
    settleMs: 500,
  };
}

/** The slice of the sandbox a managed streamed run touches. */
function createStreamSandbox(overrides?: {
  settledLogs?:
    | { stdout: string; stderr: string }
    | ((token: string | null) => { stdout: string; stderr: string });
  failSettledLogs?: boolean;
}) {
  const logReads: number[] = [];
  /** What the box was told to run — the per-run sentinel token comes from here. */
  const sent: string[] = [];
  const sandbox = {
    id: "dtn_1",
    process: {
      createSession: async () => {},
      executeSessionCommand: async (_sessionId: string, params: { command: string }) => {
        sent.push(params.command);
        return { cmdId: "cmd_1" };
      },
      getSessionCommand: async () => ({ exitCode: 0 }),
      getSessionCommandLogs: async () => {
        logReads.push(Date.now());
        if (overrides?.failSettledLogs) throw new Error("logs unavailable");
        const settled = overrides?.settledLogs ?? { stdout: "", stderr: "" };
        return typeof settled === "function" ? settled(tokenOf(sent)) : settled;
      },
      deleteSession: async () => {},
    },
  };
  return { sandbox, logReads, sent };
}

/** The end-of-output token this run told the box to print, if it told it anything. */
function tokenOf(sent: string[]): string | null {
  const match = /EVOLVE-EOS-[a-z0-9-]+/.exec(sent[sent.length - 1] ?? "");
  return match ? match[0] : null;
}

/**
 * The log records Daytona's daemon writes for ONE stream, as measured on a
 * live sandbox 2026-08-03: one record per line — `<marker><line>\n` — and a
 * final line the command left unterminated gets terminated anyway.
 *
 * The mock ends here rather than at the fix: hand it no token and it produces
 * exactly what prod produced on 2026-08-02, a 25-byte marker logged as 26.
 */
function logRecords(mark: Uint8Array, output: string, token: string | null): Uint8Array {
  const written = token === null ? output : `${output}${token}`;
  if (written === "") return bytes();
  const lines = written.split("\n");
  const unterminated = lines.pop() ?? "";
  const records = lines.map((line) => bytes(mark, `${line}\n`));
  if (unterminated) records.push(bytes(mark, `${unterminated}\n`));
  return bytes(...records);
}

/** The same records as a settled log READ returns them: demuxed, per stream. */
function loggedStream(output: string, token: string | null): string {
  const written = token === null ? output : `${output}${token}`;
  return written === "" || written.endsWith("\n") ? written : `${written}\n`;
}

/**
 * A managed follow that delivers `record(token)` and then STAYS OPEN — the
 * chunked follow's normal state, and the one where the run's last bytes are
 * still in the demuxer and the sentinel filter when the command's record says
 * the run is over.
 */
function stubFollowOnce(sent: string[], record: (token: string | null) => Uint8Array): () => void {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(record(tokenOf(sent)));
        signal?.addEventListener("abort", () => {
          try {
            controller.error(new DOMException("aborted", "AbortError"));
          } catch {
            /* already errored */
          }
        });
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
  };
}

const BYTE_MARKER = "PM-PROBE-DAYTONA-BYTES-OK";

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function createManagedCommands(sandbox: unknown): DaytonaCommands {
  return new FastCommands(
    sandbox as never,
    undefined,
    { toolboxUrl: "https://dash.test/toolbox", apiKey: "sk-evolve" } as never,
  );
}

/**
 * GRAND-RETEST FINDING: on all seven daytona agent cells a marker ending
 * "-OK" came back ending "-O", exit 0 — silent corruption of the output's
 * final bytes. The demuxer always holds back the last MAX_PREFIX_LEN-1 bytes
 * against a marker split across chunks and emits them only in its flush; the
 * flush runs as the follow winds down, and run() cut `live` BEFORE abandoning
 * the follow — so whenever the chunked follow outlived its command (its
 * normal state: nothing closes it from the far side), the tail was discarded.
 */
async function testStreamedRunIsByteExactWhenFollowOutlivesCommand(): Promise<void> {
  console.log("\n[2c] run() - streamed stdout is byte-exact though the follow never closes");
  const realFetch = globalThis.fetch;
  // A marker with NO trailing newline: the last bytes of real payload are
  // exactly the bytes the demuxer holds back, so any flush loss is visible.
  const payload = "GRAND-RETEST-MARKER-OK";
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    const signal = (init as { signal?: AbortSignal } | undefined)?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(STDOUT_MARK, payload));
        // Never closes — only the caller's abandon ends it.
        signal?.addEventListener("abort", () => {
          try {
            controller.error(new DOMException("aborted", "AbortError"));
          } catch {
            /* already errored */
          }
        });
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  const { sandbox, logReads } = createStreamSandbox();
  const seen: string[] = [];
  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = await createManagedCommands(sandbox).run("echo -n marker", {
      onStdout: (chunk) => seen.push(chunk),
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert(result.exitCode === 0, "the command's record supplies exit 0");
  assert(
    result.stdout === payload,
    `streamed stdout round-trips byte-exact (got ${JSON.stringify(result.stdout)})`,
  );
  assert(
    seen.join("") === payload,
    `the caller's callback saw every byte exactly once (got ${JSON.stringify(seen.join(""))})`,
  );
  assert(logReads.length === 0, "no settled-log fallback was needed — the stream itself was whole");
}

/**
 * The reviewer-flagged fallback: a follow whose SOCKET DIES mid-stream
 * delivered only a prefix. The settled (non-follow) log read is the whole
 * record — the missing suffix is appended and emitted once, never doubling
 * what the caller already saw, and the run does not fail on a stream error
 * the record can make whole.
 */
async function testDeadFollowFallsBackToSettledLog(): Promise<void> {
  console.log("\n[2d] run() - a follow socket that dies falls back to the settled log");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(STDOUT_MARK, "partial-"));
        controller.error(new Error("socket died"));
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  const { sandbox, logReads } = createStreamSandbox({
    settledLogs: { stdout: "partial-then-tail", stderr: "warned" },
  });
  const seenOut: string[] = [];
  const seenErr: string[] = [];
  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = await createManagedCommands(sandbox).run("echo hi", {
      onStdout: (chunk) => seenOut.push(chunk),
      onStderr: (chunk) => seenErr.push(chunk),
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert(result.exitCode === 0, "the run succeeds by its record despite the dead socket");
  assert(
    result.stdout === "partial-then-tail",
    `the settled log completes stdout (got ${JSON.stringify(result.stdout)})`,
  );
  assert(result.stderr === "warned", "and supplies the stderr the follow never reached");
  assert(
    seenOut.join("") === "partial-then-tail",
    `the callback saw prefix + suffix exactly once (got ${JSON.stringify(seenOut.join(""))})`,
  );
  assert(seenErr.join("") === "warned", "stderr reached its own callback");
  assert(logReads.length === 1, "exactly one settled-log read — a fallback, not a second follow");

  // When the settled log cannot be read either, the broken stream is the
  // story: truncated output must never come back as a clean success.
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(STDOUT_MARK, "partial-"));
        controller.error(new Error("socket died"));
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;
  const broken = createStreamSandbox({ failSettledLogs: true });
  let threw = false;
  try {
    await createManagedCommands(broken.sandbox).run("echo hi", { onStdout: () => {} });
  } catch {
    threw = true;
  } finally {
    globalThis.fetch = realFetch;
  }
  assert(threw, "an unrecoverable dead follow raises instead of returning truncated output");
}

/**
 * THE PROD FINDING THIS PINS (probe 2026-08-02, managed daytona sandbox):
 * `commands.run("printf '%s' 'PM-PROBE-DAYTONA-BYTES-OK'")` came back 26 bytes
 * for a 25-byte marker — the log's own line terminator, returned as if the
 * command had printed it. `wc -c` in the box said 25, and e2b returns 25 for
 * the same command.
 */
async function testStreamedRunKeepsAnUnterminatedLineUnterminated(): Promise<void> {
  console.log("\n[2e] run() - a command that printed no trailing newline gets none back");
  const { sandbox, logReads, sent } = createStreamSandbox();
  const restoreFetch = stubFollowOnce(sent, (token) =>
    bytes(
      logRecords(STDOUT_MARK, BYTE_MARKER, token),
      logRecords(STDERR_MARK, "", null),
    ),
  );

  const seen: string[] = [];
  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = await createManagedCommands(sandbox).run(
      `printf '%s' '${BYTE_MARKER}'`,
      { onStdout: (chunk) => seen.push(chunk) },
    );
  } finally {
    restoreFetch();
  }

  assert(result.exitCode === 0, "the command's record supplies exit 0");
  assert(
    result.stdout === BYTE_MARKER && byteLength(result.stdout) === 25,
    `stdout is the 25 bytes the box printed (got ${byteLength(result.stdout)}: ${JSON.stringify(result.stdout)})`,
  );
  assert(
    result.stderr === "",
    `stderr, which carries no sentinel, stays empty (got ${JSON.stringify(result.stderr)})`,
  );
  assert(
    seen.join("") === BYTE_MARKER,
    `the caller's callback saw the same bytes, sentinel and all shed (got ${JSON.stringify(seen.join(""))})`,
  );
  assert(logReads.length === 0, "no settled-log read was needed — the stream itself was whole");
}

/**
 * The other half of the bar, and the one that fails against the tempting
 * fix: strip a trailing newline unconditionally and `echo` loses the newline
 * it really printed. The sentinel is what makes the two cases separable.
 */
async function testStreamedRunKeepsARealTrailingNewline(): Promise<void> {
  console.log("\n[2f] run() - a command that printed a trailing newline keeps exactly one");
  const { sandbox, sent } = createStreamSandbox();
  const restoreFetch = stubFollowOnce(sent, (token) =>
    bytes(
      logRecords(STDOUT_MARK, `${BYTE_MARKER}\n`, token),
      logRecords(STDERR_MARK, "", null),
    ),
  );

  const seen: string[] = [];
  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = await createManagedCommands(sandbox).run(`echo '${BYTE_MARKER}'`, {
      onStdout: (chunk) => seen.push(chunk),
    });
  } finally {
    restoreFetch();
  }

  assert(
    result.stdout === `${BYTE_MARKER}\n` && byteLength(result.stdout) === 26,
    `stdout keeps its single newline (got ${byteLength(result.stdout)}: ${JSON.stringify(result.stdout)})`,
  );
  assert(result.stderr === "", `stderr stays empty (got ${JSON.stringify(result.stderr)})`);
  assert(
    seen.join("") === `${BYTE_MARKER}\n`,
    `the callback saw the newline too (got ${JSON.stringify(seen.join(""))})`,
  );
}

async function testDeadFollowReconcileShedsTheSentinel(): Promise<void> {
  console.log("\n[2g] run() - the settled log used to repair a dead follow sheds its sentinel too");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes(STDOUT_MARK, "partial-"));
        controller.error(new Error("socket died"));
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  const { sandbox } = createStreamSandbox({
    settledLogs: (token) => ({
      stdout: loggedStream("partial-then-tail", token),
      stderr: loggedStream("warned\n", null),
    }),
  });
  const seenOut: string[] = [];
  const seenErr: string[] = [];
  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = await createManagedCommands(sandbox).run("echo hi", {
      onStdout: (chunk) => seenOut.push(chunk),
      onStderr: (chunk) => seenErr.push(chunk),
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert(
    result.stdout === "partial-then-tail",
    `the repaired stdout carries no sentinel (got ${JSON.stringify(result.stdout)})`,
  );
  assert(
    result.stderr === "warned\n",
    `and stderr keeps its own newline (got ${JSON.stringify(result.stderr)})`,
  );
  assert(
    seenOut.join("") === "partial-then-tail",
    `the callback saw prefix + suffix exactly once, sentinel shed (got ${JSON.stringify(seenOut.join(""))})`,
  );
  assert(seenErr.join("") === "warned\n", "stderr reached its own callback intact");
}

async function testFollowCutMidSentinelLeaksNothing(): Promise<void> {
  console.log("\n[2h] run() - a follow cut in the MIDDLE of the sentinel leaks no fragment");
  const { sandbox, sent } = createStreamSandbox({
    settledLogs: (token) => ({ stdout: loggedStream("abc", token), stderr: loggedStream("", null) }),
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Four bytes into the token, the socket dies. Those bytes could be the
        // start of the sentinel or the caller's own output; only the settled
        // log knows, so nothing may be handed to the caller on a guess.
        controller.enqueue(bytes(STDOUT_MARK, `abc${tokenOf(sent)!.slice(0, 4)}`));
        controller.error(new Error("socket died"));
      },
    });
    return new Response(stream, { status: 200 });
  }) as typeof fetch;

  const seen: string[] = [];
  let result: { exitCode: number; stdout: string; stderr: string };
  try {
    result = await createManagedCommands(sandbox).run("printf '%s' abc", {
      onStdout: (chunk) => seen.push(chunk),
    });
  } finally {
    globalThis.fetch = realFetch;
  }

  assert(result.stdout === "abc", `stdout is the command's own bytes (got ${JSON.stringify(result.stdout)})`);
  assert(
    seen.join("") === "abc",
    `and the callback saw no token fragment (got ${JSON.stringify(seen.join(""))})`,
  );
}

// =============================================================================
// [3] Managed provider wiring
// =============================================================================

async function testManagedProviderAnswersDiscoveryLocally(): Promise<void> {
  console.log("\n[3a] Managed mode answers toolbox discovery without calling Daytona");
  const provider = createDaytonaProvider({
    apiKey: "sk-evolve",
    apiUrl: "https://dash.test/api/managed/daytona",
    managedToolboxUrl: "https://dash.test/api/managed/daytona/toolbox",
  });

  // Since @daytonaio/sdk 0.203.0 the discovery is sandboxApi.getToolboxProxyUrl
  // (the old Daytona.getProxyToolboxUrl seam is gone), and the managed wrap
  // answers it locally with the Dashboard route.
  const client = (provider as unknown as {
    client: { sandboxApi: { getToolboxProxyUrl: (id: string) => Promise<{ data: { url: string } }> } };
  }).client;
  const response = await client.sandboxApi.getToolboxProxyUrl("dtn_1");

  assert(
    response.data.url === "https://dash.test/api/managed/daytona/toolbox",
    `discovery returns the Dashboard route (got ${response.data.url})`,
  );
}

async function testManagedProviderRewritesDtoToolboxUrls(): Promise<void> {
  console.log("\n[3a2] Managed mode rewrites toolboxProxyUrl in every control-plane DTO");

  // The runner base is DATA now: processSandboxDto re-derives the toolbox base
  // from every DTO's toolboxProxyUrl on every refresh, so a single DTO
  // carrying Daytona's real runner URL would point the client at a host the
  // managed caller holds no credential for. The wrap must scrub singles and
  // list responses alike — through methods it has never heard of, because the
  // api client is generated code that grows methods every release.
  const provider = createDaytonaProvider({
    apiKey: "sk-evolve",
    apiUrl: "https://dash.test/api/managed/daytona",
    managedToolboxUrl: "https://dash.test/api/managed/daytona/toolbox",
  });
  const client = (provider as unknown as { client: { sandboxApi: object } }).client;
  const api = client.sandboxApi as {
    getSandbox?: unknown;
    someFutureMethod?: (...args: unknown[]) => Promise<unknown>;
  };
  // Stand in for ANY generated api method returning DTOs.
  const raw = {
    async single() {
      return { data: { id: "dtn_1", toolboxProxyUrl: "https://runner.daytona.io/proxy" } };
    },
    async page() {
      return {
        data: {
          items: [
            { id: "dtn_1", toolboxProxyUrl: "https://runner.daytona.io/proxy" },
            { id: "dtn_2", toolboxProxyUrl: "https://other-runner.daytona.io/proxy" },
          ],
          nextCursor: "abc",
        },
      };
    },
  };
  Object.assign(api, { single: raw.single, page: raw.page });
  const wrapped = api as unknown as {
    single: () => Promise<{ data: { toolboxProxyUrl: string } }>;
    page: () => Promise<{ data: { items: Array<{ toolboxProxyUrl: string }>; nextCursor: string } }>;
  };

  const single = await wrapped.single();
  assert(
    single.data.toolboxProxyUrl === "https://dash.test/api/managed/daytona/toolbox",
    "a single-sandbox DTO comes back pointing at the Dashboard route",
  );

  const page = await wrapped.page();
  assert(
    page.data.items.every(
      (item) => item.toolboxProxyUrl === "https://dash.test/api/managed/daytona/toolbox",
    ),
    "every row of a list response is rewritten too",
  );
  assert(page.data.nextCursor === "abc", "and nothing else in the response is touched");
}

function testDirectProviderStillDiscoversUpstream(): void {
  console.log("\n[3b] Direct mode is untouched — no managed override");
  const provider = createDaytonaProvider({ apiKey: "dtn-real-key" });
  const client = (provider as unknown as { client: object }).client;

  assert(
    client.constructor.name === "Daytona",
    `direct mode builds a plain Daytona client (got ${client.constructor.name})`,
  );
}

async function testManagedCreateRefusesResources(): Promise<void> {
  console.log("\n[3c] Managed create refuses sizing it cannot enforce, before any API call");
  const provider = createDaytonaProvider({
    apiKey: "sk-evolve",
    apiUrl: "https://dash.test/api/managed/daytona",
    managedToolboxUrl: "https://dash.test/api/managed/daytona/toolbox",
  });

  let error: unknown;
  try {
    await provider.create({ image: "evolve-all", resources: { cpu: 8 } });
  } catch (err) {
    error = err;
  }

  assert(
    error instanceof DaytonaResourcesError,
    `sizing against a platform snapshot is refused (got ${(error as Error)?.name})`,
  );
}

async function testManagedCreateNamesThePlatformSnapshot(): Promise<void> {
  console.log("\n[3d] Managed create defaults to the PLATFORM's stable snapshot name");
  // Managed mode never builds: the platform owns which release backs
  // "evolve-all" and its warm keeper keeps that exact name active, so the
  // derived evolve-all-c-<12hex> default is DIRECT mode's alone.
  const provider = createDaytonaProvider({
    apiKey: "sk-evolve",
    apiUrl: "https://dash.test/api/managed/daytona",
    managedToolboxUrl: "https://dash.test/api/managed/daytona/toolbox",
  });
  const created: Array<{ snapshot?: string }> = [];
  (provider as unknown as { client: unknown }).client = {
    create: async (params: { snapshot?: string }) => {
      created.push(params);
      return { id: "dtn_1" };
    },
  };

  await provider.create({});

  assert(
    created[0]?.snapshot === "evolve-all",
    `a managed create with no image names the platform snapshot (got ${created[0]?.snapshot})`,
  );
}

const tests = [
  testDemuxSplitsStreams,
  testDemuxHandlesMarkerAcrossChunks,
  testDemuxHandlesSplitUtf8,
  testDemuxKeepsUnframedBytes,
  testReadCommandStreams,
  testSentinelCommandShape,
  testSentinelStripping,
  testSentinelFilterOnALiveStream,
  testFollowUsesHttpChunks,
  testFollowSurfacesUpstreamFailure,
  testStreamedRunIsByteExactWhenFollowOutlivesCommand,
  testDeadFollowFallsBackToSettledLog,
  testStreamedRunKeepsAnUnterminatedLineUnterminated,
  testStreamedRunKeepsARealTrailingNewline,
  testDeadFollowReconcileShedsTheSentinel,
  testFollowCutMidSentinelLeaksNothing,
  testManagedProviderAnswersDiscoveryLocally,
  testManagedProviderRewritesDtoToolboxUrls,
  testDirectProviderStillDiscoversUpstream,
  testManagedCreateRefusesResources,
  testManagedCreateNamesThePlatformSnapshot,
];

(async () => {
  console.log("=== Daytona Evolve-managed mode: toolbox discovery + HTTP log follow ===");
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
