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
  _testWaitForSnapshotConflictWinner,
  _testIsSnapshotNameConflict,
  _testProviderCanRebuildSnapshot,
  _testImageMap,
  EVOLVE_IMAGE_VERSION,
  _testWrapCommand,
  _testMapNetworkPolicy,
  _testMapNetworkPolicyForUpdate,
  _testIsNetworkPolicyTierRefusal,
  _testImageRegistryHost,
  _testToSandboxInfo,
  _testDaytonaStateToEvolveState,
  DAYTONA_MAX_NETWORK_ALLOWLIST,
  DAYTONA_AUTO_DELETE_GRACE_MINUTES,
  DaytonaNetworkPolicyError,
  DaytonaResourcesError,
  DaytonaIdleTimeoutError,
  DaytonaImagePullError,
  DaytonaSnapshotActivationError,
  DaytonaSnapshotConflictError,
  DAYTONA_SNAPSHOT_GONE,
  DaytonaCommands,
  DaytonaProvider,
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

async function testCreateForwardsGpuTypesOnBuild(): Promise<void> {
  console.log("\n[6a2] DaytonaProvider.create() - GPU TYPE: forwarded on build, refused on a pinned snapshot");

  // @daytonaio/sdk 0.203.0 grew a real Resources.gpuType wire field, so the
  // old blanket DaytonaGpuTypeError refusal is retired: on the BUILD path
  // "give me an H100" now reaches Daytona verbatim (which validates the name
  // server-side), and only an EXISTING snapshot — whose sizing is pinned —
  // still refuses, with the same DaytonaResourcesError as every other sizing
  // field.

  // Build path: no snapshot exists; both the snapshot build and the direct
  // fallback must carry the count AND the type.
  const provider = createDaytonaProvider({ apiKey: "test-key" });
  const captured: Array<{ resources?: { gpu?: number; gpuType?: string[] } }> = [];
  (provider as unknown as { client: unknown }).client = {
    snapshot: {
      get: async () => {
        throw new Error("not found");
      },
      create: async (params: { resources?: { gpu?: number; gpuType?: string[] } }) => {
        captured.push(params);
        throw new Error("MARKER_SNAPSHOT_BUILD_FAILED");
      },
    },
    create: async (params: { resources?: { gpu?: number; gpuType?: string[] } }) => {
      captured.push(params);
      throw new Error("MARKER_DIRECT_CREATE_FAILED");
    },
  };

  let buildError = "";
  try {
    await provider.create({
      image: "evolve-all",
      resources: { gpu: 1, gpuTypes: ["H100"] },
    });
  } catch (e) {
    buildError = String(e);
  }
  assert(captured.length === 2, "the walk tried the snapshot build, then the direct fallback");
  assert(
    captured[0]?.resources?.gpu === 1 &&
      JSON.stringify(captured[0]?.resources?.gpuType) === '["H100"]',
    "the snapshot build carries gpu count AND gpuType — no silent 'some GPU'"
  );
  assert(
    captured[1]?.resources?.gpu === 1 &&
      JSON.stringify(captured[1]?.resources?.gpuType) === '["H100"]',
    "and the direct fallback keeps both rather than downgrading to a CPU box"
  );
  assert(buildError.includes("MARKER_DIRECT_CREATE_FAILED"), "no typed refusal fired on the build path");

  // Pinned-snapshot path: the type is as unresizable as cpu/memory/disk.
  const pinned = createDaytonaProvider({ apiKey: "test-key" });
  (pinned as unknown as { client: unknown }).client = {
    snapshot: { get: async () => ({ state: "active" }) },
    create: async () => {
      throw new Error("MARKER_CLIENT_CREATE_CALLED");
    },
  };
  let pinnedError: unknown;
  try {
    await pinned.create({ image: "evolve-all", resources: { gpuTypes: ["H100"] } });
  } catch (e) {
    pinnedError = e;
  }
  assert(
    pinnedError instanceof DaytonaResourcesError,
    "gpuTypes against an existing snapshot throws DaytonaResourcesError before any create call"
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
// [6.6] WAIT-ON-CONFLICT — a lost snapshot name race waits for the winner
//
// Harbor's law (REFERENCES/Harbor/src/harbor/environments/daytona/
// snapshots.py:281-288): when snapshot.create loses the name, another process
// is already building this exact image — wait for it and reuse it, rather than
// pulling the same bytes again on the slow direct path.
// =============================================================================

/** Silence both log and warn: the conflict wait narrates on both channels. */
async function silenceNoise<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  const warn = console.warn;
  console.log = () => {};
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.warn = warn;
  }
}

/** Production conflict clocks are 10 minutes; the tests measure the SHAPE. */
class FastConflictProvider extends DaytonaProvider {
  // DELIBERATELY DIFFERENT NUMBERS. When both clocks were 50ms, a delete poll
  // handed the CONFLICT budget by mistake looked exactly like one on its own —
  // which is how the shared-field bug survived a green suite. An order of
  // magnitude between them makes the wrong clock measurable, and [6an] asserts
  // on it.
  protected override snapshotConflictTiming = { timeoutMs: 300, pollMs: 1 };
  protected override snapshotDeleteTiming = { timeoutMs: 30, pollMs: 1 };
}

/**
 * A client whose snapshot.get answers a SCRIPT: the first answer is consumed
 * by create()'s fast path (which must miss for the build path to run), and the
 * rest by the conflict wait. A `null` entry means "the GET itself failed".
 */
function createConflictClient(
  script: Array<{ state?: string } | null>,
  opts?: { createError?: unknown },
) {
  const state = {
    gets: 0,
    deletes: 0,
    snapshotCreateCalls: 0,
    createParams: undefined as
      | { snapshot?: string; image?: string; resources?: { cpu?: number; memory?: number } }
      | undefined,
  };
  const client = {
    snapshot: {
      get: async () => {
        const answer = script[state.gets++];
        if (answer === null || answer === undefined) throw new Error("snapshot not found");
        return answer;
      },
      // The healer can reach every path this client drives, so the verb has to
      // exist here too — a missing one would fail as a TypeError rather than
      // exercising the behaviour under test.
      delete: async () => {
        state.deletes++;
      },
      create: async () => {
        state.snapshotCreateCalls++;
        throw (
          opts?.createError ??
          new Error('Snapshot with name "eval-env-cafe" already exists')
        );
      },
    },
    create: async (params: { snapshot?: string; image?: string }) => {
      state.createParams = params;
      return { id: params.snapshot ? "sb-from-snapshot" : "sb-direct-pull" };
    },
  };
  return { client, state };
}

// =============================================================================
// [6.7] DEAD SNAPSHOTS ARE DELETED, THEN REBUILT (Harbor snapshots.py:200-212)
// =============================================================================

/**
 * A client whose snapshot.get answers a SCRIPT and whose delete/create are
 * recorded. Separate from createConflictClient because these cases need the
 * delete verb and a create that can SUCCEED once the name is free.
 */
function createDeadSnapshotClient(
  script: Array<{ state?: string; name?: string } | null>,
  opts?: { deleteError?: unknown; createError?: unknown },
) {
  const state = {
    gets: 0,
    deletes: 0,
    deleted: undefined as unknown,
    snapshotCreateCalls: 0,
    createParams: undefined as { snapshot?: string; image?: string } | undefined,
  };
  const client = {
    snapshot: {
      get: async () => {
        const answer = script[state.gets++];
        if (answer === null || answer === undefined) throw new Error("snapshot not found");
        return answer;
      },
      delete: async (snapshot: unknown) => {
        state.deletes++;
        state.deleted = snapshot;
        if (opts?.deleteError) throw opts.deleteError;
      },
      create: async () => {
        state.snapshotCreateCalls++;
        if (opts?.createError) throw opts.createError;
      },
    },
    create: async (params: { snapshot?: string; image?: string }) => {
      state.createParams = params;
      return { id: params.snapshot ? "sb-from-snapshot" : "sb-direct-pull" };
    },
  };
  return { client, state };
}

function providerOn(client: unknown): DaytonaProvider {
  const provider = new FastConflictProvider({ apiKey: "k" });
  (provider as unknown as { client: unknown }).client = client;
  return provider;
}

async function testDeadSnapshotIsDeletedThenRebuilt(): Promise<void> {
  console.log("\n[6ad] create() - a DEAD snapshot is deleted and rebuilt, not left to poison the name");

  // The bug this fixes: nothing ever removed a failed record, so snapshot.create
  // lost the name to it on every later run and each one degraded to the slow
  // direct pull, permanently.
  // A TAGGED exemplar, because deletability is decided by the resolved ref:
  // Daytona refuses to build an untagged image, so an untagged one must never
  // be deleted (see the evolve-all case in [6af]).
  for (const dead of ["error", "build_failed"]) {
    const { client, state } = createDeadSnapshotClient([{ state: dead, name: "ubuntu:24.04" }]);
    const sandbox = await silenceNoise(() =>
      providerOn(client).create({ image: "ubuntu:24.04" })
    );

    assertEqual(state.deletes, 1, `a "${dead}" snapshot is deleted`);
    assertEqual(state.snapshotCreateCalls, 1, `and then REBUILT under the same name ("${dead}")`);
    // The whole point: the sandbox comes from the snapshot, not the slow pull.
    assertEqual(
      state.createParams?.snapshot,
      "ubuntu:24.04",
      `the box boots from the rebuilt snapshot, not a direct image pull ("${dead}")`
    );
    assert(sandbox !== undefined, "a sandbox is returned");
  }
}

async function testDeadSnapshotDeletePassesTheRecordItRead(): Promise<void> {
  console.log("\n[6ae] create() - the delete targets the snapshot record the GET returned");

  const record = { state: "error", name: "ubuntu:24.04", errorReason: "base image gone" };
  const { client, state } = createDeadSnapshotClient([record]);
  await silenceNoise(() => providerOn(client).create({ image: "ubuntu:24.04" }));

  // Daytona's delete takes the snapshot object, not the bare name.
  assertEqual(state.deleted, record, "the record read by the fast path is what gets deleted");
}

async function testUnrebuildableDeadNameIsPreserved(): Promise<void> {
  console.log("\n[6af] create() - a dead name this provider CANNOT rebuild is never deleted");

  // Harbor refuses to auto-delete under EXPLICIT because the name may be a
  // snapshot the user manages. Our equivalent is "can we put it back?" — a bare
  // label resolves to no Docker image, so deleting it would destroy something
  // nothing here could recreate.
  // The dead record still owns the name, so the build path's create loses it —
  // which is precisely why the name was poisoned in the first place.
  const { client, state } = createDeadSnapshotClient(
    [
      { state: "error", name: "my-team-env" }, // fast path
      { state: "error", name: "my-team-env" }, // the conflict wait
    ],
    { createError: new Error('Snapshot with name "my-team-env" already exists') }
  );
  await silenceNoise(() => providerOn(client).create({ image: "my-team-env" }));

  assertEqual(state.deletes, 0, "the user's own snapshot survives");
  assertEqual(state.createParams?.snapshot, undefined, "and the old direct-pull fallback still runs");
  assertEqual(state.createParams?.image, "my-team-env", "pulling the name as an image, exactly as before");
}

async function testDeadSnapshotDeleteFailureFallsBackInsteadOfThrowing(): Promise<void> {
  console.log("\n[6ag] create() - a delete that FAILS leaves the pre-existing fallback, not a hard error");

  // This provider still has a working direct pull, so a refused delete must not
  // turn a degraded path into a failure for callers who get boxes today.
  const { client, state } = createDeadSnapshotClient(
    [
      { state: "error", name: "ubuntu:24.04" }, // fast path
      { state: "error", name: "ubuntu:24.04" }, // the conflict wait, name still held
    ],
    {
      deleteError: new Error("403 forbidden"),
      createError: new Error('Snapshot with name "ubuntu:24.04" already exists'),
    }
  );
  const sandbox = await silenceNoise(() => providerOn(client).create({ image: "ubuntu:24.04" }));

  // ONCE: the fast path tries to clear the corpse and cannot, so the build is
  // skipped rather than raced — which is also why the join that used to follow
  // a lost create never runs. Refused, and still not fatal.
  assertEqual(state.deletes, 1, "the delete was attempted and failed, without throwing");
  assertEqual(state.createParams?.image, "ubuntu:24.04", "and the direct pull carried on");
  assert(sandbox !== undefined, "a sandbox is still returned");
}

async function testDeadWinnerOfAJoinIsClearedThenBuilt(): Promise<void> {
  console.log("\n[6ah] joinInFlightSnapshotBuild() - a build that DIES mid-wait is cleared, then rebuilt here");

  // The second poisoning route: the name was mid-build when we looked, so we
  // waited — and the winner's build failed, leaving the corpse holding the name.
  const { client, state } = createDeadSnapshotClient([
    { state: "building", name: "ubuntu:24.04" }, // fast path: in flight, so JOIN it
    { state: "build_failed", name: "ubuntu:24.04" }, // the wait: it died
  ]);
  await silenceNoise(() => providerOn(client).create({ image: "ubuntu:24.04" }));

  assertEqual(state.deletes, 1, "the dead winner is deleted");
  assertEqual(state.snapshotCreateCalls, 1, "and the build it was waiting for runs here");
  assertEqual(state.createParams?.snapshot, "ubuntu:24.04", "the box boots from the rebuilt snapshot");
}

async function testMissingSnapshotMidWaitIsAnAnswerNotAFailure(): Promise<void> {
  console.log("\n[6aj] waitForSnapshotConflictWinner() - a name that VANISHES mid-wait is resolved, not failed");

  // One process healing a dead name is exactly what should happen. The waiter
  // must read the resulting 404s as "the name is clear", never as three
  // identical poll failures meaning the control plane is down.
  let gets = 0;
  const client = {
    snapshot: {
      get: async () => {
        gets++;
        if (gets === 1) return { state: "building" };
        throw new Error("404: snapshot not found");
      },
    },
  };
  const result = await silenceNoise(() =>
    _testWaitForSnapshotConflictWinner(client, "ubuntu:24.04", { timeoutMs: 5_000, pollMs: 1 })
  );
  assertEqual(result, DAYTONA_SNAPSHOT_GONE, "the wait reports the name as GONE");
  assertEqual(gets, 2, "and answers on the first 404, without spending the failure budget");
}

async function testVanishedNameIsBuiltRatherThanPulled(): Promise<void> {
  console.log("\n[6ak] create() - a name cleared by another healer mid-wait is BUILT here");

  // End to end: the corpse disappears while we wait, so this run builds the
  // snapshot rather than falling back to the slow direct pull.
  const { client, state } = createDeadSnapshotClient([
    { state: "building", name: "ubuntu:24.04" }, // fast path: in flight, join it
    // the wait's first poll: the script is exhausted, so the GET throws
    // "snapshot not found" — another process cleared the name.
  ]);
  await silenceNoise(() => providerOn(client).create({ image: "ubuntu:24.04" }));

  assertEqual(state.deletes, 0, "nothing to delete — someone else already did");
  assertEqual(state.snapshotCreateCalls, 1, "the name is free, so it is built");
  assertEqual(state.createParams?.snapshot, "ubuntu:24.04", "and the box boots from that snapshot");
}

async function testHealedRebuildIsTriedOnceAndNeverLoops(): Promise<void> {
  console.log("\n[6al] create() - the heal adds ONE bounded retry, never a loop");

  // Worst case, end to end: the corpse is cleared, the build loses the name to
  // a third process anyway, the wait finds that name gone too, and the post-heal
  // rebuild loses AGAIN. Each create is driven by fresh evidence that the name
  // was free, so two is correct — what matters is that it STOPS there and takes
  // the existing fallback instead of delete-build-repeat.
  const { client, state } = createDeadSnapshotClient(
    [
      { state: "error", name: "ubuntu:24.04" }, // fast path: dead
      // delete-confirmation poll: script exhausted, GET throws => name is gone
    ],
    { createError: new Error('Snapshot with name "ubuntu:24.04" already exists') }
  );
  await silenceNoise(() => providerOn(client).create({ image: "ubuntu:24.04" }));

  assertEqual(state.deletes, 1, "the corpse is cleared exactly once");
  assertEqual(
    state.snapshotCreateCalls,
    2,
    "the build and ONE post-heal rebuild — bounded, never a delete-build loop"
  );
  assertEqual(state.createParams?.image, "ubuntu:24.04", "and the run ends on the direct pull");
}

async function testDeleteConfirmationWaitsForTheRecordToVanish(): Promise<void> {
  console.log("\n[6am] deleteDeadSnapshot() - the create waits for the delete to actually take effect");

  // Daytona's delete is asynchronous: it acknowledges and moves the snapshot to
  // "Removing". A create fired immediately loses the name to a corpse still
  // being carried out, which deferred every heal by a run.
  let gets = 0;
  const { client, state } = createDeadSnapshotClient([{ state: "error", name: "ubuntu:24.04" }]);
  const lingering = {
    ...client,
    snapshot: {
      ...client.snapshot,
      get: async () => {
        gets++;
        if (gets === 1) return { state: "error", name: "ubuntu:24.04" }; // fast path
        if (gets <= 3) return { state: "removing", name: "ubuntu:24.04" }; // still going
        throw new Error("404: snapshot not found"); // finally gone
      },
    },
  };
  await silenceNoise(() => providerOn(lingering).create({ image: "ubuntu:24.04" }));

  assert(gets >= 4, "the poll kept looking until the record stopped resolving");
  assertEqual(state.snapshotCreateCalls, 1, "and only then was the name rebuilt");
  assertEqual(state.createParams?.snapshot, "ubuntu:24.04", "the box boots from that rebuild");
}

async function testDeleteConfirmationGivesUpOnItsOwnBudget(): Promise<void> {
  console.log("\n[6an] deleteDeadSnapshot() - a record that never vanishes ends on the DELETE budget");

  // The branch no test reached before: every earlier case exhausted the GET
  // script and took the immediate-gone return, so a delete poll running on the
  // ten-minute conflict clock looked exactly like one running on its own.
  let gets = 0;
  const { client, state } = createDeadSnapshotClient([{ state: "error", name: "ubuntu:24.04" }]);
  const neverGone = {
    ...client,
    snapshot: {
      ...client.snapshot,
      // Dead on arrival, then stuck in Removing forever: the corpse never goes.
      get: async () => {
        gets++;
        return gets === 1
          ? { state: "error", name: "ubuntu:24.04" }
          : { state: "removing", name: "ubuntu:24.04" };
      },
    },
  };
  const started = Date.now();
  await silenceNoise(() => providerOn(neverGone).create({ image: "ubuntu:24.04" }));
  const elapsed = Date.now() - started;

  // The delete clock is 30ms here, the conflict clock 300ms. Landing under
  // ~150ms proves the poll ended on ITS budget and not the one it used to
  // borrow — the assertion the previous equal-valued clocks could not make.
  assert(elapsed < 150, `the delete poll ended on its OWN budget (took ${elapsed}ms)`);
  assertEqual(state.snapshotCreateCalls, 0, "an unconfirmed delete does NOT race the removal");
  assertEqual(state.createParams?.image, "ubuntu:24.04", "the run ends on the direct pull instead");
}

async function testDeletePollTreatsOnlyNotFoundAsGone(): Promise<void> {
  console.log("\n[6ao] deleteDeadSnapshot() - a 403 during the poll is not 'gone'");

  // A permission failure says nothing about whether the record survived.
  // Reading it as success would hand back a name a corpse still holds.
  let gets = 0;
  const { client, state } = createDeadSnapshotClient([{ state: "error", name: "ubuntu:24.04" }]);
  const forbidden = {
    ...client,
    snapshot: {
      ...client.snapshot,
      get: async () => {
        gets++;
        if (gets === 1) return { state: "error", name: "ubuntu:24.04" };
        throw new Error("403 forbidden");
      },
    },
  };
  await silenceNoise(() => providerOn(forbidden).create({ image: "ubuntu:24.04" }));

  assertEqual(state.snapshotCreateCalls, 0, "a blip is never mistaken for a cleared name");
  assertEqual(state.createParams?.image, "ubuntu:24.04", "so the run takes the direct pull");
}

async function testJoinPathDeleteRefusedFallsBack(): Promise<void> {
  console.log("\n[6ap] joinInFlightSnapshotBuild() - a dead winner whose delete is REFUSED takes the fallback");

  // The join path's own failure branch, which lost its coverage when the fast
  // path started refusing to race an unconfirmed removal. A 403 is not a
  // not-found, so it is a real refusal: nothing to build over, take the pull.
  const { client, state } = createDeadSnapshotClient(
    [
      { state: "building", name: "ubuntu:24.04" }, // fast path: in flight, join it
      { state: "build_failed", name: "ubuntu:24.04" }, // the wait: it died
    ],
    { deleteError: new Error("403 forbidden") }
  );
  await silenceNoise(() => providerOn(client).create({ image: "ubuntu:24.04" }));

  assertEqual(state.deletes, 1, "the delete was attempted on the dead winner");
  assertEqual(state.snapshotCreateCalls, 0, "a refused delete never leads to a build over the corpse");
  assertEqual(state.createParams?.image, "ubuntu:24.04", "the run ends on the direct pull");
}

async function testDeleteRaceLoserStillBuilds(): Promise<void> {
  console.log("\n[6aq] deleteDeadSnapshot() - LOSING a heal race is a success, not a demotion");

  // Two healers meet the same corpse. The loser's delete answers not-found,
  // which means the removal is done or under way by someone else — the outcome
  // it wanted. Reading that as a failure made the loser skip its build and eat
  // the slow pull, which is worse than the pre-heal behaviour.
  let gets = 0;
  const { client, state } = createDeadSnapshotClient([{ state: "error", name: "ubuntu:24.04" }], {
    deleteError: new Error("404: snapshot not found"),
  });
  const raced = {
    ...client,
    snapshot: {
      ...client.snapshot,
      get: async () => {
        gets++;
        if (gets === 1) return { state: "error", name: "ubuntu:24.04" };
        throw new Error("404: snapshot not found"); // the winner already cleared it
      },
    },
  };
  await silenceNoise(() => providerOn(raced).create({ image: "ubuntu:24.04" }));

  assertEqual(state.snapshotCreateCalls, 1, "the loser still builds the name it is entitled to");
  assertEqual(state.createParams?.snapshot, "ubuntu:24.04", "and boots from that snapshot, not a pull");
}

async function testProviderCanRebuildSnapshotRule(): Promise<void> {
  console.log("\n[6ai] providerCanRebuildSnapshot() - deletable means REBUILDABLE, judged on the RESOLVED ref");

  // Daytona's builder requires a tag or digest and rejects latest/lts/stable
  // (https://www.daytona.io/docs/en/snapshots/), so those are the only refs we
  // may destroy in order to remake.
  for (const rebuildable of [
    `evolve-all-${EVOLVE_IMAGE_VERSION}`, // IMAGE_MAP -> evolvingmachines/evolve-all:<version>
    "ubuntu:24.04",
    "ghcr.io/org/img:v1",
    "905418019965.dkr.ecr.us-west-2.amazonaws.com/x:tag",
    // A REAL 64-hex digest. The old 16-hex fixture was parsed as a TAG, so the
    // digest branch was never exercised and reverting its regex stayed green.
    "ubuntu@sha256:5d3c1a2b4e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
    "ghcr.io/org/img@sha256:5d3c1a2b4e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
    "localhost:5000/img:v1",
  ]) {
    assert(_testProviderCanRebuildSnapshot(rebuildable), `"${rebuildable}" is rebuildable`);
  }

  // PRESERVED. Every one of these would be destroyed by a delete this provider
  // could not undo — including the platform's OWN legacy alias, whose IMAGE_MAP
  // entry resolves to an UNTAGGED ref that Daytona refuses to build. Testing
  // the name rather than the resolved ref got exactly this case wrong.
  for (const preserved of [
    "evolve-all", // IMAGE_MAP -> evolvingmachines/evolve-all, untagged
    "ghcr.io/org/img", // registry path, no tag
    "localhost:5000/img", // a PORT is not a tag
    "ubuntu:latest",
    "ubuntu:lts",
    "ubuntu:stable",
    "team@prod", // an '@' is not a digest
    "ubuntu@sha256:0123456789abcdef", // too short to be one either
    "eval-env-cafe", // the eval platform heals its own aliases
    "my-team-env",
  ]) {
    assert(!_testProviderCanRebuildSnapshot(preserved), `"${preserved}" is NOT ours to delete`);
  }

  // The untagged legacy alias really is in IMAGE_MAP — the trap is real, not hypothetical.
  assert(_testImageMap["evolve-all"] !== undefined, "evolve-all IS an IMAGE_MAP key");
  assert(
    !_testImageMap["evolve-all"].includes(":"),
    "and it resolves to an UNTAGGED ref, which is why the name alone could not decide this"
  );
}

async function testConflictWaitsThenReusesWinner(): Promise<void> {
  console.log("\n[6m] DaytonaProvider.create() - name conflict: wait for the winner, then reuse it");

  // Fast path misses, our own create loses the name, the winner is still
  // building, and it lands active — the sandbox must come FROM the snapshot.
  const { client, state } = createConflictClient([
    null, // fast path: snapshot not found yet
    { state: "pulling" },
    { state: "pulling" },
    { state: "active" },
  ]);
  const provider = new FastConflictProvider({ apiKey: "test-key" });
  (provider as unknown as { client: unknown }).client = client;

  const instance = await silenceNoise(() => provider.create({ image: "eval-env-cafe" }));
  assertEqual(instance.sandboxId, "sb-from-snapshot", "the sandbox is created from the winner's snapshot");
  assertEqual(state.createParams?.snapshot, "eval-env-cafe", "create names the snapshot, not a raw image");
  assertEqual(state.createParams?.image, undefined, "the slow direct image pull is never reached");
  assertEqual(state.snapshotCreateCalls, 1, "the losing build is attempted exactly once");
  assertEqual(state.gets, 4, "the wait polls until the winner reports active");
}

async function testConflictWinnerFailureFallsBackToDirectPull(): Promise<void> {
  console.log("\n[6n] DaytonaProvider.create() - the winner's build dies: direct pull is still the fallback");

  // Terminal failure is the ONE case a direct pull is still right: nobody is
  // going to produce this snapshot, so waiting longer buys nothing.
  const { client, state } = createConflictClient([
    null,
    { state: "pulling" },
    { state: "build_failed" },
  ]);
  const provider = new FastConflictProvider({ apiKey: "test-key" });
  (provider as unknown as { client: unknown }).client = client;

  const instance = await silenceNoise(() => provider.create({ image: "eval-env-cafe" }));
  assertEqual(instance.sandboxId, "sb-direct-pull", "the fallback path produces the sandbox");
  assertEqual(state.createParams?.image, "eval-env-cafe", "the fallback pulls the image directly");
  assertEqual(state.createParams?.snapshot, undefined, "no snapshot is named on the fallback create");
}

async function testConflictTimeoutIsFinalNotADirectPull(): Promise<void> {
  console.log("\n[6o] DaytonaProvider.create() - a winner that never finishes is a loud error, not a second build");

  // A build that is still running is not a reason to run a second copy of it:
  // that doubles the spend and hides the incident behind a slow success.
  const { client, state } = createConflictClient([null, { state: "pulling" }]);
  // Every later poll keeps answering "pulling" until the budget runs out.
  client.snapshot.get = async () => {
    state.gets++;
    return state.gets === 1 ? Promise.reject(new Error("not found")) : { state: "pulling" };
  };
  const provider = new FastConflictProvider({ apiKey: "test-key" });
  (provider as unknown as { client: unknown }).client = client;

  let error: unknown;
  try {
    await silenceNoise(() => provider.create({ image: "eval-env-cafe" }));
  } catch (e) {
    error = e;
  }
  assert(error instanceof DaytonaSnapshotConflictError, "the exhausted wait throws DaytonaSnapshotConflictError");
  assert(String(error).includes("eval-env-cafe"), "the error names the contended snapshot");
  assert(String(error).includes("pulling"), "the error reports the winner's last observed state");
  assertEqual(state.createParams, undefined, "no sandbox is created — neither from snapshot nor by direct pull");
}

async function testConflictWithResourcesPullsDirectlyWithThatSizing(): Promise<void> {
  console.log("\n[6p] DaytonaProvider.create() - conflict + declared sizing: direct pull that HONOURS the sizing");

  // The winner's snapshot pins ITS resources, so joining the race would hand
  // back a box that quietly ignores this caller's request. The direct pull
  // takes the request — and it is what this case has always done.
  const { client, state } = createConflictClient([null, { state: "active" }]);
  const provider = new FastConflictProvider({ apiKey: "test-key" });
  (provider as unknown as { client: unknown }).client = client;

  const instance = await silenceNoise(() =>
    provider.create({ image: "eval-env-cafe", resources: { cpu: 8, memory: 16 } })
  );
  assertEqual(instance.sandboxId, "sb-direct-pull", "the sandbox comes from the direct image pull");
  assertEqual(state.createParams?.image, "eval-env-cafe", "the fallback pulls the image directly");
  assertEqual(state.createParams?.resources?.cpu, 8, "the caller's cpu request survives");
  assertEqual(state.createParams?.resources?.memory, 16, "and so does the memory request");
  assertEqual(state.gets, 1, "no wait is spent on a build that cannot carry this sizing");
}

async function testInFlightBuildIsJoinedWithoutASecondCreate(): Promise<void> {
  console.log("\n[6x] DaytonaProvider.create() - a snapshot already mid-build is joined, never re-created");

  // The fast-path GET already knows a build is running: calling snapshot.create
  // here can only lose the name, and an answer that is NOT a 409 leaves the SDK
  // polling that build with no budget of ours at all.
  let gets = 0;
  let snapshotCreateCalls = 0;
  let createParams: { snapshot?: string; image?: string } | undefined;
  const provider = new FastConflictProvider({ apiKey: "test-key" });
  (provider as unknown as { client: unknown }).client = {
    snapshot: {
      get: async () => {
        gets++;
        return gets === 1 ? { state: "pending" } : { state: "active" };
      },
      create: async () => {
        snapshotCreateCalls++;
        throw new Error("MARKER_SECOND_BUILD_STARTED");
      },
    },
    create: async (params: { snapshot?: string; image?: string }) => {
      createParams = params;
      return { id: "sb-joined" };
    },
  };

  const instance = await silenceNoise(() => provider.create({ image: "eval-env-cafe" }));
  assertEqual(instance.sandboxId, "sb-joined", "the sandbox comes from the build that was already running");
  assertEqual(snapshotCreateCalls, 0, "no second build is started");
  assertEqual(createParams?.snapshot, "eval-env-cafe", "the sandbox is created from the snapshot");
  assertEqual(createParams?.image, undefined, "and never by direct pull");
}

async function testInFlightBuildWithResourcesPullsDirectly(): Promise<void> {
  console.log("\n[6y] DaytonaProvider.create() - mid-build + declared sizing: straight to the direct pull");

  let gets = 0;
  let snapshotCreateCalls = 0;
  let createParams: { image?: string; resources?: { cpu?: number } } | undefined;
  const provider = new FastConflictProvider({ apiKey: "test-key" });
  (provider as unknown as { client: unknown }).client = {
    snapshot: {
      get: async () => {
        gets++;
        return { state: "building" };
      },
      create: async () => {
        snapshotCreateCalls++;
        throw new Error("MARKER_SECOND_BUILD_STARTED");
      },
    },
    create: async (params: { image?: string; resources?: { cpu?: number } }) => {
      createParams = params;
      return { id: "sb-direct-pull" };
    },
  };

  const instance = await silenceNoise(() =>
    provider.create({ image: "eval-env-cafe", resources: { cpu: 8 } })
  );
  assertEqual(instance.sandboxId, "sb-direct-pull", "the caller gets a box built to the requested size");
  assertEqual(createParams?.resources?.cpu, 8, "the sizing request survives");
  assertEqual(snapshotCreateCalls, 0, "no doomed snapshot build is attempted");
  assertEqual(gets, 1, "and no wait is spent on a build that cannot carry this sizing");
}

async function testConflictWinnerFoundInactiveIsReactivatedAndReused(): Promise<void> {
  console.log("\n[6z] DaytonaProvider.create() - a winner found asleep is reactivated, not rebuilt");

  // Daytona deactivates a snapshot unused for two weeks, so a build that won
  // the name long ago can be found inactive. Exists-but-inactive is HEALED
  // here for the same reason the fast path heals it.
  let gets = 0;
  let activateCalls = 0;
  let createParams: { snapshot?: string; image?: string } | undefined;
  const provider = new FastConflictProvider({ apiKey: "test-key" });
  (provider as unknown as { client: unknown }).client = {
    snapshot: {
      get: async () => {
        gets++;
        if (gets === 1) throw new Error("snapshot not found");
        return gets === 2 ? { state: "inactive" } : { state: "active" };
      },
      activate: async () => {
        activateCalls++;
        return { state: "active" };
      },
      create: async () => {
        throw new Error('Snapshot with name "eval-env-cafe" already exists');
      },
    },
    create: async (params: { snapshot?: string; image?: string }) => {
      createParams = params;
      return { id: "sb-reactivated" };
    },
  };

  const instance = await silenceNoise(() => provider.create({ image: "eval-env-cafe" }));
  assertEqual(instance.sandboxId, "sb-reactivated", "the sandbox comes from the reactivated snapshot");
  assertEqual(activateCalls, 1, "the sleeping winner is activated exactly once");
  assertEqual(createParams?.snapshot, "eval-env-cafe", "and the sandbox is created from it");
  assertEqual(createParams?.image, undefined, "no direct pull is needed");
}

async function testCleanBuildPathIsUnchanged(): Promise<void> {
  console.log("\n[6q] DaytonaProvider.create() - no conflict: the build path is untouched");

  let gets = 0;
  let snapshotCreateCalls = 0;
  let createParams: { snapshot?: string; image?: string } | undefined;
  const provider = new FastConflictProvider({ apiKey: "test-key" });
  (provider as unknown as { client: unknown }).client = {
    snapshot: {
      get: async () => {
        gets++;
        throw new Error("snapshot not found");
      },
      create: async () => {
        snapshotCreateCalls++;
        return {};
      },
    },
    create: async (params: { snapshot?: string; image?: string }) => {
      createParams = params;
      return { id: "sb-built" };
    },
  };

  const instance = await silenceNoise(() => provider.create({ image: "eval-env-cafe" }));
  assertEqual(instance.sandboxId, "sb-built", "a clean build still produces the sandbox");
  assertEqual(snapshotCreateCalls, 1, "the snapshot is built once");
  assertEqual(createParams?.snapshot, "eval-env-cafe", "the sandbox is created from the fresh snapshot");
  assertEqual(gets, 1, "no conflict wait is entered when nothing conflicted");
}

async function testNonConflictBuildFailureStillFallsBack(): Promise<void> {
  console.log("\n[6r] DaytonaProvider.create() - a non-conflict build failure keeps the old fallback");

  // Quota, credentials, a bad image: unchanged behavior, and no ten-minute
  // wait for a winner that does not exist.
  const { client, state } = createConflictClient([null, { state: "active" }], {
    createError: new Error("insufficient quota for snapshot build"),
  });
  const provider = new FastConflictProvider({ apiKey: "test-key" });
  (provider as unknown as { client: unknown }).client = client;

  const instance = await silenceNoise(() => provider.create({ image: "eval-env-cafe" }));
  assertEqual(instance.sandboxId, "sb-direct-pull", "the direct image fallback still runs");
  assertEqual(state.createParams?.image, "eval-env-cafe", "the fallback pulls the image directly");
  assertEqual(state.gets, 1, "no conflict wait is spent on a failure that is not a race");
}

async function testWaitPollsTransitionalStatesToActive(): Promise<void> {
  console.log("\n[6s] waitForSnapshotConflictWinner() - transitional states are polled through to active");

  const states = ["pending", "pulling", "active"];
  let gets = 0;
  const client = { snapshot: { get: async () => ({ state: states[gets++] }) } };

  const result = await silenceNoise(() =>
    _testWaitForSnapshotConflictWinner(client, "evolve-all", { timeoutMs: 5_000, pollMs: 1 })
  );
  assertEqual(result.state, "active", "the wait ends on the active state");
  assertEqual(gets, 3, "each poll asks the API again");
}

async function testWaitReturnsTerminalFailureRatherThanThrowing(): Promise<void> {
  console.log("\n[6t] waitForSnapshotConflictWinner() - a dead winner is REPORTED, so the caller can fall back");

  for (const dead of ["error", "build_failed"]) {
    const client = { snapshot: { get: async () => ({ state: dead }) } };
    const result = await silenceNoise(() =>
      _testWaitForSnapshotConflictWinner(client, "evolve-all", { timeoutMs: 5_000, pollMs: 1 })
    );
    assertEqual(result.state, dead, `state "${dead}" is returned, not thrown`);
  }
}

async function testWaitOnlyWaitsOnInFlightStates(): Promise<void> {
  console.log("\n[6aa] waitForSnapshotConflictWinner() - only a build IN FLIGHT is worth waiting for");

  // The wait is a whitelist, not a blacklist of known failures: "inactive" is
  // reusable after reactivation, "removing" is gone, and a state Daytona has
  // not invented yet must not poll a doomed name for the full budget.
  for (const resolved of ["inactive", "removing", "some_new_daytona_state"]) {
    let gets = 0;
    const client = {
      snapshot: {
        get: async () => {
          gets++;
          return { state: resolved };
        },
      },
    };
    const result = await silenceNoise(() =>
      _testWaitForSnapshotConflictWinner(client, "evolve-all", { timeoutMs: 5_000, pollMs: 1 })
    );
    assertEqual(result.state, resolved, `state "${resolved}" resolves the wait`);
    assertEqual(gets, 1, `and "${resolved}" is answered on the first poll, never waited out`);
  }

  // The in-flight states, by contrast, are exactly what the wait is for.
  for (const inFlight of ["pending", "pulling", "building", "snapshotting"]) {
    let gets = 0;
    const client = {
      snapshot: {
        get: async () => {
          gets++;
          return { state: gets < 3 ? inFlight : "active" };
        },
      },
    };
    const result = await silenceNoise(() =>
      _testWaitForSnapshotConflictWinner(client, "evolve-all", { timeoutMs: 5_000, pollMs: 1 })
    );
    assertEqual(result.state, "active", `state "${inFlight}" is waited through to active`);
    assertEqual(gets, 3, `and "${inFlight}" keeps polling while the build runs`);
  }
}

async function testWaitEndsEarlyOnAuthFailure(): Promise<void> {
  console.log("\n[6ab] waitForSnapshotConflictWinner() - rejected credentials end the wait at once");

  // A 401 does not become a 200 in nine more minutes, and this wait has no
  // outer retry to catch it — burning the budget would only hide the cause.
  for (const refusal of [
    { status: 401, message: "Unauthorized" },
    { response: { status: 403 }, message: "nope" },
    new Error("Request failed with status code 401"),
  ]) {
    let gets = 0;
    const client = {
      snapshot: {
        get: async () => {
          gets++;
          throw refusal;
        },
      },
    };

    let error: unknown;
    try {
      await silenceNoise(() =>
        _testWaitForSnapshotConflictWinner(client, "evolve-all", { timeoutMs: 5_000, pollMs: 1 })
      );
    } catch (e) {
      error = e;
    }
    assert(error instanceof DaytonaSnapshotConflictError, "an auth refusal throws the typed error");
    assert(String(error).includes("cannot read the snapshot"), "and says the credentials are the problem");
    assertEqual(gets, 1, "the wait stops on the first refusal");
  }
}

async function testWaitEndsAfterRepeatedIdenticalFailures(): Promise<void> {
  console.log("\n[6ac] waitForSnapshotConflictWinner() - a control plane that keeps failing the same way ends the wait");

  let gets = 0;
  const client = {
    snapshot: {
      get: async () => {
        gets++;
        throw new Error("connect ECONNREFUSED");
      },
    },
  };

  let error: unknown;
  try {
    await silenceNoise(() =>
      _testWaitForSnapshotConflictWinner(client, "evolve-all", { timeoutMs: 60_000, pollMs: 1 })
    );
  } catch (e) {
    error = e;
  }
  assert(error instanceof DaytonaSnapshotConflictError, "three identical failures throw the typed error");
  assert(String(error).includes("ECONNREFUSED"), "the cause survives in the message");
  assertEqual(gets, 3, "and the wait stops there rather than running to its deadline");
}

async function testWaitToleratesTransientPollFailures(): Promise<void> {
  console.log("\n[6u] waitForSnapshotConflictWinner() - a failed poll is retried, not fatal");

  // Unlike the activation poll, a GET failure here is expected: the winner's
  // record can be briefly unreadable mid-build.
  let gets = 0;
  const client = {
    snapshot: {
      get: async () => {
        gets++;
        if (gets < 3) throw new Error("socket hang up");
        return { state: "active" };
      },
    },
  };

  const result = await silenceNoise(() =>
    _testWaitForSnapshotConflictWinner(client, "evolve-all", { timeoutMs: 5_000, pollMs: 1 })
  );
  assertEqual(result.state, "active", "the wait survives transient poll failures");
  assertEqual(gets, 3, "and keeps polling until the winner answers");
}

async function testWaitIsBoundedByItsBudget(): Promise<void> {
  console.log("\n[6v] waitForSnapshotConflictWinner() - the wait is bounded and says what it saw");

  const client = { snapshot: { get: async () => ({ state: "building" }) } };

  let error: unknown;
  try {
    await silenceNoise(() =>
      _testWaitForSnapshotConflictWinner(client, "evolve-all", { timeoutMs: 0, pollMs: 1 })
    );
  } catch (e) {
    error = e;
  }
  assert(error instanceof DaytonaSnapshotConflictError, "the exhausted budget throws the typed error");
  assert(String(error).includes("evolve-all"), "the error names the snapshot");
  assert(String(error).includes("building"), "the error reports the last observed state");
  assert(String(error).includes("0ms"), "the error states the bound that was exceeded");
}

async function testConflictDetection(): Promise<void> {
  console.log("\n[6w] isSnapshotNameConflict() - what counts as a lost name race");

  // Harbor decides on the same two substrings (snapshots.py:281-283); the HTTP
  // status is what the TS SDK adds on top.
  assert(_testIsSnapshotNameConflict(new Error("Snapshot already exists")), '"already exists" is a conflict');
  assert(_testIsSnapshotNameConflict(new Error("ALREADY EXISTS")), "the match is case-insensitive");
  assert(_testIsSnapshotNameConflict(new Error("409 Conflict")), '"conflict" is a conflict');
  assert(_testIsSnapshotNameConflict({ status: 409, message: "nope" }), "a 409 status is a conflict");
  assert(_testIsSnapshotNameConflict({ statusCode: 409 }), "statusCode is read too");
  assert(_testIsSnapshotNameConflict({ response: { status: 409 } }), "so is response.status");

  assert(!_testIsSnapshotNameConflict(new Error("insufficient quota")), "a quota failure is not a race");
  assert(!_testIsSnapshotNameConflict(new Error("build 409abc failed")), "a stray 409 in text is not a race");
  assert(!_testIsSnapshotNameConflict({ status: 500 }), "a server error is not a race");
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

// =============================================================================
// [8] Runtime network switching — replace semantics and the org tier gate
// =============================================================================

async function testUpdateMapperClearsStaleAllowlists(): Promise<void> {
  console.log("\n[8a] the update path states every field, so nothing stale survives");

  // At create an omitted field is simply unset. On a box that already HAS a
  // policy, an omitted field keeps its old value — which is how a switch to a
  // narrow policy can silently leave a wide allowlist in force.
  assertEqual(
    await _testMapNetworkPolicyForUpdate({
      outbound: "blocked",
      allowedDestinations: ["10.1.2.0/24"],
    }),
    { networkBlockAll: false, networkAllowList: "10.1.2.0/24", domainAllowList: "" },
    "a CIDR allowlist clears the domain allowlist it replaces"
  );
  assertEqual(
    await _testMapNetworkPolicyForUpdate({ outbound: "blocked" }),
    { networkBlockAll: true, networkAllowList: "", domainAllowList: "" },
    "sealing the box clears both allowlists rather than leaving them behind"
  );
  assertEqual(
    await _testMapNetworkPolicyForUpdate({ outbound: "open" }),
    { networkBlockAll: false, networkAllowList: "", domainAllowList: "" },
    "opening the box clears both — a leftover list would narrow an open policy"
  );
}

async function testUpdateMapperKeepsCreateRefusals(): Promise<void> {
  console.log("\n[8b] the update path refuses exactly what create refuses");

  for (const destination of ["2001:db8::1", "*.example.com", "example.com:8443"]) {
    let err: unknown;
    try {
      await _testMapNetworkPolicyForUpdate({
        outbound: "blocked",
        allowedDestinations: [destination],
      });
    } catch (e) {
      err = e;
    }
    assert(
      err instanceof DaytonaNetworkPolicyError,
      `"${destination}" is refused on the update path too, with the typed error`
    );
  }
}

async function testTierRefusalIsNarrow(): Promise<void> {
  console.log("\n[8c] the tier verdict needs real evidence, never a bare 403");

  assert(
    _testIsNetworkPolicyTierRefusal(
      Object.assign(new Error("Organization tier does not permit network policy override"), {
        status: 403,
      })
    ),
    "403 naming the tier AND network policy is the tier gate"
  );
  assert(
    _testIsNetworkPolicyTierRefusal(
      new Error("Cannot override network policy at the sandbox level on this plan")
    ),
    "unmistakable language alone is enough, even with no status"
  );

  // The case that matters most: a revoked key is also a 403, and calling it a
  // tier problem sends the caller to the billing page over a credential.
  assert(
    !_testIsNetworkPolicyTierRefusal(
      Object.assign(new Error("Unauthorized"), { status: 403 })
    ),
    "a bare 403 stays unclassified and propagates verbatim"
  );
  assert(
    !_testIsNetworkPolicyTierRefusal(new Error("connect ETIMEDOUT")),
    "a transport failure is not a tier verdict"
  );
  assert(
    !_testIsNetworkPolicyTierRefusal(
      Object.assign(new Error("Sandbox not found"), { status: 404 })
    ),
    "a missing sandbox is not a tier verdict"
  );
}

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
  testCreateForwardsGpuTypesOnBuild,
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
  // [6.6] wait-on-conflict
  testConflictWaitsThenReusesWinner,
  testConflictWinnerFailureFallsBackToDirectPull,
  testConflictTimeoutIsFinalNotADirectPull,
  testConflictWithResourcesPullsDirectlyWithThatSizing,
  testInFlightBuildIsJoinedWithoutASecondCreate,
  testInFlightBuildWithResourcesPullsDirectly,
  testConflictWinnerFoundInactiveIsReactivatedAndReused,
  testCleanBuildPathIsUnchanged,
  testNonConflictBuildFailureStillFallsBack,
  testWaitPollsTransitionalStatesToActive,
  testWaitReturnsTerminalFailureRatherThanThrowing,
  testWaitOnlyWaitsOnInFlightStates,
  testWaitEndsEarlyOnAuthFailure,
  testWaitEndsAfterRepeatedIdenticalFailures,
  testWaitToleratesTransientPollFailures,
  testWaitIsBoundedByItsBudget,
  testConflictDetection,
  // [6.7] dead snapshots are deleted, then rebuilt
  testDeadSnapshotIsDeletedThenRebuilt,
  testDeadSnapshotDeletePassesTheRecordItRead,
  testUnrebuildableDeadNameIsPreserved,
  testDeadSnapshotDeleteFailureFallsBackInsteadOfThrowing,
  testDeadWinnerOfAJoinIsClearedThenBuilt,
  testMissingSnapshotMidWaitIsAnAnswerNotAFailure,
  testVanishedNameIsBuiltRatherThanPulled,
  testHealedRebuildIsTriedOnceAndNeverLoops,
  testDeleteConfirmationWaitsForTheRecordToVanish,
  testDeleteConfirmationGivesUpOnItsOwnBudget,
  testDeletePollTreatsOnlyNotFoundAsGone,
  testJoinPathDeleteRefusedFallsBack,
  testDeleteRaceLoserStillBuilds,
  testProviderCanRebuildSnapshotRule,
  // [7] DaytonaCommands
  testCommandsRunAsRootUsesSudoWrapper,
  testCommandsRunDefaultUserNoWrapper,
  testCommandsSpawnRootWrapper,
  testSpawnWaitDistinguishesSandboxFromSession,
  testAutoDeleteGrace,
  // [8] runtime network switching
  testUpdateMapperClearsStaleAllowlists,
  testUpdateMapperKeepsCreateRefusals,
  testTierRefusalIsNarrow,
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
