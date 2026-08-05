#!/usr/bin/env tsx
/**
 * Unit Test: Daytona Provider — sudo wrapper, network policy mapping,
 * registry detection, real sandbox info, state mapping, and enforcement wiring
 *
 * Tests:
 *   1. wrapCommand() — user param: root sudo wrapper, non-root passthrough
 *   2. mapNetworkPolicy() — Evolve network policy → Daytona create() params
 *      (IPv4 CIDR pinning, DNS resolution, typed rejections)
 *   3. imageRegistryHost() — private registry detection for DaytonaImagePullError
 *   4. toSandboxInfo() — real API timestamps, no fabrication
 *   5. daytonaStateToEvolveState() — list() state filter mapping
 *   6. DaytonaProvider.create() — offline validation (user accepted, typed
 *      network errors fire before any API call)
 *   7. DaytonaCommands — session exec carries the sudo wrapper / passthrough
 *
 * Usage:
 *   npx tsx tests/unit/daytona-provider.test.ts
 */

import {
  _testActivateSnapshot,
  _testWrapCommand,
  _testMapNetworkPolicy,
  _testImageRegistryHost,
  _testToSandboxInfo,
  _testDaytonaStateToEvolveState,
  DAYTONA_MAX_NETWORK_ALLOWLIST,
  DAYTONA_AUTO_DELETE_GRACE_MINUTES,
  DaytonaNetworkPolicyError,
  DaytonaGpuTypeError,
  DaytonaResourcesError,
  DaytonaIdleTimeoutError,
  DaytonaImagePullError,
  DaytonaSnapshotActivationError,
  DaytonaCommands,
  createDaytonaProvider,
} from "../../src/index.ts";

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

/** Decode the base64 payload of an `echo <b64> | base64 -d | sudo -n bash` wrapper. */
function decodeSudoPayload(wrapped: string): string {
  const match = /^echo (\S+) \| base64 -d \| sudo -n bash$/.exec(wrapped);
  if (!match) return `<unparseable: ${wrapped}>`;
  return Buffer.from(match[1], "base64").toString("utf-8");
}

/**
 * What the box is asked to run: the caller's command, then the end-of-output
 * sentinel every command carries so the log's line terminator can be told from
 * the command's own last byte (see the src header).
 */
function withSentinel(command: string, sentAs: string): string {
  const token = /EVOLVE-EOS-[a-z0-9-]+/.exec(sentAs)?.[0];
  if (!token) throw new Error(`no end-of-output sentinel in: ${sentAs}`);
  return `{ :\n${command}\n\n}; __evolve_eos=$?; printf '%s' '${token}'; (exit $__evolve_eos)`;
}

/** Run fn with console.warn captured (silenced), returning the warnings. */
async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.warn = original;
  }
}

// =============================================================================
// [1] wrapCommand() — user param
// =============================================================================

async function testWrapCommandNoUserPassthrough(): Promise<void> {
  console.log("\n[1a] wrapCommand() - no user / non-root user: no wrapper");

  assertEqual(_testWrapCommand("echo hello"), "echo hello", "No user: command unchanged");
  assertEqual(
    _testWrapCommand("echo hello", undefined, undefined, "daytona"),
    "echo hello",
    "Non-root user: no wrapper (create-time osUser governs execution, not a per-exec switch)"
  );
  assertEqual(
    _testWrapCommand("echo hello", "/workspace", { FOO: "bar" }, "worker"),
    "export FOO='bar'; cd '/workspace' && echo hello",
    "Non-root user: cwd + envs wrapped exactly as before, still no sudo"
  );
}

async function testWrapCommandRootSudoWrapper(): Promise<void> {
  console.log("\n[1b] wrapCommand() - root: sudo -n wrapper with base64 payload");

  const wrapped = _testWrapCommand("echo hello", undefined, undefined, "root");
  assert(wrapped.endsWith("| sudo -n bash"), "Root command pipes through sudo -n bash");
  assertEqual(decodeSudoPayload(wrapped), "echo hello", "Base64 payload decodes to the command");
}

async function testWrapCommandRootCwdEnvs(): Promise<void> {
  console.log("\n[1c] wrapCommand() - root: cwd + envs inlined inside the sudo payload");

  const wrapped = _testWrapCommand("echo $VAR", "/workspace", { VAR: "value" }, "root");
  assertEqual(
    decodeSudoPayload(wrapped),
    "export VAR='value'; cd '/workspace' && echo $VAR",
    "Exports + cd + command survive the sudo boundary inside the payload"
  );
}

async function testWrapCommandRootComplexQuoting(): Promise<void> {
  console.log("\n[1d] wrapCommand() - root: complex command survives base64 round-trip");

  const command = `python -c "print('hello \\"world\\"')" && echo 'done'`;
  assertEqual(
    decodeSudoPayload(_testWrapCommand(command, undefined, undefined, "root")),
    command,
    "Nested quotes preserved exactly through base64"
  );
}

async function testWrapCommandRootEscaping(): Promise<void> {
  console.log("\n[1e] wrapCommand() - root: single-quote escaping in cwd and env values");

  const wrapped = _testWrapCommand("ls", "/home/user/it's a dir", { MSG: "it's fine" }, "root");
  assertEqual(
    decodeSudoPayload(wrapped),
    "export MSG='it'\\''s fine'; cd '/home/user/it'\\''s a dir' && ls",
    "Single quotes escaped with '\\'' pattern in cwd and env values"
  );
}

async function testWrapCommandNonStringEnv(): Promise<void> {
  console.log("\n[1f] wrapCommand() - non-string env values are coerced with String(v) (matches Modal twin)");

  const envs: Record<string, string> = { PORT: "9000" };
  (envs as any).RETRIES = 3; // a number reaching envs via `as any`
  (envs as any).ENABLED = true; // a boolean

  // Before the String(v) coercion this threw "v.replace is not a function".
  const wrapped = _testWrapCommand("env", undefined, envs, "worker");
  assert(wrapped.includes("export PORT='9000'"), "String value passes through");
  assert(wrapped.includes("export RETRIES='3'"), "Number value coerced, does not throw on .replace");
  assert(wrapped.includes("export ENABLED='true'"), "Boolean value coerced");
}

// =============================================================================
// [2] mapNetworkPolicy() — Evolve policy → Daytona create params
// =============================================================================

async function testNetworkNoPolicy(): Promise<void> {
  console.log("\n[2a] mapNetworkPolicy() - no policy / open outbound");

  // The two cases behave identically on the box — Daytona's default is already
  // unrestricted — and must NOT look identical on the wire. A create body with
  // no network fields cannot be told apart from a caller who dropped the
  // policy; networkBlockAll:false records that someone decided.
  assertEqual(await _testMapNetworkPolicy(undefined), {}, "No policy → no Daytona network params");
  assertEqual(
    await _testMapNetworkPolicy({ outbound: "open" }),
    { networkBlockAll: false },
    "Open outbound → an EXPLICIT unblocked policy, so an audit log can tell it from a dropped one",
  );
}

async function testNetworkOpenWithDestinationsThrows(): Promise<void> {
  console.log("\n[2b] mapNetworkPolicy() - open + allowedDestinations is rejected");

  let threw = false;
  try {
    await _testMapNetworkPolicy({ outbound: "open", allowedDestinations: ["api.example.com"] });
  } catch (error) {
    threw = String(error).includes("only valid when outbound is blocked");
  }
  assert(threw, "Throws the same validation error as the E2B provider");
}

async function testNetworkBlockedAll(): Promise<void> {
  console.log("\n[2c] mapNetworkPolicy() - blocked with no allowlist → networkBlockAll");

  assertEqual(
    await _testMapNetworkPolicy({ outbound: "blocked" }),
    { networkBlockAll: true },
    "Blocked outbound maps to networkBlockAll: true"
  );
  assertEqual(
    await _testMapNetworkPolicy({ outbound: "blocked", allowedDestinations: [] }),
    { networkBlockAll: true },
    "Empty allowedDestinations also maps to networkBlockAll: true"
  );
}

async function testNetworkIpv4Allowlist(): Promise<void> {
  console.log("\n[2d] mapNetworkPolicy() - IPv4 IPs and CIDRs → comma-joined networkAllowList");

  assertEqual(
    await _testMapNetworkPolicy({ outbound: "blocked", allowedDestinations: ["10.0.0.0/8", "192.168.1.5"] }),
    { networkBlockAll: false, networkAllowList: "10.0.0.0/8,192.168.1.5/32" },
    "CIDRs pass through; bare IPv4 gets /32; blockAll pinned false so the allowlist takes effect"
  );
}

async function testNetworkHostnamePinning(): Promise<void> {
  console.log("\n[2e] mapNetworkPolicy() - hostnames DNS-pinned to /32s at create time (loudly)");

  const resolved: string[] = [];
  const resolver = async (hostname: string) => {
    resolved.push(hostname);
    return ["1.2.3.4", "5.6.7.8"];
  };

  const { result, warnings } = await captureWarnings(() =>
    _testMapNetworkPolicy(
      { outbound: "blocked", allowedDestinations: ["10.1.2.3", "api.anthropic.com"] },
      resolver
    )
  );

  assertEqual(
    result,
    { networkBlockAll: false, networkAllowList: "10.1.2.3/32,1.2.3.4/32,5.6.7.8/32" },
    "Hostname A records appended as /32 CIDRs after literal IPs"
  );
  assertEqual(resolved, ["api.anthropic.com"], "Only the hostname destination was resolved");
  assert(
    warnings.some((w) => w.includes("api.anthropic.com") && w.includes("BLOCKED")),
    "DNS-rotation caveat is warned loudly at create time"
  );
}

async function testNetworkHostnameDedupe(): Promise<void> {
  console.log("\n[2f] mapNetworkPolicy() - duplicate CIDRs deduped");

  const { result } = await captureWarnings(() =>
    _testMapNetworkPolicy(
      { outbound: "blocked", allowedDestinations: ["1.2.3.4", "example.com"] },
      async () => ["1.2.3.4"]
    )
  );
  assertEqual(
    result,
    { networkBlockAll: false, networkAllowList: "1.2.3.4/32" },
    "Hostname resolving to an already-listed IP produces a single entry"
  );
}

async function testNetworkWildcardThrows(): Promise<void> {
  console.log("\n[2g] mapNetworkPolicy() - wildcard hostnames are typed-rejected, never weakened");

  let error: unknown;
  let resolverCalled = false;
  try {
    await _testMapNetworkPolicy(
      { outbound: "blocked", allowedDestinations: ["*.openai.com"] },
      async () => {
        resolverCalled = true;
        return ["9.9.9.9"];
      }
    );
  } catch (e) {
    error = e;
  }
  assert(error instanceof DaytonaNetworkPolicyError, "Throws DaytonaNetworkPolicyError");
  assertEqual((error as DaytonaNetworkPolicyError).reason, "wildcard-hostname", "reason = wildcard-hostname");
  assertEqual((error as DaytonaNetworkPolicyError).destination, "*.openai.com", "Error carries the destination");
  assert(!resolverCalled, "Rejection happens before any DNS lookup");
}

async function testNetworkIpv6Throws(): Promise<void> {
  console.log("\n[2h] mapNetworkPolicy() - IPv6 destinations are typed-rejected");

  let error: unknown;
  try {
    await _testMapNetworkPolicy({ outbound: "blocked", allowedDestinations: ["2001:db8::1"] });
  } catch (e) {
    error = e;
  }
  assert(error instanceof DaytonaNetworkPolicyError, "Throws DaytonaNetworkPolicyError");
  assertEqual((error as DaytonaNetworkPolicyError).reason, "ipv6-unsupported", "reason = ipv6-unsupported");
  assert(String(error).includes("IPv4"), "Error explains Daytona is IPv4-CIDR-only");
}

async function testNetworkUnresolvableThrows(): Promise<void> {
  console.log("\n[2i] mapNetworkPolicy() - unresolvable hostnames are typed-rejected");

  let error: unknown;
  try {
    await _testMapNetworkPolicy(
      { outbound: "blocked", allowedDestinations: ["nope.invalid"] },
      async () => {
        throw new Error("ENOTFOUND nope.invalid");
      }
    );
  } catch (e) {
    error = e;
  }
  assert(error instanceof DaytonaNetworkPolicyError, "Resolver failure throws DaytonaNetworkPolicyError");
  assertEqual((error as DaytonaNetworkPolicyError).reason, "unresolvable-hostname", "reason = unresolvable-hostname");
  assert(String(error).includes("ENOTFOUND"), "Original DNS error surfaced in the message");

  let emptyError: unknown;
  try {
    await _testMapNetworkPolicy(
      { outbound: "blocked", allowedDestinations: ["empty.example"] },
      async () => []
    );
  } catch (e) {
    emptyError = e;
  }
  assert(
    emptyError instanceof DaytonaNetworkPolicyError &&
      (emptyError as DaytonaNetworkPolicyError).reason === "unresolvable-hostname",
    "Zero A records also throws unresolvable-hostname"
  );
}

async function testNetworkAllowlistLimit(): Promise<void> {
  console.log("\n[2j] mapNetworkPolicy() - max 10 CIDRs enforced with a typed error");

  const tenIps = Array.from({ length: 10 }, (_, i) => `10.0.0.${i + 1}`);
  const ok = await _testMapNetworkPolicy({ outbound: "blocked", allowedDestinations: tenIps });
  assertEqual(
    (ok.networkAllowList ?? "").split(",").length,
    DAYTONA_MAX_NETWORK_ALLOWLIST,
    "Exactly 10 entries are allowed"
  );

  let error: unknown;
  try {
    await _testMapNetworkPolicy({
      outbound: "blocked",
      allowedDestinations: [...tenIps, "10.0.0.11"],
    });
  } catch (e) {
    error = e;
  }
  assert(error instanceof DaytonaNetworkPolicyError, "11 entries throw DaytonaNetworkPolicyError");
  assertEqual((error as DaytonaNetworkPolicyError).reason, "allowlist-too-large", "reason = allowlist-too-large");
}

async function testNetworkPortThrows(): Promise<void> {
  console.log("\n[2k] mapNetworkPolicy() - host:port / ip:port are typed-rejected (not read as IPv6)");

  for (const dest of ["example.com:443", "1.2.3.4:8080"]) {
    let error: unknown;
    let resolverCalled = false;
    try {
      await _testMapNetworkPolicy(
        { outbound: "blocked", allowedDestinations: [dest] },
        async () => {
          resolverCalled = true;
          return ["9.9.9.9"];
        }
      );
    } catch (e) {
      error = e;
    }
    assert(error instanceof DaytonaNetworkPolicyError, `"${dest}" throws DaytonaNetworkPolicyError`);
    assertEqual(
      (error as DaytonaNetworkPolicyError).reason,
      "port-unsupported",
      `"${dest}" reason = port-unsupported (single colon is a port, not IPv6)`
    );
    assert(
      String(error).includes("hosts and IPs only") && String(error).toLowerCase().includes("port"),
      `"${dest}" message says allowlists filter hosts/IPs only and to strip the port`
    );
    assertEqual((error as DaytonaNetworkPolicyError).destination, dest, "Error carries the destination");
    assert(!resolverCalled, `"${dest}" rejected before any DNS lookup`);
  }
}

async function testNetworkTrueIpv6StillThrowsIpv6(): Promise<void> {
  console.log("\n[2l] mapNetworkPolicy() - true IPv6 (>=2 colons) still reports ipv6-unsupported, not port");

  let error: unknown;
  try {
    await _testMapNetworkPolicy({ outbound: "blocked", allowedDestinations: ["2001:db8::1"] });
  } catch (e) {
    error = e;
  }
  assertEqual(
    (error as DaytonaNetworkPolicyError).reason,
    "ipv6-unsupported",
    "Multi-colon IPv6 keeps the ipv6-unsupported reason (not confused with a port)"
  );
}

async function testNetworkInvalidIpv4Throws(): Promise<void> {
  console.log("\n[2m] mapNetworkPolicy() - out-of-range IPv4 / prefix are typed-rejected, not DNS-resolved");

  for (const dest of ["300.1.1.1", "10.0.0.0/40"]) {
    let error: unknown;
    let resolverCalled = false;
    try {
      await _testMapNetworkPolicy(
        { outbound: "blocked", allowedDestinations: [dest] },
        async () => {
          resolverCalled = true;
          return ["9.9.9.9"];
        }
      );
    } catch (e) {
      error = e;
    }
    assert(error instanceof DaytonaNetworkPolicyError, `"${dest}" throws DaytonaNetworkPolicyError`);
    assertEqual(
      (error as DaytonaNetworkPolicyError).reason,
      "invalid-ipv4",
      `"${dest}" reason = invalid-ipv4 (octets 0-255, prefix 0-32)`
    );
    assert(
      String(error).includes("0-255") && String(error).includes("0-32"),
      `"${dest}" message states the octet/prefix ranges`
    );
    assert(!resolverCalled, `"${dest}" rejected before any DNS lookup (not treated as a hostname)`);
  }
}

// =============================================================================
// [3] imageRegistryHost() — private registry detection
// =============================================================================

async function testImageRegistryHostDetection(): Promise<void> {
  console.log("\n[3a] imageRegistryHost() - registry host detection");

  assertEqual(_testImageRegistryHost("evolvingmachines/evolve-all"), undefined, "Docker Hub org image → no registry host");
  assertEqual(_testImageRegistryHost("python:3.12-slim"), undefined, "Official image with tag → no registry host");
  assertEqual(_testImageRegistryHost("library/python"), undefined, "Two-segment Hub image → no registry host");
  assertEqual(
    _testImageRegistryHost("123456789012.dkr.ecr.us-east-1.amazonaws.com/evolve:prod"),
    "123456789012.dkr.ecr.us-east-1.amazonaws.com",
    "ECR reference → ECR registry host"
  );
  assertEqual(_testImageRegistryHost("ghcr.io/org/image:v1"), "ghcr.io", "GHCR reference → ghcr.io");
  assertEqual(_testImageRegistryHost("localhost:5000/img"), "localhost:5000", "localhost registry detected");
}

async function testImagePullErrorShape(): Promise<void> {
  console.log("\n[3b] DaytonaImagePullError - typed, documents the dashboard prerequisite");

  const error = new DaytonaImagePullError(
    "123456789012.dkr.ecr.us-east-1.amazonaws.com/evolve:prod",
    new Error("pull access denied")
  );
  assertEqual(error.name, "DaytonaImagePullError", "Error is typed by name");
  assertEqual(
    error.image,
    "123456789012.dkr.ecr.us-east-1.amazonaws.com/evolve:prod",
    "Error carries the image reference"
  );
  assert(error.message.includes("pull access denied"), "Original cause surfaced in the message");
  assert(
    error.message.includes("dashboard") && error.message.includes("Registries"),
    "Message documents the dashboard-side registry-credential prerequisite"
  );
}

// =============================================================================
// [4] toSandboxInfo() — real timestamps, no fabrication
// =============================================================================

async function testSandboxInfoRealTimestamps(): Promise<void> {
  console.log("\n[4a] toSandboxInfo() - real API createdAt, labels, snapshot");

  const info = _testToSandboxInfo({
    id: "sb-123",
    name: "my-sandbox",
    snapshot: "evolve-all",
    labels: { runId: "run-42" },
    createdAt: "2026-07-22T01:02:03.000Z",
  });
  assertEqual(info.sandboxId, "sb-123", "sandboxId passes through");
  assertEqual(info.image, "evolve-all", "Image comes from the API's snapshot field");
  assertEqual(info.startedAt, "2026-07-22T01:02:03.000Z", "startedAt is the API's real createdAt");
  assertEqual(info.metadata, { runId: "run-42" }, "Labels surface as metadata");
  assertEqual(info.endAt, undefined, "endAt is undefined (Daytona exposes no end timestamp)");
}

async function testSandboxInfoNothingFabricated(): Promise<void> {
  console.log("\n[4b] toSandboxInfo() - missing fields stay empty, never fabricated");

  const info = _testToSandboxInfo({ id: "sb-bare" });
  assertEqual(info.startedAt, "", "Missing createdAt → empty string, not a fabricated client-side date");
  assertEqual(info.image, "", "Missing snapshot → empty string, not invented");
  assertEqual(info.metadata, {}, "Missing labels → empty metadata");
}

// =============================================================================
// [5] daytonaStateToEvolveState() — list() state filter mapping
// =============================================================================

async function testStateMapping(): Promise<void> {
  console.log("\n[5a] daytonaStateToEvolveState() - state filter mapping");

  assertEqual(_testDaytonaStateToEvolveState("started"), "running", "started → running");
  assertEqual(_testDaytonaStateToEvolveState("stopped"), "paused", "stopped → paused (our pause() stops)");
  assertEqual(_testDaytonaStateToEvolveState("archived"), "paused", "archived → paused");
  assertEqual(_testDaytonaStateToEvolveState("starting"), undefined, "Transitional states match no filter");
  assertEqual(_testDaytonaStateToEvolveState("error"), undefined, "Error state matches no filter");
  assertEqual(_testDaytonaStateToEvolveState("destroyed"), undefined, "Destroyed matches no filter");
  assertEqual(_testDaytonaStateToEvolveState(undefined), undefined, "Missing state matches no filter");
}

// =============================================================================
// [6] DaytonaProvider.create() — offline validation + enforcement wiring
// =============================================================================

async function testCreateValidatesBeforeNetwork(): Promise<void> {
  console.log("\n[6a] DaytonaProvider.create() - network validation fires before any API call");

  const provider = createDaytonaProvider({ apiKey: "test-key" });

  let comboError = "";
  try {
    await provider.create({
      image: "evolve-all",
      network: { outbound: "open", allowedDestinations: ["api.example.com"] },
    });
  } catch (e) {
    comboError = String(e);
  }
  assert(
    comboError.includes("only valid when outbound is blocked"),
    "create() rejects open + allowedDestinations with the shared validation message"
  );

  let ipv6Error: unknown;
  try {
    await provider.create({
      image: "evolve-all",
      network: { outbound: "blocked", allowedDestinations: ["2001:db8::1"] },
    });
  } catch (e) {
    ipv6Error = e;
  }
  assert(
    ipv6Error instanceof DaytonaNetworkPolicyError,
    "create() throws the typed network policy error offline (no API call needed)"
  );

  let wildcardError: unknown;
  try {
    await provider.create({
      image: "evolve-all",
      network: { outbound: "blocked", allowedDestinations: ["*.openai.com"] },
    });
  } catch (e) {
    wildcardError = e;
  }
  assert(
    wildcardError instanceof DaytonaNetworkPolicyError &&
      (wildcardError as DaytonaNetworkPolicyError).reason === "wildcard-hostname",
    "create() typed-rejects wildcard hostnames offline"
  );
}

async function testCreateRejectsGpuTypesOffline(): Promise<void> {
  console.log("\n[6a2] DaytonaProvider.create() - GPU TYPE constraint typed-rejected offline");

  const provider = createDaytonaProvider({ apiKey: "test-key" });

  // @daytonaio/sdk 0.134.0 has no gpu_type field anywhere: honoring
  // `resources.gpuTypes` is impossible, and silently dropping it would turn
  // "give me an H100" into "give me some GPU". Typed refusal, before any API
  // call — same provider law as disk on modal.
  let gpuTypeError: unknown;
  try {
    await provider.create({
      image: "evolve-all",
      resources: { gpu: 1, gpuTypes: ["H100"] },
    });
  } catch (e) {
    gpuTypeError = e;
  }
  assert(
    gpuTypeError instanceof DaytonaGpuTypeError,
    "create() throws DaytonaGpuTypeError for a gpuTypes constraint"
  );
  assert(
    String(gpuTypeError).includes("modal"),
    "the message points at the provider that CAN reserve typed GPUs"
  );
}

async function testCreateNoLongerRejectsUserAndNetwork(): Promise<void> {
  console.log("\n[6b] DaytonaProvider.create() - user and network options are enforced, not rejected");

  const provider = createDaytonaProvider({ apiKey: "test-key" });

  // The old provider threw "does not yet implement" for user and network
  // before doing anything else. Now both pass capability validation; with an
  // invalid network combo the shared validation error fires instead, proving
  // neither option was rejected up front.
  let error = "";
  try {
    await provider.create({
      image: "evolve-all",
      user: "worker",
      network: { outbound: "open", allowedDestinations: ["api.example.com"] },
    });
  } catch (e) {
    error = String(e);
  }
  assert(!error.includes("does not yet implement"), "No capability-rejection error for user/network");
  assert(!error.includes("sandbox user option"), "The user option is no longer rejected");
  assert(
    error.includes("only valid when outbound is blocked"),
    "Validation proceeded to the network combo check (options accepted)"
  );
}

async function testCreateRejectsIdleTimeout(): Promise<void> {
  console.log("\n[6d] DaytonaProvider.create() - idleTimeoutMs is refused: auto-stop is already timeoutMs");

  const provider = createDaytonaProvider({ apiKey: "test-key" });
  // A marker on the client proves the refusal happens before ANY API call —
  // this one fires before even the DNS pinning that mapNetworkPolicy does.
  (provider as unknown as { client: unknown }).client = {
    snapshot: { get: async () => ({ state: "active" }) },
    create: async () => {
      throw new Error("MARKER_CLIENT_CREATE_CALLED");
    },
  };

  let error: unknown;
  try {
    await provider.create({ image: "eval-env-cafe", idleTimeoutMs: 1_800_000 });
  } catch (e) {
    error = e;
  }
  assert(error instanceof DaytonaIdleTimeoutError, "idleTimeoutMs throws DaytonaIdleTimeoutError");
  assert(
    String(error).includes("autoStopInterval"),
    "Message names the knob timeoutMs already drives"
  );
  assert(
    !String(error).includes("MARKER_CLIENT_CREATE_CALLED"),
    "Refused before any Daytona API call"
  );

  // Unset stays unset: the ordinary path is untouched by the new guard.
  let unsetError = "";
  try {
    await provider.create({ image: "eval-env-cafe" });
  } catch (e) {
    unsetError = String(e);
  }
  assert(
    unsetError.includes("MARKER_CLIENT_CREATE_CALLED"),
    "Without idleTimeoutMs the create proceeds to the client as before"
  );
}

async function testCreateRejectsResourcesOnCachedSnapshot(): Promise<void> {
  console.log("\n[6c] DaytonaProvider.create() - resources vs cached snapshot: typed refusal, never silent ignore");

  const provider = createDaytonaProvider({ apiKey: "test-key" });
  // Patch the internal client: the snapshot exists and is active (fast path).
  // create() throws a marker so we can prove which path was taken.
  const markerError = new Error("MARKER_CLIENT_CREATE_CALLED");
  (provider as unknown as { client: unknown }).client = {
    snapshot: { get: async () => ({ state: "active" }) },
    create: async () => {
      throw markerError;
    },
  };

  // Declared sizing + existing snapshot → typed refusal BEFORE any create call
  // (create-from-snapshot cannot resize; silence would under/over-provision).
  let sized: unknown;
  try {
    await provider.create({ image: "eval-env-cafe", resources: { cpu: 2, memory: 8, disk: 20 } });
  } catch (e) {
    sized = e;
  }
  assert(sized instanceof DaytonaResourcesError, "resources + cached snapshot throws DaytonaResourcesError");
  assert(
    (sized as DaytonaResourcesError).snapshot === "eval-env-cafe",
    "the typed error names the pinning snapshot"
  );
  assert(String(sized).includes("cannot be enforced"), "message states the enforcement gap");

  // No resources → the fast path proceeds to client.create (marker surfaces),
  // proving the refusal is scoped to declared sizing only.
  let unsized: unknown;
  try {
    await provider.create({ image: "eval-env-cafe" });
  } catch (e) {
    unsized = e;
  }
  assert(unsized === markerError, "without resources the cached-snapshot fast path is unchanged");

  // Empty resources object declares nothing → fast path unchanged too.
  let empty: unknown;
  try {
    await provider.create({ image: "eval-env-cafe", resources: {} });
  } catch (e) {
    empty = e;
  }
  assert(empty === markerError, "an empty resources object is not a sizing declaration");
}

// =============================================================================
// [6.5] Snapshot self-heal — exists-but-inactive is reactivated, never rebuilt
// =============================================================================

/** Capture console.log so the heal-path logging never pollutes test output. */
async function silenceLogs<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
}

async function testCreateHealsInactiveSnapshot(): Promise<void> {
  console.log("\n[6e] DaytonaProvider.create() - inactive snapshot: activate, then create from it");

  // Daytona deactivates snapshots after 2 weeks unused. Before the heal, this
  // case fell into the build path, whose snapshot.create fails on the existing
  // name and degrades to a slow direct pull — the 2026-07-31 prod incident.
  const provider = createDaytonaProvider({ apiKey: "test-key" });
  let activateCalls = 0;
  let snapshotCreateCalls = 0;
  let createParams: { snapshot?: string } | undefined;
  (provider as unknown as { client: unknown }).client = {
    snapshot: {
      get: async () => ({ state: "inactive", name: "eval-env-cafe" }),
      activate: async () => {
        activateCalls++;
        return { state: "active" };
      },
      create: async () => {
        snapshotCreateCalls++;
        throw new Error("MARKER_SNAPSHOT_BUILD_TRIGGERED");
      },
    },
    create: async (params: { snapshot?: string }) => {
      createParams = params;
      return { id: "sb-healed" };
    },
  };

  const instance = await silenceLogs(() => provider.create({ image: "eval-env-cafe" }));
  assertEqual(instance.sandboxId, "sb-healed", "create proceeds from the reactivated snapshot");
  assertEqual(activateCalls, 1, "the inactive snapshot is activated exactly once");
  assertEqual(createParams?.snapshot, "eval-env-cafe", "the sandbox is created FROM the snapshot, not the raw image");
  assertEqual(snapshotCreateCalls, 0, "the build path is never entered for an existing snapshot");
}

async function testCreateActiveSnapshotUntouchedByActivation(): Promise<void> {
  console.log("\n[6f] DaytonaProvider.create() - active snapshot: activate is never called");

  const provider = createDaytonaProvider({ apiKey: "test-key" });
  let activateCalls = 0;
  (provider as unknown as { client: unknown }).client = {
    snapshot: {
      get: async () => ({ state: "active" }),
      activate: async () => {
        activateCalls++;
        return { state: "active" };
      },
    },
    create: async () => ({ id: "sb-fast" }),
  };

  const instance = await silenceLogs(() => provider.create({ image: "eval-env-cafe" }));
  assertEqual(instance.sandboxId, "sb-fast", "the fast path is unchanged");
  assertEqual(activateCalls, 0, "an already-active snapshot is never touched");
}

async function testCreateRefusesResourcesBeforeActivation(): Promise<void> {
  console.log("\n[6g] DaytonaProvider.create() - resources + inactive snapshot: refusal fires before activation");

  // An existing snapshot pins its sizing whatever its state — no reactivation
  // work is spent on a create that will be refused anyway.
  const provider = createDaytonaProvider({ apiKey: "test-key" });
  let activateCalls = 0;
  (provider as unknown as { client: unknown }).client = {
    snapshot: {
      get: async () => ({ state: "inactive" }),
      activate: async () => {
        activateCalls++;
        return { state: "active" };
      },
    },
    create: async () => ({ id: "sb-never" }),
  };

  let error: unknown;
  try {
    await silenceLogs(() => provider.create({ image: "eval-env-cafe", resources: { cpu: 2 } }));
  } catch (e) {
    error = e;
  }
  assert(error instanceof DaytonaResourcesError, "resources + inactive snapshot throws DaytonaResourcesError");
  assertEqual(activateCalls, 0, "no activation is attempted for a doomed create");
}

async function testActivationFailureIsFinal(): Promise<void> {
  console.log("\n[6h] DaytonaProvider.create() - a snapshot that will not activate is a final verdict");

  // Terminal failure state during activation: the typed error propagates and
  // the build path is NOT entered — rebuilding under the same name can only
  // name-conflict and then mask the incident behind a slow direct pull.
  const provider = createDaytonaProvider({ apiKey: "test-key" });
  let snapshotCreateCalls = 0;
  let sandboxCreateCalls = 0;
  (provider as unknown as { client: unknown }).client = {
    snapshot: {
      get: async () => ({ state: "inactive" }),
      activate: async () => ({ state: "error" }),
      create: async () => {
        snapshotCreateCalls++;
        return {};
      },
    },
    create: async () => {
      sandboxCreateCalls++;
      return { id: "sb-never" };
    },
  };

  let error: unknown;
  try {
    await silenceLogs(() => provider.create({ image: "eval-env-cafe" }));
  } catch (e) {
    error = e;
  }
  assert(error instanceof DaytonaSnapshotActivationError, "activation failure throws DaytonaSnapshotActivationError");
  assert(String(error).includes("eval-env-cafe"), "the error names the snapshot");
  assertEqual(snapshotCreateCalls, 0, "the build path is not entered");
  assertEqual(sandboxCreateCalls, 0, "no sandbox create is attempted");
}

async function testActivateSnapshotPollsUntilActive(): Promise<void> {
  console.log("\n[6i] activateSnapshot() - transitional states are polled through to active");

  const states = ["pulling", "pulling", "active"];
  let gets = 0;
  const client = {
    snapshot: {
      get: async () => ({ state: states[gets++] ?? "active" }),
      activate: async () => ({ state: "pulling" }),
    },
  };

  const result = await silenceLogs(() =>
    _testActivateSnapshot(client, "evolve-all", { state: "inactive" }, { timeoutMs: 5_000, pollMs: 1 })
  );
  assertEqual(result.state, "active", "polling ends on the active state");
  assertEqual(gets, 3, "each poll asks the API again rather than trusting the activate response");
}

async function testActivateSnapshotTimesOutLoudly(): Promise<void> {
  console.log("\n[6j] activateSnapshot() - a bounded wait, ended by a clear timeout error");

  const client = {
    snapshot: {
      get: async () => ({ state: "pulling" }),
      activate: async () => ({ state: "pulling" }),
    },
  };

  let error: unknown;
  try {
    await silenceLogs(() =>
      _testActivateSnapshot(client, "evolve-all", { state: "inactive" }, { timeoutMs: 0, pollMs: 1 })
    );
  } catch (e) {
    error = e;
  }
  assert(error instanceof DaytonaSnapshotActivationError, "the timeout throws the typed activation error");
  assert(String(error).includes("evolve-all"), "the error names the snapshot");
  assert(String(error).includes("0ms"), "the error states the bound that was exceeded");
  assert(String(error).includes("pulling"), "the error reports the last observed state");
}

async function testActivateSnapshotSurfacesActivateFailure(): Promise<void> {
  console.log("\n[6k] activateSnapshot() - a failed activate call is surfaced with its cause");

  const client = {
    snapshot: {
      get: async () => ({ state: "inactive" }),
      activate: async () => {
        throw new Error("upstream 500");
      },
    },
  };

  let error: unknown;
  try {
    await silenceLogs(() =>
      _testActivateSnapshot(client, "evolve-all", { state: "inactive" }, { timeoutMs: 1_000, pollMs: 1 })
    );
  } catch (e) {
    error = e;
  }
  assert(error instanceof DaytonaSnapshotActivationError, "an activate failure throws the typed error");
  assert(String(error).includes("upstream 500"), "the original cause survives in the message");
}

async function testActivateSnapshotPollFailureIsTyped(): Promise<void> {
  console.log("\n[6l] activateSnapshot() - a failed POLL get wears the same typed error as activate");

  // A raw error escaping the poll loop would not match either typed-refusal
  // check in create()'s catch and would enter the build path — name-conflict
  // on the existing snapshot, then the masked slow direct pull.
  const client = {
    snapshot: {
      get: async () => {
        throw new Error("socket hang up");
      },
      activate: async () => ({ state: "pulling" }),
    },
  };

  let error: unknown;
  try {
    await silenceLogs(() =>
      _testActivateSnapshot(client, "evolve-all", { state: "inactive" }, { timeoutMs: 5_000, pollMs: 1 })
    );
  } catch (e) {
    error = e;
  }
  assert(error instanceof DaytonaSnapshotActivationError, "a poll-time get failure throws the typed error");
  assert(String(error).includes("evolve-all"), "the error names the snapshot");
  assert(String(error).includes("socket hang up"), "the original cause survives in the message");
}

// =============================================================================
// [7] DaytonaCommands — mock-based session exec wiring
// =============================================================================

interface SessionExecCall {
  sessionId: string;
  command: string;
  runAsync: boolean;
}

function createMockDaytonaSandbox(opts?: { stdout?: string; stderr?: string; exitCode?: number }) {
  const execCalls: SessionExecCall[] = [];
  const sessions = new Set<string>();
  const response = {
    cmdId: "cmd-001",
    exitCode: opts?.exitCode ?? 0,
    stdout: opts?.stdout ?? "ok",
    stderr: opts?.stderr ?? "",
  };

  const sandbox = {
    id: "daytona-sandbox-123",
    process: {
      createSession: async (sessionId: string) => {
        sessions.add(sessionId);
      },
      executeSessionCommand: async (
        sessionId: string,
        params: { command: string; runAsync: boolean },
        _timeout?: number
      ) => {
        execCalls.push({ sessionId, ...params });
        return { ...response };
      },
      getSessionCommandLogs: async () => ({ stdout: response.stdout, stderr: response.stderr }),
      getSessionCommand: async () => ({ exitCode: response.exitCode }),
      deleteSession: async (sessionId: string) => {
        sessions.delete(sessionId);
      },
      listSessions: async () => [],
    },
  };
  return { sandbox, execCalls, sessions };
}

async function testCommandsRunAsRootUsesSudoWrapper(): Promise<void> {
  console.log("\n[7a] DaytonaCommands.run() - root user wraps the session command with sudo");

  const { sandbox, execCalls } = createMockDaytonaSandbox({ stdout: "hi" });
  const commands = new DaytonaCommands(sandbox as any, "root");

  const result = await commands.run("echo hi", { cwd: "/workspace", envs: { A: "1" } });

  assertEqual(execCalls.length, 1, "Exactly one session exec call");
  assert(execCalls[0].command.endsWith("| sudo -n bash"), "Session command pipes through sudo -n bash");
  const rootPayload = decodeSudoPayload(execCalls[0].command);
  assertEqual(
    rootPayload,
    `export A='1'; cd '/workspace' && ${withSentinel("echo hi", rootPayload)}`,
    "Payload carries envs + cwd + command, and the sentinel runs as root with them"
  );
  assertEqual(result, { exitCode: 0, stdout: "hi", stderr: "" }, "Result comes back from the session");
}

async function testCommandsRunDefaultUserNoWrapper(): Promise<void> {
  console.log("\n[7b] DaytonaCommands.run() - no user: unwrapped command (image OS user)");

  const { sandbox, execCalls } = createMockDaytonaSandbox({ stdout: "out" });
  const commands = new DaytonaCommands(sandbox as any);

  await commands.run("whoami");
  assertEqual(
    execCalls[0].command,
    withSentinel("whoami", execCalls[0].command),
    "No sudo wrapper without a root user — only the end-of-output sentinel"
  );
}

async function testCommandsSpawnRootWrapper(): Promise<void> {
  console.log("\n[7c] DaytonaCommands.spawn() - root sudo wrapper + async session");

  const { sandbox, execCalls } = createMockDaytonaSandbox();
  const commands = new DaytonaCommands(sandbox as any, "root");

  const handle = await commands.spawn("sleep 1 && echo bg", { envs: { B: "2" } });
  assertEqual(execCalls[0].runAsync, true, "spawn executes async");
  const spawnPayload = decodeSudoPayload(execCalls[0].command);
  assertEqual(
    spawnPayload,
    `export B='2'; ${withSentinel("sleep 1 && echo bg", spawnPayload)}`,
    "spawn payload carries envs + command + sentinel through the sudo wrapper"
  );
  assert(typeof handle.processId === "string" && handle.processId.length > 0, "spawn returns a process handle");
}

async function testSpawnWaitDistinguishesSandboxFromSession(): Promise<void> {
  console.log("\n[7d] spawn().wait() - a deleted SANDBOX is not a terminated session");

  // Measured 2026-07-26: an eval box was deleted 6m57s into a run, this poll
  // loop reported exit -1 "session terminated" within its next 500ms, and the
  // artifact collect that followed failed with "sandbox not found". The reader
  // spent the investigation on the harness. Both cases still end the wait at
  // -1 — only the reason changes, so no caller's adjudication moves.
  // The box is still there: refreshData() answers, so only the session went.
  const sessionGone = createMockDaytonaSandbox();
  sessionGone.sandbox.process.getSessionCommand = async () => {
    throw new Error("Session not found");
  };
  (sessionGone.sandbox as any).refreshData = async () => undefined;
  const sessionHandle = await new DaytonaCommands(sessionGone.sandbox as any, "root").spawn("sleep 1");
  const sessionResult = await sessionHandle.wait();
  assertEqual(sessionResult.exitCode, -1, "a vanished session still ends the wait at -1");
  assertEqual(sessionResult.stderr, "session terminated", "a vanished session is still an interrupt");

  // The box is gone: the probe 404s the same way the poll did.
  const sandboxGone = createMockDaytonaSandbox();
  sandboxGone.sandbox.process.getSessionCommand = async () => {
    throw new Error("Session not found");
  };
  (sandboxGone.sandbox as any).refreshData = async () => {
    throw new Error("Sandbox not found");
  };
  const sandboxHandle = await new DaytonaCommands(sandboxGone.sandbox as any, "root").spawn("sleep 1");
  const sandboxResult = await sandboxHandle.wait();
  assertEqual(sandboxResult.exitCode, -1, "a vanished sandbox also ends the wait at -1");
  assertEqual(
    sandboxResult.stderr,
    "sandbox deleted during run",
    "the API is ASKED, so a 404 whose wording says 'session' is still reported as the box being gone"
  );
}

async function testAutoDeleteGrace(): Promise<void> {
  console.log("\n[7e] create() - a stopped box gets a grace period, not instant deletion");

  // 0 meant "delete immediately upon stopping", which turns any stop into
  // unrecoverable loss of a box whose work was never collected — and destroys
  // the evidence needed to attribute the stop.
  assert(
    DAYTONA_AUTO_DELETE_GRACE_MINUTES > 0,
    "a stopped sandbox survives long enough to be inspected and collected from"
  );
  assert(
    DAYTONA_AUTO_DELETE_GRACE_MINUTES <= 30,
    "and not so long that it becomes a way to hold billable state"
  );
}

// =============================================================================
// RUNNER
// =============================================================================

const tests = [
  // [1] wrapCommand user param
  testWrapCommandNoUserPassthrough,
  testWrapCommandRootSudoWrapper,
  testWrapCommandRootCwdEnvs,
  testWrapCommandRootComplexQuoting,
  testWrapCommandRootEscaping,
  testWrapCommandNonStringEnv,
  // [2] mapNetworkPolicy
  testNetworkNoPolicy,
  testNetworkOpenWithDestinationsThrows,
  testNetworkBlockedAll,
  testNetworkIpv4Allowlist,
  testNetworkHostnamePinning,
  testNetworkHostnameDedupe,
  testNetworkWildcardThrows,
  testNetworkIpv6Throws,
  testNetworkUnresolvableThrows,
  testNetworkAllowlistLimit,
  testNetworkPortThrows,
  testNetworkTrueIpv6StillThrowsIpv6,
  testNetworkInvalidIpv4Throws,
  // [3] registry detection + pull error
  testImageRegistryHostDetection,
  testImagePullErrorShape,
  // [4] toSandboxInfo
  testSandboxInfoRealTimestamps,
  testSandboxInfoNothingFabricated,
  // [5] state mapping
  testStateMapping,
  // [6] provider create validation
  testCreateValidatesBeforeNetwork,
  testCreateRejectsGpuTypesOffline,
  testCreateNoLongerRejectsUserAndNetwork,
  testCreateRejectsResourcesOnCachedSnapshot,
  testCreateRejectsIdleTimeout,
  // [6.5] snapshot self-heal
  testCreateHealsInactiveSnapshot,
  testCreateActiveSnapshotUntouchedByActivation,
  testCreateRefusesResourcesBeforeActivation,
  testActivationFailureIsFinal,
  testActivateSnapshotPollsUntilActive,
  testActivateSnapshotTimesOutLoudly,
  testActivateSnapshotSurfacesActivateFailure,
  testActivateSnapshotPollFailureIsTyped,
  // [7] DaytonaCommands
  testCommandsRunAsRootUsesSudoWrapper,
  testCommandsRunDefaultUserNoWrapper,
  testCommandsSpawnRootWrapper,
  testSpawnWaitDistinguishesSandboxFromSession,
  testAutoDeleteGrace,
];

(async () => {
  console.log("=== Daytona Provider: sudo wrapper + network policy + registry + info + state Tests ===");
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
