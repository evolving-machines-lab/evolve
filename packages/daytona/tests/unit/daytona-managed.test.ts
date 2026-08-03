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
  _testFollowManagedSessionLogs,
  _testReadCommandStreams,
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
  settledLogs?: { stdout: string; stderr: string };
  failSettledLogs?: boolean;
}) {
  const logReads: number[] = [];
  const sandbox = {
    id: "dtn_1",
    process: {
      createSession: async () => {},
      executeSessionCommand: async () => ({ cmdId: "cmd_1" }),
      getSessionCommand: async () => ({ exitCode: 0 }),
      getSessionCommandLogs: async () => {
        logReads.push(Date.now());
        if (overrides?.failSettledLogs) throw new Error("logs unavailable");
        return overrides?.settledLogs ?? { stdout: "", stderr: "" };
      },
      deleteSession: async () => {},
    },
  };
  return { sandbox, logReads };
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

  const client = (provider as unknown as { client: { getProxyToolboxUrl: (id: string, region: string) => Promise<string> } }).client;
  const url = await client.getProxyToolboxUrl("dtn_1", "us");

  assert(
    url === "https://dash.test/api/managed/daytona/toolbox",
    `discovery returns the Dashboard route (got ${url})`,
  );
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
  testFollowUsesHttpChunks,
  testFollowSurfacesUpstreamFailure,
  testStreamedRunIsByteExactWhenFollowOutlivesCommand,
  testDeadFollowFallsBackToSettledLog,
  testManagedProviderAnswersDiscoveryLocally,
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
