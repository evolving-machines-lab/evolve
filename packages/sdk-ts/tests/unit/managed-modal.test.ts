#!/usr/bin/env tsx
/**
 * Unit Test: Managed Modal transport — the door's HTTP client
 *
 * Every assertion here is a wire-shape assertion, because the Dashboard's
 * door rules this wire and the transport follows it:
 *   - control plane: the door's JSON operations (create/list/get/kill) plus
 *     exec as an NDJSON stream — chunk records as the command produces them,
 *     one terminal record carrying the exit code (or the upstream error)
 *   - file plane: POST-only /files/{read|write|writeBatch|makeDir}, path in
 *     the JSON body, base64 as the binary carrier, and the door's 1 MiB
 *     write bound refused with a typed error BEFORE anything is sent
 *   - provider law: options the door cannot carry are refused before any
 *     request, never silently dropped
 *
 * Usage:
 *   npx tsx tests/unit/managed-modal.test.ts
 */

import {
  ManagedModalProvider,
  ManagedModalWriteLimitError,
  _testManagedModalSandbox,
} from "../../src/utils/managed-modal";
import { isEvolveManagedSandboxProvider, resolveManagedSandbox } from "../../src/utils/sandbox";
import { getManagedProviderUrl } from "../../src/constants";

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
  const e = JSON.stringify(expected);
  if (a === e) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message} (expected ${e}, got ${a})`);
  }
}

const BASE = "https://dashboard.test/api/managed/modal";

interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: BodyInit | null;
}

/**
 * Route the transport's fetch calls to a scripted responder, recording every
 * request. Responses are real Response objects so the transport's parsing is
 * exercised for real.
 */
function withMockDoor(
  respond: (request: RecordedRequest) => Response | Promise<Response>,
): { requests: RecordedRequest[]; restore: () => void } {
  const requests: RecordedRequest[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: RecordedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
      body: init?.body,
    };
    requests.push(request);
    return respond(request);
  }) as typeof fetch;
  return { requests, restore: () => (globalThis.fetch = original) };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A complete exec answer as the door streams it: chunk records, then the terminal. */
function ndjson(records: unknown[]): Response {
  return new Response(records.map((record) => JSON.stringify(record) + "\n").join(""), {
    status: 200,
    headers: { "content-type": "application/x-ndjson" },
  });
}

function provider(): ManagedModalProvider {
  return new ManagedModalProvider({ apiKey: "sk-evolve-key", baseUrl: BASE });
}

/** An instance without the connect round trip — its ctor makes no HTTP call. */
function sandboxUnderTest() {
  return _testManagedModalSandbox({ apiKey: "sk-evolve-key", baseUrl: BASE }, "modal-sb-1");
}

// =============================================================================
// [1] Resolution
// =============================================================================

async function testResolution(): Promise<void> {
  console.log("\n[1] resolveManagedSandbox('modal') - a real provider, marked managed");

  const resolved = await resolveManagedSandbox("sk-evolve-key", "modal");
  assertEqual(resolved.providerType, "modal", "providerType is modal");
  assert(resolved instanceof ManagedModalProvider, "resolution returns the door client");
  assert(isEvolveManagedSandboxProvider(resolved), "the provider is marked Evolve-managed");
  assert(
    getManagedProviderUrl("modal").endsWith("/api/managed/modal"),
    "the door URL is the managed modal route"
  );
}

// =============================================================================
// [2] Create — wire shape and provider-law refusals
// =============================================================================

async function testCreateWire(): Promise<void> {
  console.log("\n[2a] create() - POST /sandboxes with the door's JSON body and bearer key");

  const { requests, restore } = withMockDoor(() =>
    json({ sandboxId: "modal-sb-1", image: "evolve-all", metadata: {}, startedAt: "t0" }, 201),
  );
  try {
    const sandbox = await provider().create({
      image: "evolve-all",
      timeoutMs: 60_000,
      workingDirectory: "/workspace",
      envs: { FOO: "bar" },
      metadata: { runId: "r1" },
    });
    assertEqual(sandbox.sandboxId, "modal-sb-1", "the instance carries the door's sandbox id");
    assertEqual(requests[0].url, `${BASE}/sandboxes`, "create hits the sandboxes collection");
    assertEqual(requests[0].method, "POST", "create is a POST");
    assertEqual(
      requests[0].headers["authorization"],
      "Bearer sk-evolve-key",
      "the Evolve key rides Authorization: Bearer"
    );
    assertEqual(
      JSON.parse(String(requests[0].body)),
      {
        image: "evolve-all",
        timeoutMs: 60_000,
        workingDirectory: "/workspace",
        envs: { FOO: "bar" },
        metadata: { runId: "r1" },
      },
      "the body is exactly the door's create vocabulary"
    );
  } finally {
    restore();
  }
}

async function testCreateOmitsUnsetFields(): Promise<void> {
  console.log("\n[2b] create() - unset options are ABSENT from the body, not null placeholders");

  const { requests, restore } = withMockDoor(() => json({ sandboxId: "modal-sb-2" }, 201));
  try {
    await provider().create({});
    assertEqual(JSON.parse(String(requests[0].body)), {}, "an empty create sends an empty object");
  } finally {
    restore();
  }
}

async function testCreateRefusesWhatTheDoorCannotCarry(): Promise<void> {
  console.log("\n[2c] create() - resources/network/user/idleTimeoutMs refused before any request");

  const cases: Array<[string, Parameters<ManagedModalProvider["create"]>[0]]> = [
    ["resources", { resources: { cpu: 2 } }],
    ["network", { network: { outbound: "blocked" } }],
    ["user", { user: "root" }],
    ["idleTimeoutMs", { idleTimeoutMs: 60_000 }],
  ];
  for (const [name, options] of cases) {
    const { requests, restore } = withMockDoor(() => json({ sandboxId: "never" }, 201));
    try {
      let message = "";
      try {
        await provider().create(options);
      } catch (err) {
        message = (err as Error).message;
      }
      assert(
        message.includes("managed door") || message.includes("timeoutMs"),
        `${name} is refused with a reason`
      );
      assertEqual(requests.length, 0, `${name} refusal fires before any HTTP request`);
    } finally {
      restore();
    }
  }
}

async function testManagedCreateDefaults(): Promise<void> {
  console.log("\n[2d] managedSandbox options - create defaults fold under every create, per-create wins");

  const managed = await resolveManagedSandbox("sk-evolve-key", "modal", { timeoutMs: 120_000 });
  const { requests, restore } = withMockDoor(() =>
    json({ sandboxId: "modal-sb-1", image: "evolve-all", metadata: {}, startedAt: "t0" }, 201),
  );
  try {
    await managed.create({});
    assertEqual(
      (JSON.parse(String(requests[0].body)) as { timeoutMs?: number }).timeoutMs,
      120_000,
      "a create without its own timeoutMs carries the managed default"
    );
    await managed.create({ timeoutMs: 45_000 });
    assertEqual(
      (JSON.parse(String(requests[1].body)) as { timeoutMs?: number }).timeoutMs,
      45_000,
      "a per-create timeoutMs beats the managed default"
    );
  } finally {
    restore();
  }

  // The defaults ride the SAME validated path as caller options: a default the
  // door cannot enforce is refused at create, never silently dropped.
  const sized = await resolveManagedSandbox("sk-evolve-key", "modal", { resources: { cpu: 2 } });
  const { requests: refused, restore: restoreRefused } = withMockDoor(() =>
    json({ sandboxId: "never" }, 201),
  );
  try {
    let message = "";
    try {
      await sized.create({});
    } catch (err) {
      message = (err as Error).message;
    }
    assert(message.includes("managed door"), "a resources default is refused with the door's reason");
    assertEqual(refused.length, 0, "the refusal fires before any HTTP request");
  } finally {
    restoreRefused();
  }
}

// =============================================================================
// [3] File plane — the door's JSON quartet, verbatim
// =============================================================================

async function testFileWriteWire(): Promise<void> {
  console.log("\n[3a] files.write() - POST /files/write, path in the body, utf8 rides as-is");

  const { requests, restore } = withMockDoor(() => new Response(null, { status: 204 }));
  try {
    const sandbox = sandboxUnderTest();
    await sandbox.files.write("/workspace/a.txt", "hello");

    const write = requests[requests.length - 1];
    assertEqual(
      write.url,
      `${BASE}/sandboxes/modal-sb-1/files/write`,
      "write rides the door's files/write operation — no path in the URL"
    );
    assertEqual(write.method, "POST", "write is a POST");
    assertEqual(write.headers["content-type"], "application/json", "write is a JSON call");
    assertEqual(
      JSON.parse(String(write.body)),
      { path: "/workspace/a.txt", content: "hello" },
      "a string writes as {path, content} with the door's utf8 default"
    );
  } finally {
    restore();
  }
}

async function testFileWriteBinaryRidesBase64(): Promise<void> {
  console.log("\n[3b] files.write() - bytes ride base64, non-UTF8 bytes survive exactly");

  const { requests, restore } = withMockDoor(() => new Response(null, { status: 204 }));
  try {
    const sandbox = sandboxUnderTest();
    // 0xff/0xfe are invalid UTF-8 lead bytes: any utf8 round trip would mangle
    // them, so this payload proves base64 is really the carrier.
    const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x89, 0x50]);
    await sandbox.files.write("/workspace/blob.bin", bytes);

    const body = JSON.parse(String(requests[requests.length - 1].body)) as {
      path: string;
      content: string;
      encoding: string;
    };
    assertEqual(body.path, "/workspace/blob.bin", "the destination rides the body");
    assertEqual(body.encoding, "base64", "bytes declare the base64 carrier");
    assertEqual(
      Array.from(Buffer.from(body.content, "base64")),
      [0xff, 0xfe, 0x00, 0x89, 0x50],
      "the base64 decodes back to the exact input bytes"
    );
  } finally {
    restore();
  }
}

async function testFileWriteBatchWire(): Promise<void> {
  console.log("\n[3c] files.writeBatch() - POST /files/writeBatch, one JSON body, per-entry encoding");

  const { requests, restore } = withMockDoor(() => new Response(null, { status: 204 }));
  try {
    const sandbox = sandboxUnderTest();
    await sandbox.files.writeBatch([
      { path: "/workspace/a.txt", data: "aaa" },
      { path: "/workspace/nested/b.bin", data: new Uint8Array([1, 2, 254]) },
    ]);

    const write = requests[requests.length - 1];
    assertEqual(write.url, `${BASE}/sandboxes/modal-sb-1/files/writeBatch`, "batch rides files/writeBatch");
    const body = JSON.parse(String(write.body)) as {
      files: Array<{ path: string; content: string; encoding?: string }>;
    };
    assertEqual(body.files.length, 2, "one wire entry per file");
    assertEqual(
      body.files[0],
      { path: "/workspace/a.txt", content: "aaa" },
      "text entries carry utf8 content with no encoding marker"
    );
    assertEqual(body.files[1].encoding, "base64", "binary entries declare base64");
    assertEqual(
      Array.from(Buffer.from(body.files[1].content, "base64")),
      [1, 2, 254],
      "binary bytes survive the batch entry exactly"
    );
  } finally {
    restore();
  }
}

async function testFileWriteBatchEmptyIsFree(): Promise<void> {
  console.log("\n[3d] files.writeBatch([]) - a no-op, no request");

  const { requests, restore } = withMockDoor(() => new Response(null, { status: 204 }));
  try {
    const sandbox = sandboxUnderTest();
    const before = requests.length;
    await sandbox.files.writeBatch([]);
    assertEqual(requests.length, before, "an empty batch never reaches the door");
  } finally {
    restore();
  }
}

async function testFileReadWire(): Promise<void> {
  console.log("\n[3e] files.read() - POST /files/read; the door's encoding field decides the shape");

  const nonUtf8 = [0x89, 0x50, 0xff, 0x00];
  const { requests, restore } = withMockDoor((request) => {
    const { path } = JSON.parse(String(request.body)) as { path: string };
    // The door, not a client-side extension table, decides the carrier — so
    // this responder answers base64 for a .md path on purpose.
    return path.endsWith(".md")
      ? json({ content: Buffer.from(nonUtf8).toString("base64"), encoding: "base64" })
      : json({ content: "file text", encoding: "utf8" });
  });
  try {
    const sandbox = sandboxUnderTest();

    const text = await sandbox.files.read("/workspace/notes.txt");
    assertEqual(text, "file text", "a utf8 answer reads back as a string");
    const call = requests[requests.length - 1];
    assertEqual(call.url, `${BASE}/sandboxes/modal-sb-1/files/read`, "read rides files/read");
    assertEqual(call.method, "POST", "read is a POST — file paths stay out of URLs and access logs");
    assertEqual(
      JSON.parse(String(call.body)),
      { path: "/workspace/notes.txt" },
      "the path rides the JSON body"
    );

    const bytes = await sandbox.files.read("/workspace/notes.md");
    assert(bytes instanceof Uint8Array, "a base64 answer reads back as Uint8Array, whatever the extension");
    assertEqual(Array.from(bytes as Uint8Array), nonUtf8, "non-UTF8 bytes rebuild exactly");
  } finally {
    restore();
  }
}

async function testMakeDirWire(): Promise<void> {
  console.log("\n[3f] files.makeDir() - POST /files/makeDir with {path}");

  const { requests, restore } = withMockDoor(() => new Response(null, { status: 204 }));
  try {
    const sandbox = sandboxUnderTest();
    await sandbox.files.makeDir("/workspace/out");

    const call = requests[requests.length - 1];
    assertEqual(
      call.url,
      `${BASE}/sandboxes/modal-sb-1/files/makeDir`,
      "makeDir rides the door's files/makeDir operation"
    );
    assertEqual(JSON.parse(String(call.body)), { path: "/workspace/out" }, "the body is {path}");
    assertEqual(call.headers["content-type"], "application/json", "makeDir is a JSON call");
  } finally {
    restore();
  }
}

async function testWriteBoundRefusedBeforeSending(): Promise<void> {
  console.log("\n[3g] files.write()/writeBatch() - the door's 1 MiB bound is a typed pre-send refusal");

  const { requests, restore } = withMockDoor(() => new Response(null, { status: 204 }));
  try {
    const sandbox = sandboxUnderTest();

    let error: unknown;
    try {
      await sandbox.files.write("/workspace/big.txt", "x".repeat(1024 * 1024));
    } catch (err) {
      error = err;
    }
    assert(error instanceof ManagedModalWriteLimitError, "an over-bound write throws the typed error");
    assert(String(error).includes("1 MiB"), "the error names the bound");
    assertEqual(requests.length, 0, "and nothing was sent — the refusal fires before the wire");

    let batchError: unknown;
    try {
      await sandbox.files.writeBatch([
        { path: "/a", data: "x".repeat(600 * 1024) },
        { path: "/b", data: "x".repeat(600 * 1024) },
      ]);
    } catch (err) {
      batchError = err;
    }
    assert(
      batchError instanceof ManagedModalWriteLimitError,
      "a batch whose ONE body breaks the bound is refused the same way"
    );
    assertEqual(requests.length, 0, "the batch refusal also fires before the wire");

    await sandbox.files.write("/workspace/ok.txt", "x".repeat(1024));
    assertEqual(requests.length, 1, "an in-bound write goes through untouched");
  } finally {
    restore();
  }
}

// =============================================================================
// [4] Commands — exec streaming, spawn, list, kill
// =============================================================================

async function testRunWire(): Promise<void> {
  console.log("\n[4a] commands.run() - POST /exec; NDJSON chunks accumulate and fire callbacks in order");

  const { requests, restore } = withMockDoor(() =>
    ndjson([
      { stream: "stdout", data: "out " },
      { stream: "stderr", data: "err!" },
      { stream: "stdout", data: "more" },
      { exitCode: 0 },
    ]),
  );
  try {
    const sandbox = sandboxUnderTest();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await sandbox.commands.run("echo hi", {
      cwd: "/workspace",
      envs: { A: "1" },
      timeoutMs: 30_000,
      onStdout: (chunk) => stdout.push(chunk),
      onStderr: (chunk) => stderr.push(chunk),
    });

    const call = requests[requests.length - 1];
    assertEqual(call.url, `${BASE}/sandboxes/modal-sb-1/exec`, "run hits the exec operation");
    assertEqual(
      JSON.parse(String(call.body)),
      { command: "echo hi", cwd: "/workspace", envs: { A: "1" }, timeoutMs: 30_000 },
      "the exec body carries command + cwd + envs + timeoutMs"
    );
    assertEqual(
      result,
      { exitCode: 0, stdout: "out more", stderr: "err!" },
      "the terminal record carries the exit code; output is the accumulated chunks"
    );
    assertEqual(stdout, ["out ", "more"], "onStdout fires once per chunk, in stream order");
    assertEqual(stderr, ["err!"], "onStderr fires per chunk on its own stream");
  } finally {
    restore();
  }
}

async function testRunStreamsChunkByChunk(): Promise<void> {
  console.log("\n[4b] commands.run() - chunks are delivered as they FLOW, before the command completes");

  let push!: (record: unknown) => void;
  let close!: () => void;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (record) => controller.enqueue(encoder.encode(JSON.stringify(record) + "\n"));
      close = () => controller.close();
    },
  });
  const { restore } = withMockDoor(() => new Response(stream, { status: 200 }));
  try {
    const sandbox = sandboxUnderTest();
    let firstChunkSeen!: () => void;
    const firstChunk = new Promise<void>((resolve) => (firstChunkSeen = resolve));
    let settled = false;

    const pending = sandbox.commands
      .run("long-task", { onStdout: () => firstChunkSeen() })
      .finally(() => (settled = true));

    // The command is still running (no terminal record yet) when the first
    // chunk record lands — the callback must fire NOW, not at completion.
    push({ stream: "stdout", data: "early" });
    await firstChunk;
    assertEqual(settled, false, "the first chunk arrived while run() was still in flight");

    push({ exitCode: 3 });
    close();
    const result = await pending;
    assertEqual(result.exitCode, 3, "the run then settles with the terminal exit code");
    assertEqual(result.stdout, "early", "with the streamed chunk accumulated");
  } finally {
    restore();
  }
}

async function testRunSplitRecordsReassemble(): Promise<void> {
  console.log("\n[4c] commands.run() - a record split across network chunks reassembles exactly");

  const encoder = new TextEncoder();
  const whole = JSON.stringify({ stream: "stdout", data: "split" }) + "\n" + JSON.stringify({ exitCode: 0 }) + "\n";
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      // Cut mid-record: the transport must buffer to the newline, never parse a half line.
      controller.enqueue(encoder.encode(whole.slice(0, 11)));
      controller.enqueue(encoder.encode(whole.slice(11)));
      controller.close();
    },
  });
  const { restore } = withMockDoor(() => new Response(stream, { status: 200 }));
  try {
    const result = await sandboxUnderTest().commands.run("echo split");
    assertEqual(result, { exitCode: 0, stdout: "split", stderr: "" }, "split records parse whole");
  } finally {
    restore();
  }
}

async function testRunTerminalErrorAndTruncation(): Promise<void> {
  console.log("\n[4d] commands.run() - a terminal {error} throws; a stream that dies without one throws");

  const errored = withMockDoor(() =>
    ndjson([{ stream: "stdout", data: "partial" }, { error: "sandbox terminated mid-run" }]),
  );
  try {
    let message = "";
    try {
      await sandboxUnderTest().commands.run("doomed");
    } catch (err) {
      message = (err as Error).message;
    }
    assert(
      message.includes("sandbox terminated mid-run"),
      "an upstream failure after the stream began surfaces with its cause"
    );
  } finally {
    errored.restore();
  }

  const truncated = withMockDoor(() => ndjson([{ stream: "stdout", data: "partial" }]));
  try {
    let message = "";
    try {
      await sandboxUnderTest().commands.run("cut-off");
    } catch (err) {
      message = (err as Error).message;
    }
    assert(
      message.includes("without a terminal record"),
      "a stream that ends with no terminal record is a dead connection, never a completed command"
    );
  } finally {
    truncated.restore();
  }
}

async function testRunOverCeilingRejectionSurfaces(): Promise<void> {
  console.log("\n[4e] commands.run() - the door's timeout-ceiling rejection arrives as a clear error");

  // The door REJECTS a timeoutMs above its 120 min ceiling (provider law:
  // never a silent clamp); the transport's job is to hand the caller that
  // refusal verbatim, bound and all.
  const { restore } = withMockDoor(() =>
    json({ error: "Managed Modal exec timeoutMs must be at most 7200000 ms (120 minutes)" }, 400),
  );
  try {
    let message = "";
    try {
      await sandboxUnderTest().commands.run("sleep 999999", { timeoutMs: 10 * 60 * 60 * 1000 });
    } catch (err) {
      message = (err as Error).message;
    }
    assert(
      message.includes("(400)") && message.includes("7200000"),
      "the rejection surfaces with the door's status and the named bound"
    );
  } finally {
    restore();
  }
}

async function testSpawnIsTheSameExec(): Promise<void> {
  console.log("\n[4f] commands.spawn() - the exec fired immediately; wait() is the stream's completion");

  const { requests, restore } = withMockDoor(() =>
    ndjson([{ stream: "stdout", data: "done" }, { exitCode: 7 }]),
  );
  try {
    const sandbox = sandboxUnderTest();
    const before = requests.length;
    const handle = await sandbox.commands.spawn("long-task");
    assertEqual(requests.length, before + 1, "spawn fires the exec request up front");
    assert(handle.processId.length > 0, "spawn returns a process handle");
    const result = await handle.wait();
    assertEqual(result.exitCode, 7, "wait() resolves with the exec result — honest exit code");
    assertEqual(await handle.kill(), false, "kill-by-handle is honestly unsupported (same as direct Modal)");
  } finally {
    restore();
  }
}

async function testProcessListAndKill(): Promise<void> {
  console.log("\n[4g] commands.list()/kill() - ride the exec operation with the direct provider's commands");

  const { requests, restore } = withMockDoor((request) => {
    const body = JSON.parse(String(request.body)) as { command: string };
    if (body.command.startsWith("ps"))
      return ndjson([
        { stream: "stdout", data: "PID COMMAND ARGS\n42 node server.js\n" },
        { exitCode: 0 },
      ]);
    return ndjson([{ exitCode: 0 }]);
  });
  try {
    const sandbox = sandboxUnderTest();

    const processes = await sandbox.commands.list();
    assertEqual(processes.length, 1, "ps output parses to one process");
    assertEqual(processes[0], { processId: "42", cmd: "node", args: ["server.js"], envs: {} }, "fields map like the direct provider");

    assertEqual(await sandbox.commands.kill("42"), true, "a numeric pid is killed via exec");
    const killCall = JSON.parse(String(requests[requests.length - 1].body)) as { command: string };
    assertEqual(killCall.command, "kill -9 42", "the kill command is the direct provider's");

    const before = requests.length;
    assertEqual(await sandbox.commands.kill("42; rm -rf /"), false, "a non-numeric pid is refused");
    assertEqual(requests.length, before, "and never reaches a shell");
  } finally {
    restore();
  }
}

// =============================================================================
// [5] Lifecycle — kill, connect, list, refusals
// =============================================================================

async function testSandboxKillWire(): Promise<void> {
  console.log("\n[5a] kill() - DELETE /sandboxes/{id}; an already-gone box is a success");

  const gone = withMockDoor(() => json({ error: "Sandbox not found" }, 404));
  try {
    await sandboxUnderTest().kill();
    assert(true, "a 404 on kill is the asked-for outcome, not an error");
  } finally {
    gone.restore();
  }

  const { requests, restore } = withMockDoor(() => new Response(null, { status: 204 }));
  try {
    await sandboxUnderTest().kill();
    const call = requests[requests.length - 1];
    assertEqual(call.method, "DELETE", "kill is a DELETE");
    assertEqual(call.url, `${BASE}/sandboxes/modal-sb-1`, "kill names the sandbox");
  } finally {
    restore();
  }
}

async function testIsRunningFollowsTheDoorsGet(): Promise<void> {
  console.log("\n[5a2] isRunning() - the door's get answers it: 200 = running, the dead 404 = false");

  const alive = withMockDoor(() => json({ sandboxId: "modal-sb-1" }));
  try {
    assertEqual(await sandboxUnderTest().isRunning(), true, "a 200 get is a running sandbox");
  } finally {
    alive.restore();
  }

  // Modal itself keeps describing terminated sandboxes, so the door consults
  // its own ownership record and answers the dead 404 after kill — this is
  // the answer that must flip isRunning to false.
  const dead = withMockDoor(() => json({ error: "Sandbox not found" }, 404));
  try {
    assertEqual(await sandboxUnderTest().isRunning(), false, "the door's 404 flips isRunning to false");
  } finally {
    dead.restore();
  }

  const broken = withMockDoor(() => json({ error: "boom" }, 502));
  try {
    let threw = false;
    try {
      await sandboxUnderTest().isRunning();
    } catch {
      threw = true;
    }
    assert(threw, "a door failure throws — never a fabricated liveness answer");
  } finally {
    broken.restore();
  }
}

async function testConnectChecksExistence(): Promise<void> {
  console.log("\n[5b] connect() - the get operation is the existence check");

  const { requests, restore } = withMockDoor(() =>
    json({ sandboxId: "modal-sb-9", image: "evolve-all", metadata: { a: "b" }, startedAt: "t1" }),
  );
  try {
    const sandbox = await provider().connect("modal-sb-9");
    assertEqual(sandbox.sandboxId, "modal-sb-9", "connect returns the instance");
    assertEqual(requests[0].url, `${BASE}/sandboxes/modal-sb-9`, "connect GETs the sandbox");
    const info = await sandbox.getInfo!();
    assertEqual(info, { sandboxId: "modal-sb-9", image: "evolve-all", metadata: { a: "b" }, startedAt: "t1" }, "getInfo maps the door payload");
  } finally {
    restore();
  }

  const missing = withMockDoor(() => json({ error: "Sandbox not found" }, 404));
  try {
    let message = "";
    try {
      await provider().connect("modal-sb-void");
    } catch (err) {
      message = (err as Error).message;
    }
    assert(
      message.includes("(404)") && message.includes("Sandbox not found"),
      "an unknown id fails at connect with the door's error, not on the first file op"
    );
  } finally {
    missing.restore();
  }
}

async function testProviderListWire(): Promise<void> {
  console.log("\n[5c] list() - GET /sandboxes; metadata/limit client-side; no paused state on Modal");

  const { requests, restore } = withMockDoor(() =>
    json({
      sandboxes: [
        { sandboxId: "sb-a", image: "evolve-all", metadata: { runId: "r1" }, startedAt: "t" },
        { sandboxId: "sb-b", image: "evolve-all", metadata: { runId: "r2" }, startedAt: "t" },
      ],
    }),
  );
  try {
    const all = await provider().list();
    assertEqual(requests[0].url, `${BASE}/sandboxes`, "list GETs the collection");
    assertEqual(all.length, 2, "the door's list maps through");

    const filtered = await provider().list({ metadata: { runId: "r2" } });
    assertEqual(filtered.map((s) => s.sandboxId), ["sb-b"], "metadata filters client-side");

    const limited = await provider().list({ limit: 1 });
    assertEqual(limited.length, 1, "limit bounds the answer");

    const before = requests.length;
    const paused = await provider().list({ state: ["paused"] });
    assertEqual(paused, [], "Modal has no paused state, so the filter matches nothing");
    assertEqual(requests.length, before, "and costs no request");
  } finally {
    restore();
  }
}

async function testListAllHonestCompleteness(): Promise<void> {
  console.log("\n[5c2] listAll() - never throws; a limit or a failed door is an admitted-incomplete fleet");

  const twoBoxes = withMockDoor(() =>
    json({
      sandboxes: [
        { sandboxId: "sb-a", image: "", metadata: {}, startedAt: "" },
        { sandboxId: "sb-b", image: "", metadata: {}, startedAt: "" },
      ],
    }),
  );
  try {
    const whole = await provider().listAll();
    assertEqual(whole.complete, true, "the whole fleet reports complete");
    assertEqual(whole.sandboxes.length, 2, "and carries every sandbox");

    const truncated = await provider().listAll({ limit: 1 });
    assertEqual(truncated.complete, false, "a caller-imposed limit that truncated is NOT complete");
    assertEqual(truncated.sandboxes.length, 1, "partial results are returned, not discarded");
    assert(String(truncated.error).includes("limit"), "the error names the limit");
  } finally {
    twoBoxes.restore();
  }

  const broken = withMockDoor(() => json({ error: "boom" }, 502));
  try {
    const page = await provider().listAll();
    assertEqual(page.complete, false, "a door failure comes back as incomplete, never as a throw");
    assertEqual(page.sandboxes, [], "with nothing invented");
    assert(String(page.error).includes("boom"), "and the cause preserved");
  } finally {
    broken.restore();
  }
}

async function testUnsupportedSurfacesThrow(): Promise<void> {
  console.log("\n[5d] getHost()/pause() - honestly unavailable, never silently degraded");

  const { restore } = withMockDoor(() => json({ sandboxId: "modal-sb-1" }));
  try {
    const sandbox = sandboxUnderTest();
    let hostError = "";
    try {
      await sandbox.getHost(8080);
    } catch (err) {
      hostError = (err as Error).message;
    }
    assert(hostError.includes("no tunnels"), "getHost names the missing capability");

    let pauseError = "";
    try {
      await sandbox.pause();
    } catch (err) {
      pauseError = (err as Error).message;
    }
    assert(pauseError.includes("checkpoints"), "pause points at Evolve checkpoints (direct Modal's answer)");
  } finally {
    restore();
  }
}

async function testDoorErrorsSurface(): Promise<void> {
  console.log("\n[5e] errors - the door's {error} body and status survive into the thrown message");

  const { restore } = withMockDoor(() => json({ error: "Rate limit exceeded" }, 429));
  try {
    let message = "";
    try {
      await provider().create({});
    } catch (err) {
      message = (err as Error).message;
    }
    assert(
      message.includes("(429)") && message.includes("Rate limit exceeded"),
      "status and door error body are both in the message"
    );
  } finally {
    restore();
  }
}

// =============================================================================
// RUNNER
// =============================================================================

const tests = [
  testResolution,
  testCreateWire,
  testCreateOmitsUnsetFields,
  testCreateRefusesWhatTheDoorCannotCarry,
  testManagedCreateDefaults,
  testFileWriteWire,
  testFileWriteBinaryRidesBase64,
  testFileWriteBatchWire,
  testFileWriteBatchEmptyIsFree,
  testFileReadWire,
  testMakeDirWire,
  testWriteBoundRefusedBeforeSending,
  testRunWire,
  testRunStreamsChunkByChunk,
  testRunSplitRecordsReassemble,
  testRunTerminalErrorAndTruncation,
  testRunOverCeilingRejectionSurfaces,
  testSpawnIsTheSameExec,
  testProcessListAndKill,
  testSandboxKillWire,
  testIsRunningFollowsTheDoorsGet,
  testConnectChecksExistence,
  testProviderListWire,
  testListAllHonestCompleteness,
  testUnsupportedSurfacesThrow,
  testDoorErrorsSurface,
];

(async () => {
  console.log("=== Managed Modal Transport Tests ===");
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
