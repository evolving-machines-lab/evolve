#!/usr/bin/env tsx
/**
 * Unit Test: Managed Modal transport — the door's HTTP client
 *
 * Every assertion here is a wire-shape assertion, because the Dashboard's
 * twin routes are built against exactly this contract:
 *   - control plane: the door's five JSON operations
 *     (create/list/get/kill/exec)
 *   - file plane: E2B's envd file surface verbatim (GET/POST /files,
 *     multipart field "file", batch filenames = destination paths,
 *     filesystem.Filesystem/MakeDir)
 *   - provider law: options the door cannot carry are refused before any
 *     request, never silently dropped
 *
 * Usage:
 *   npx tsx tests/unit/managed-modal.test.ts
 */

import { ManagedModalProvider, _testManagedModalSandbox } from "../../src/utils/managed-modal";
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

// =============================================================================
// [3] File plane — the envd wire shapes, verbatim
// =============================================================================

async function testFileWriteWire(): Promise<void> {
  console.log("\n[3a] files.write() - POST /files?path=<dest>, multipart, one part named 'file'");

  const { requests, restore } = withMockDoor(() => json([{ name: "a.txt", type: "file", path: "/workspace/a.txt" }]));
  try {
    const sandbox = sandboxUnderTest();
    await sandbox.files.write("/workspace/a.txt", "hello");

    const write = requests[requests.length - 1];
    assertEqual(
      write.url,
      `${BASE}/sandboxes/modal-sb-1/files?path=${encodeURIComponent("/workspace/a.txt")}`,
      "the destination rides the path query, envd-style"
    );
    assertEqual(write.method, "POST", "write is a POST");
    assert(write.body instanceof FormData, "the body is multipart form data");
    const part = (write.body as FormData).get("file");
    assert(part instanceof Blob, "the payload is one part under the field name 'file'");
    assertEqual(await (part as Blob).text(), "hello", "the part body carries the file bytes");
  } finally {
    restore();
  }
}

async function testFileWriteBatchWire(): Promise<void> {
  console.log("\n[3b] files.writeBatch() - POST /files, one part per file, FILENAME = destination path");

  const { requests, restore } = withMockDoor(() => json([]));
  try {
    const sandbox = sandboxUnderTest();
    await sandbox.files.writeBatch([
      { path: "/workspace/a.txt", data: "aaa" },
      { path: "/workspace/nested/b.bin", data: new Uint8Array([1, 2, 3]) },
    ]);

    const write = requests[requests.length - 1];
    assertEqual(write.url, `${BASE}/sandboxes/modal-sb-1/files`, "batch writes carry NO path query");
    const parts = (write.body as FormData).getAll("file") as File[];
    assertEqual(parts.length, 2, "one multipart part per file");
    assertEqual(
      parts.map((part) => part.name),
      ["/workspace/a.txt", "/workspace/nested/b.bin"],
      "each part's filename is its absolute destination path"
    );
    assertEqual(await parts[0].text(), "aaa", "text bytes survive");
    assertEqual(
      Array.from(new Uint8Array(await parts[1].arrayBuffer())),
      [1, 2, 3],
      "binary bytes survive"
    );
  } finally {
    restore();
  }
}

async function testFileWriteBatchEmptyIsFree(): Promise<void> {
  console.log("\n[3c] files.writeBatch([]) - a no-op, no request");

  const { requests, restore } = withMockDoor(() => json([]));
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
  console.log("\n[3d] files.read() - GET /files?path=<src>, raw bytes back; text/binary by extension");

  const { requests, restore } = withMockDoor((request) =>
    request.url.includes(".png")
      ? new Response(new Uint8Array([137, 80]).buffer, { status: 200 })
      : new Response("file text", { status: 200 }),
  );
  try {
    const sandbox = sandboxUnderTest();

    const text = await sandbox.files.read("/workspace/notes.md");
    assertEqual(text, "file text", "a text extension reads back as a string");
    assertEqual(
      requests[requests.length - 1].url,
      `${BASE}/sandboxes/modal-sb-1/files?path=${encodeURIComponent("/workspace/notes.md")}`,
      "read hits GET /files with the encoded path"
    );
    assertEqual(requests[requests.length - 1].method, "GET", "read is a GET");

    const bytes = await sandbox.files.read("/workspace/logo.png");
    assert(bytes instanceof Uint8Array, "a binary extension reads back as Uint8Array");
    assertEqual(Array.from(bytes as Uint8Array), [137, 80], "the raw bytes are untouched");
  } finally {
    restore();
  }
}

async function testMakeDirWire(): Promise<void> {
  console.log("\n[3e] files.makeDir() - POST /filesystem.Filesystem/MakeDir with {path}");

  const { requests, restore } = withMockDoor(() => json({}));
  try {
    const sandbox = sandboxUnderTest();
    await sandbox.files.makeDir("/workspace/out");

    const call = requests[requests.length - 1];
    assertEqual(
      call.url,
      `${BASE}/sandboxes/modal-sb-1/filesystem.Filesystem/MakeDir`,
      "makeDir rides the envd RPC path"
    );
    assertEqual(JSON.parse(String(call.body)), { path: "/workspace/out" }, "the body is {path}");
    assertEqual(call.headers["content-type"], "application/json", "makeDir is a JSON call");
  } finally {
    restore();
  }
}

// =============================================================================
// [4] Commands — exec, spawn, list, kill
// =============================================================================

async function testRunWire(): Promise<void> {
  console.log("\n[4a] commands.run() - POST /exec with the door's body; buffered callbacks fire once");

  const { requests, restore } = withMockDoor(() =>
    json({ exitCode: 0, stdout: "out!", stderr: "err!" }),
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
    assertEqual(result, { exitCode: 0, stdout: "out!", stderr: "err!" }, "the result maps 1:1");
    assertEqual(stdout, ["out!"], "onStdout fires once, with the whole output (buffered exec)");
    assertEqual(stderr, ["err!"], "onStderr fires once, with the whole output");
  } finally {
    restore();
  }
}

async function testSpawnIsTheSameExec(): Promise<void> {
  console.log("\n[4b] commands.spawn() - the exec fired immediately; wait() is the HTTP completion");

  const { requests, restore } = withMockDoor(() => json({ exitCode: 7, stdout: "done", stderr: "" }));
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
  console.log("\n[4c] commands.list()/kill() - ride the exec operation with the direct provider's commands");

  const { requests, restore } = withMockDoor((request) => {
    const body = JSON.parse(String(request.body)) as { command: string };
    if (body.command.startsWith("ps"))
      return json({ exitCode: 0, stdout: "PID COMMAND ARGS\n42 node server.js\n", stderr: "" });
    return json({ exitCode: 0, stdout: "", stderr: "" });
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
  testFileWriteWire,
  testFileWriteBatchWire,
  testFileWriteBatchEmptyIsFree,
  testFileReadWire,
  testMakeDirWire,
  testRunWire,
  testSpawnIsTheSameExec,
  testProcessListAndKill,
  testSandboxKillWire,
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
