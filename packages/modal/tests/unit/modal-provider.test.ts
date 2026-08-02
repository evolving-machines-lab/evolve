#!/usr/bin/env tsx
/**
 * Unit Test: Modal Provider — command wrapping, network policy, image
 * registry routing, tags-based info, lifetime cap, and enforcement wiring
 *
 * Tests:
 *   1. wrapCommand() — pure function: root vs su wrapper, cwd, envs, escaping
 *   2. mapNetworkPolicy() — Evolve network policy → Modal create() params
 *   3. resolveImageRegistry() — ECR / GCP Artifact Registry / generic detection
 *   4. buildSandboxInfo() — tags → SandboxInfo, no fabricated timestamps
 *   5. validateTimeout() — Modal's hard 24h lifetime cap (typed error)
 *   5b. mapIdleTimeout() — the idle bound: absent by default, refused rather
 *      than clamped when nonsensical (Modal is the only provider with both an
 *      absolute lifetime and an inactivity timer)
 *   6. ModalProvider.create() — offline validation order (cap + network fire
 *      before any network call; user option no longer rejected)
 *   7. ModalCommands — exec args carry the su wrapper / root passthrough
 *   8. ModalFiles — chown to sandbox user, skipped for root
 *   8x. ModalFiles.read() — text-vs-binary decided by content (NUL sniff +
 *      strict UTF-8), never by extension; byte-exact on both branches
 *
 * Usage:
 *   npx tsx tests/unit/modal-provider.test.ts
 */

import {
  _testWrapCommand,
  _testImageMap,
  _testMapNetworkPolicy,
  _testResolveImageRegistry,
  _testBuildSandboxInfo,
  _testValidateTimeout,
  _testMapIdleTimeout,
  _testMapResources,
  EVOLVE_IMAGE_VERSION,
  MODAL_MAX_LIFETIME_MS,
  MODAL_STDIN_CHUNK_BYTES,
  ModalIdleTimeoutError,
  ModalSandboxLifetimeError,
  ModalNetworkPolicyError,
  ModalResourcesError,
  ModalCommands,
  ModalFiles,
  createModalProvider,
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

/** Decode the base64 payload of a `su <user> -c "echo <b64> | base64 -d | bash"` wrapper. */
function decodeSuPayload(args: string[]): string {
  const match = /^echo (\S+) \| base64 -d \| bash$/.exec(args[3]);
  if (!match) return `<unparseable: ${args[3]}>`;
  return Buffer.from(match[1], "base64").toString("utf-8");
}

// =============================================================================
// [1] wrapCommand() — Pure Function Tests
// =============================================================================

async function testWrapCommandRootPassthrough(): Promise<void> {
  console.log("\n[1a] wrapCommand() - root runs directly via bash -c (no su)");

  assertEqual(
    _testWrapCommand("echo hello", "root"),
    ["bash", "-c", "echo hello"],
    "Root: plain command passes through bash -c"
  );
  assertEqual(
    _testWrapCommand("echo hello", "root", "/workspace", { FOO: "bar" }),
    ["bash", "-c", "cd '/workspace' && export FOO='bar'; echo hello"],
    "Root: cwd + envs are inlined, still no su wrapper"
  );
}

async function testWrapCommandSuWrapper(): Promise<void> {
  console.log("\n[1b] wrapCommand() - non-root uses su <user> -c with base64 payload");

  const args = _testWrapCommand("echo hello", "user");
  assertEqual(args.slice(0, 3), ["su", "user", "-c"], "argv starts with su user -c");
  assertEqual(decodeSuPayload(args), "echo hello", "Base64 payload decodes to the command");
}

async function testWrapCommandParameterizedUser(): Promise<void> {
  console.log("\n[1c] wrapCommand() - user is parameterized (not hardcoded)");

  const args = _testWrapCommand("whoami", "worker");
  assertEqual(args[1], "worker", "su targets the configured user");
  assertEqual(decodeSuPayload(args), "whoami", "Payload unchanged for custom user");
}

async function testWrapCommandCwdAndEnvs(): Promise<void> {
  console.log("\n[1d] wrapCommand() - cwd + envs inlined inside the su payload");

  const args = _testWrapCommand("echo $VAR", "user", "/workspace", { VAR: "value" });
  assertEqual(
    decodeSuPayload(args),
    "cd '/workspace' && export VAR='value'; echo $VAR",
    "cd comes first, then exports, then command"
  );
}

async function testWrapCommandEscaping(): Promise<void> {
  console.log("\n[1e] wrapCommand() - single-quote escaping in cwd and env values");

  const args = _testWrapCommand("ls", "user", "/home/user/it's a dir", { MSG: "it's fine" });
  assertEqual(
    decodeSuPayload(args),
    "cd '/home/user/it'\\''s a dir' && export MSG='it'\\''s fine'; ls",
    "Single quotes escaped with '\\'' pattern in cwd and env values"
  );
}

async function testWrapCommandEnvFiltering(): Promise<void> {
  console.log("\n[1f] wrapCommand() - envs filter out null/undefined values");

  const envs: Record<string, string> = { KEEP: "yes" };
  (envs as any).SKIP_NULL = null;
  (envs as any).SKIP_UNDEF = undefined;

  const payload = decodeSuPayload(_testWrapCommand("env", "user", undefined, envs));
  assert(payload.includes("export KEEP='yes'"), "KEEP is included");
  assert(!payload.includes("SKIP_NULL"), "null value is filtered out");
  assert(!payload.includes("SKIP_UNDEF"), "undefined value is filtered out");
}

async function testWrapCommandComplexQuoting(): Promise<void> {
  console.log("\n[1g] wrapCommand() - complex command survives base64 round-trip");

  const command = `python -c "print('hello \\"world\\"')" && echo 'done'`;
  const payload = decodeSuPayload(_testWrapCommand(command, "user"));
  assertEqual(payload, command, "Nested quotes preserved exactly through base64");
}

async function testWrapCommandNonStringEnv(): Promise<void> {
  console.log("\n[1h] wrapCommand() - non-string env values are coerced with String(v)");

  const envs: Record<string, string> = { PORT: "9000" };
  (envs as any).RETRIES = 3; // a number reaching envs via `as any`
  (envs as any).ENABLED = true; // a boolean

  const payload = decodeSuPayload(_testWrapCommand("env", "user", undefined, envs));
  assert(payload.includes("export PORT='9000'"), "String value passes through");
  assert(payload.includes("export RETRIES='3'"), "Number value coerced, does not throw on .replace");
  assert(payload.includes("export ENABLED='true'"), "Boolean value coerced");
}

// =============================================================================
// [2] mapNetworkPolicy() — Evolve policy → Modal create params
// =============================================================================

async function testNetworkNoPolicy(): Promise<void> {
  console.log("\n[2a] mapNetworkPolicy() - no policy / open outbound");

  assertEqual(_testMapNetworkPolicy(undefined), {}, "No policy → no Modal network params");
  assertEqual(_testMapNetworkPolicy({ outbound: "open" }), {}, "Open outbound → no Modal network params");
}

async function testNetworkOpenWithDestinationsThrows(): Promise<void> {
  console.log("\n[2b] mapNetworkPolicy() - open + allowedDestinations is rejected");

  let threw = false;
  try {
    _testMapNetworkPolicy({ outbound: "open", allowedDestinations: ["api.example.com"] });
  } catch (error) {
    threw = String(error).includes("only valid when outbound is blocked");
  }
  assert(threw, "Throws the same validation error as the E2B provider");
}

async function testNetworkBlockedAll(): Promise<void> {
  console.log("\n[2c] mapNetworkPolicy() - blocked with no allowlist → blockNetwork");

  assertEqual(
    _testMapNetworkPolicy({ outbound: "blocked" }),
    { blockNetwork: true },
    "Blocked outbound maps to blockNetwork: true"
  );
  assertEqual(
    _testMapNetworkPolicy({ outbound: "blocked", allowedDestinations: [] }),
    { blockNetwork: true },
    "Empty allowedDestinations also maps to blockNetwork: true"
  );
}

async function testNetworkDomainAllowlist(): Promise<void> {
  console.log("\n[2d] mapNetworkPolicy() - hostnames → outboundDomainAllowlist");

  assertEqual(
    _testMapNetworkPolicy({ outbound: "blocked", allowedDestinations: ["api.anthropic.com", "*.openai.com"] }),
    { outboundCidrAllowlist: [], outboundDomainAllowlist: ["api.anthropic.com", "*.openai.com"] },
    "Hostnames (incl. wildcards) go to the domain allowlist; CIDR list set empty (allow none)"
  );
}

async function testNetworkCidrAllowlist(): Promise<void> {
  console.log("\n[2e] mapNetworkPolicy() - IPs and CIDRs → outboundCidrAllowlist");

  assertEqual(
    _testMapNetworkPolicy({ outbound: "blocked", allowedDestinations: ["10.0.0.0/8", "192.168.1.5"] }),
    { outboundCidrAllowlist: ["10.0.0.0/8", "192.168.1.5/32"], outboundDomainAllowlist: [] },
    "CIDRs pass through; bare IPv4 gets /32; domain list set empty (allow none)"
  );
  assertEqual(
    _testMapNetworkPolicy({ outbound: "blocked", allowedDestinations: ["2001:db8::/32", "2001:db8::1"] }),
    { outboundCidrAllowlist: ["2001:db8::/32", "2001:db8::1/128"], outboundDomainAllowlist: [] },
    "IPv6 CIDRs pass through; bare IPv6 gets /128"
  );
}

async function testNetworkMixedAllowlist(): Promise<void> {
  console.log("\n[2f] mapNetworkPolicy() - mixed destinations split by kind");

  assertEqual(
    _testMapNetworkPolicy({
      outbound: "blocked",
      allowedDestinations: ["api.anthropic.com", "10.1.2.3", "172.16.0.0/12"],
    }),
    {
      outboundCidrAllowlist: ["10.1.2.3/32", "172.16.0.0/12"],
      outboundDomainAllowlist: ["api.anthropic.com"],
    },
    "Hostnames and IPs/CIDRs are routed to their respective allowlists"
  );
}

async function testNetworkPortRejected(): Promise<void> {
  console.log("\n[2g] mapNetworkPolicy() - host:port / ip:port are typed-rejected (not read as IPv6)");

  for (const dest of ["example.com:443", "1.2.3.4:8080"]) {
    let error: unknown;
    try {
      _testMapNetworkPolicy({ outbound: "blocked", allowedDestinations: [dest] });
    } catch (e) {
      error = e;
    }
    assert(error instanceof ModalNetworkPolicyError, `"${dest}" throws ModalNetworkPolicyError`);
    assertEqual(
      (error as ModalNetworkPolicyError).reason,
      "port-unsupported",
      `"${dest}" reason = port-unsupported (single colon is a port, not IPv6)`
    );
    assert(
      String(error).includes("hosts and IPs only") && String(error).toLowerCase().includes("port"),
      `"${dest}" message says allowlists filter hosts/IPs only and to strip the port`
    );
    assertEqual((error as ModalNetworkPolicyError).destination, dest, "Error carries the destination");
  }
}

async function testNetworkTrueIpv6StillCidr(): Promise<void> {
  console.log("\n[2h] mapNetworkPolicy() - true IPv6 (>=2 colons / bracketed) still routes to CIDR");

  assertEqual(
    _testMapNetworkPolicy({ outbound: "blocked", allowedDestinations: ["2001:db8::1", "[2001:db8::2]"] }),
    { outboundCidrAllowlist: ["2001:db8::1/128", "[2001:db8::2]/128"], outboundDomainAllowlist: [] },
    "Multi-colon and bracketed IPv6 are not mistaken for host:port"
  );
}

async function testNetworkInvalidIpv4Rejected(): Promise<void> {
  console.log("\n[2i] mapNetworkPolicy() - out-of-range IPv4 / prefix are typed-rejected, not sent as domains");

  for (const dest of ["300.1.1.1", "10.0.0.0/40"]) {
    let error: unknown;
    try {
      _testMapNetworkPolicy({ outbound: "blocked", allowedDestinations: [dest] });
    } catch (e) {
      error = e;
    }
    assert(error instanceof ModalNetworkPolicyError, `"${dest}" throws ModalNetworkPolicyError`);
    assertEqual(
      (error as ModalNetworkPolicyError).reason,
      "invalid-ipv4",
      `"${dest}" reason = invalid-ipv4 (octets 0-255, prefix 0-32)`
    );
    assert(
      String(error).includes("0-255") && String(error).includes("0-32"),
      `"${dest}" message states the octet/prefix ranges`
    );
  }
}

// =============================================================================
// [2x] mapResources() — Evolve sizing → Modal create params
// =============================================================================

async function testMapResourcesDefaults(): Promise<void> {
  console.log("\n[2j] mapResources() - defaults preserved when no sizing declared");

  assertEqual(
    _testMapResources(undefined),
    { cpu: 4, memoryMiB: 4096 },
    "No resources → historical 4 CPU / 4096 MiB defaults"
  );
  assertEqual(
    _testMapResources({}),
    { cpu: 4, memoryMiB: 4096 },
    "Empty resources → same defaults"
  );
}

async function testMapResourcesHonored(): Promise<void> {
  console.log("\n[2k] mapResources() - cpu cores + memory GiB → cpu / memoryMiB");

  assertEqual(
    _testMapResources({ cpu: 2, memory: 8 }),
    { cpu: 2, memoryMiB: 8192 },
    "2 cores / 8 GiB → cpu 2, memoryMiB 8192"
  );
  assertEqual(
    _testMapResources({ memory: 2.5 }),
    { cpu: 4, memoryMiB: 2560 },
    "Fractional GiB rounds up in MiB (2.5 GiB → 2560 MiB), cpu keeps default"
  );
}

async function testMapResourcesDiskRejected(): Promise<void> {
  console.log("\n[2l] mapResources() - disk sizing is typed-rejected (SDK cannot express it)");

  let error: unknown;
  try {
    _testMapResources({ cpu: 2, memory: 8, disk: 20 });
  } catch (e) {
    error = e;
  }
  assert(error instanceof ModalResourcesError, "disk request throws ModalResourcesError");
  assert(
    String(error).includes("disk"),
    "message names the disk limitation"
  );
}

// =============================================================================
// [3] resolveImageRegistry() — image tag routing
// =============================================================================

async function testImageRegistryDetection(): Promise<void> {
  console.log("\n[3a] resolveImageRegistry() - registry family detection");

  assertEqual(_testResolveImageRegistry("evolvingmachines/evolve-all"), "registry", "Docker Hub image → registry");
  assertEqual(_testResolveImageRegistry("python:3.12-slim"), "registry", "Official image with tag → registry");
  assertEqual(_testResolveImageRegistry("ghcr.io/org/image:v1"), "registry", "GHCR → registry (generic path)");
  assertEqual(
    _testResolveImageRegistry("123456789012.dkr.ecr.us-east-1.amazonaws.com/evolve:prod"),
    "aws-ecr",
    "ECR host → aws-ecr"
  );
  assertEqual(
    _testResolveImageRegistry("999999999999.dkr.ecr.eu-central-1.amazonaws.com/repo"),
    "aws-ecr",
    "ECR host in another region → aws-ecr"
  );
  assertEqual(
    _testResolveImageRegistry("us-docker.pkg.dev/project/repo/image"),
    "gcp-artifact-registry",
    "Artifact Registry host → gcp-artifact-registry"
  );
  assertEqual(_testResolveImageRegistry("gcr.io/project/image"), "gcp-artifact-registry", "gcr.io → gcp-artifact-registry");
  assertEqual(
    _testResolveImageRegistry("dkr.ecr.us-east-1.amazonaws.com/repo"),
    "registry",
    "ECR-lookalike without a 12-digit account id is NOT treated as ECR"
  );
}

// =============================================================================
// [4] buildSandboxInfo() — tags → SandboxInfo
// =============================================================================

async function testSandboxInfoFromTags(): Promise<void> {
  console.log("\n[4a] buildSandboxInfo() - evolve tags extracted, user metadata preserved");

  const info = _testBuildSandboxInfo("sb-123", {
    "evolve.image": "evolvingmachines/evolve-all",
    "evolve.startedAt": "2026-07-22T01:02:03.000Z",
    runId: "run-42",
    owner: "brando",
  });

  assertEqual(info.sandboxId, "sb-123", "sandboxId passes through");
  assertEqual(info.image, "evolvingmachines/evolve-all", "Image comes from the evolve.image tag");
  assertEqual(info.startedAt, "2026-07-22T01:02:03.000Z", "startedAt comes from the evolve.startedAt tag");
  assertEqual(info.metadata, { runId: "run-42", owner: "brando" }, "Internal evolve.* tags stripped from metadata");
  assertEqual(info.endAt, undefined, "endAt is undefined (Modal exposes no end timestamp)");
}

async function testSandboxInfoForeignSandbox(): Promise<void> {
  console.log("\n[4b] buildSandboxInfo() - sandbox not created by this SDK: nothing fabricated");

  const info = _testBuildSandboxInfo("sb-foreign", { some: "tag" });
  assertEqual(info.image, "", "Image is empty, not invented");
  assertEqual(info.startedAt, "", "startedAt is empty, not a fabricated client-side timestamp");
  assertEqual(info.metadata, { some: "tag" }, "Foreign tags surface as metadata");
}

async function testSandboxInfoFallbackImage(): Promise<void> {
  console.log("\n[4c] buildSandboxInfo() - fallback image used only when tag is missing");

  const withTag = _testBuildSandboxInfo("sb-1", { "evolve.image": "tagged-image" }, "fallback-image");
  assertEqual(withTag.image, "tagged-image", "Tag wins over fallback");

  const withoutTag = _testBuildSandboxInfo("sb-2", {}, "fallback-image");
  assertEqual(withoutTag.image, "fallback-image", "Fallback (create-time image) used when tag absent");
}

// =============================================================================
// [5] validateTimeout() — 24h lifetime cap
// =============================================================================

async function testTimeoutCap(): Promise<void> {
  console.log("\n[5a] validateTimeout() - Modal's hard 24h cap");

  let error: unknown;
  try {
    _testValidateTimeout(MODAL_MAX_LIFETIME_MS + 1);
  } catch (e) {
    error = e;
  }
  assert(error instanceof ModalSandboxLifetimeError, "Over-cap timeout throws ModalSandboxLifetimeError");
  assert(String(error).includes("24h"), "Error names the 24h cap");
  assert(String(error).includes("checkpoints"), "Error points long sessions at Evolve checkpoints");
  assertEqual(
    (error as ModalSandboxLifetimeError).requestedTimeoutMs,
    MODAL_MAX_LIFETIME_MS + 1,
    "Typed error carries the requested timeout"
  );

  let threwAtCap = false;
  try {
    _testValidateTimeout(MODAL_MAX_LIFETIME_MS);
  } catch {
    threwAtCap = true;
  }
  assert(!threwAtCap, "Exactly 24h is allowed");

  let threwBelow = false;
  try {
    _testValidateTimeout(3600000);
  } catch {
    threwBelow = true;
  }
  assert(!threwBelow, "1h is allowed");
}

// =============================================================================
// [5b] mapIdleTimeout() — the idle bound, which reclaims a box whose client died
//
// Modal is the one provider with BOTH an absolute lifetime and an idle timer.
// The lifetime alone caps the loss at the full agent budget; the idle timer is
// what ends a box nobody is driving any more, long before that.
// =============================================================================

async function testIdleTimeoutUnsetIsAbsent(): Promise<void> {
  console.log("\n[5b] mapIdleTimeout() - unset spreads to nothing (Modal's default is no idle timer)");

  const params = _testMapIdleTimeout(undefined);
  assertEqual(Object.keys(params).length, 0, "No key at all, so Modal's own default stands");
  assert(!("idleTimeoutMs" in params), "Not even an explicit undefined");
}

async function testIdleTimeoutHonored(): Promise<void> {
  console.log("\n[5c] mapIdleTimeout() - a positive bound is passed through unchanged");

  assertEqual(_testMapIdleTimeout(1_800_000).idleTimeoutMs, 1_800_000, "30min passes through");
  assertEqual(_testMapIdleTimeout(1).idleTimeoutMs, 1, "The smallest positive value is allowed");
  assertEqual(
    _testMapIdleTimeout(MODAL_MAX_LIFETIME_MS).idleTimeoutMs,
    MODAL_MAX_LIFETIME_MS,
    "Exactly the 24h cap is allowed"
  );
}

async function testIdleTimeoutRejectsNonPositive(): Promise<void> {
  console.log("\n[5d] mapIdleTimeout() - zero, negative and non-finite are refused, not clamped");

  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    let error: unknown;
    try {
      _testMapIdleTimeout(bad);
    } catch (e) {
      error = e;
    }
    assert(error instanceof ModalIdleTimeoutError, `${bad} throws ModalIdleTimeoutError`);
    assertEqual(
      (error as ModalIdleTimeoutError).requestedIdleTimeoutMs,
      bad,
      `Typed error carries the requested value (${bad})`
    );
  }
}

async function testIdleTimeoutRejectsOverCap(): Promise<void> {
  console.log("\n[5e] mapIdleTimeout() - above the 24h lifetime cap it could never fire");

  let error: unknown;
  try {
    _testMapIdleTimeout(MODAL_MAX_LIFETIME_MS + 1);
  } catch (e) {
    error = e;
  }
  assert(error instanceof ModalIdleTimeoutError, "Over-cap idle timeout throws ModalIdleTimeoutError");
  assert(String(error).includes("24h"), "Error names the 24h cap");
  assert(String(error).includes("lifetime first"), "Error explains why the value is meaningless");
}

// =============================================================================
// [6] ModalProvider.create() — offline validation order + enforcement wiring
// =============================================================================

async function testCreateValidatesIdleTimeoutBeforeNetwork(): Promise<void> {
  console.log("\n[6c] ModalProvider.create() - a bad idle bound throws before any API call");

  const provider = createModalProvider({ tokenId: "test-id", tokenSecret: "test-secret" });

  // Tokens are fake, so anything that reached the network would fail with a
  // transport error instead — the typed error IS the proof it never got there.
  let error: unknown;
  try {
    await provider.create({ image: "evolve-all", timeoutMs: 3_600_000, idleTimeoutMs: 0 });
  } catch (e) {
    error = e;
  }
  assert(error instanceof ModalIdleTimeoutError, "create() enforces the idle bound offline (typed error)");
}


async function testCreateValidatesBeforeNetwork(): Promise<void> {
  console.log("\n[6a] ModalProvider.create() - cap and network validation fire before any API call");

  const provider = createModalProvider({ tokenId: "test-id", tokenSecret: "test-secret" });

  // Over-cap timeout: must throw the typed lifetime error without touching the network
  let capError: unknown;
  try {
    await provider.create({ image: "evolve-all", timeoutMs: 25 * 3600 * 1000 });
  } catch (e) {
    capError = e;
  }
  assert(capError instanceof ModalSandboxLifetimeError, "create() enforces the 24h cap offline (typed error)");

  // Invalid network combo: open + allowedDestinations
  let comboError = "";
  try {
    await provider.create({
      image: "evolve-all",
      timeoutMs: 1000,
      network: { outbound: "open", allowedDestinations: ["api.example.com"] },
    });
  } catch (e) {
    comboError = String(e);
  }
  assert(
    comboError.includes("only valid when outbound is blocked"),
    "create() rejects open + allowedDestinations with the shared validation message"
  );
}

async function testCreateNoLongerRejectsUserAndNetwork(): Promise<void> {
  console.log("\n[6b] ModalProvider.create() - user and network options are enforced, not rejected");

  const provider = createModalProvider({ tokenId: "test-id", tokenSecret: "test-secret" });

  // The old provider threw "does not yet implement" for user and network
  // before doing anything else. Now both pass validation; with an over-cap
  // timeout the typed cap error fires instead, proving neither option was
  // rejected up front.
  let error = "";
  try {
    await provider.create({
      image: "evolve-all",
      user: "worker",
      network: { outbound: "blocked", allowedDestinations: ["api.anthropic.com"] },
      timeoutMs: MODAL_MAX_LIFETIME_MS + 1,
    });
  } catch (e) {
    error = String(e);
  }
  assert(!error.includes("does not yet implement"), "No capability-rejection error for user/network");
  assert(error.includes("24h"), "Validation proceeded to the cap check (options accepted)");
}

// =============================================================================
// [7] ModalCommands — mock-based exec wiring
// =============================================================================

interface ExecCall {
  args: string[];
  params: Record<string, unknown> | undefined;
}

function createMockModalSandbox(opts?: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  stdoutBytes?: Uint8Array;
}) {
  const execCalls: ExecCall[] = [];
  const stdinWrites: Buffer[] = [];
  const stdoutText = opts?.stdout ?? "";
  const stderrText = opts?.stderr ?? "";
  const exitCode = opts?.exitCode ?? 0;

  const makeStream = (text: string, bytes?: Uint8Array) => ({
    async *[Symbol.asyncIterator]() {
      if (text) yield text;
    },
    // Like the real SDK, readText is a lossy UTF-8 decode of whatever bytes
    // the stream carries — invalid sequences become U+FFFD, never an error.
    readText: async () => (bytes ? new TextDecoder().decode(bytes) : text),
    readBytes: async () => bytes ?? new TextEncoder().encode(text),
  });

  const sandbox = {
    sandboxId: "sb-mock-1",
    exec: async (args: string[], params?: Record<string, unknown>) => {
      execCalls.push({ args, params });
      return {
        stdout: makeStream(stdoutText, opts?.stdoutBytes),
        stderr: makeStream(stderrText),
        wait: async () => exitCode,
        stdin: {
          // Each call = one gRPC TaskExecStdinWrite message on real Modal.
          // Copy the chunk: the source may be a subarray of a reused buffer.
          writeBytes: async (data: Uint8Array) => {
            stdinWrites.push(Buffer.from(data));
          },
          getWriter: () => ({ close: async () => {} }),
        },
      };
    },
  };
  return { sandbox, execCalls, stdinWrites };
}

async function testCommandsRunAsUser(): Promise<void> {
  console.log("\n[7a] ModalCommands.run() - su wrapper reaches exec for non-root user");

  const { sandbox, execCalls } = createMockModalSandbox({ stdout: "hi", exitCode: 0 });
  const commands = new ModalCommands(sandbox as any, "worker");

  const result = await commands.run("echo hi", { cwd: "/workspace", envs: { A: "1" }, timeoutMs: 5000 });

  assertEqual(execCalls.length, 1, "Exactly one exec call");
  assertEqual(execCalls[0].args.slice(0, 3), ["su", "worker", "-c"], "exec argv uses su with the configured user");
  assertEqual(
    decodeSuPayload(execCalls[0].args),
    "cd '/workspace' && export A='1'; echo hi",
    "Payload carries cwd + envs + command"
  );
  assertEqual(execCalls[0].params?.timeoutMs, 5000, "timeoutMs forwarded to exec");
  assert(!("env" in (execCalls[0].params ?? {})), "envs are inlined, not passed to exec");
  assertEqual(result, { exitCode: 0, stdout: "hi", stderr: "" }, "Result accumulates streams and exit code");
}

async function testCommandsRunAsRoot(): Promise<void> {
  console.log("\n[7b] ModalCommands.run() - root goes straight to bash -c");

  const { sandbox, execCalls } = createMockModalSandbox({ stdout: "root-out" });
  const commands = new ModalCommands(sandbox as any, "root");

  await commands.run("whoami");
  assertEqual(execCalls[0].args, ["bash", "-c", "whoami"], "No su wrapper for root");
}

async function testCommandsStreamingCallbacks(): Promise<void> {
  console.log("\n[7c] ModalCommands.run() - onStdout/onStderr callbacks fire");

  const { sandbox } = createMockModalSandbox({ stdout: "chunk-out", stderr: "chunk-err", exitCode: 2 });
  const commands = new ModalCommands(sandbox as any, "user");

  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const result = await commands.run("failing", {
    onStdout: (d) => outChunks.push(d),
    onStderr: (d) => errChunks.push(d),
  });

  assertEqual(outChunks, ["chunk-out"], "stdout callback received the chunk");
  assertEqual(errChunks, ["chunk-err"], "stderr callback received the chunk");
  assertEqual(result.exitCode, 2, "Non-zero exit code propagated");
}

async function testCommandsSpawnWrapsUser(): Promise<void> {
  console.log("\n[7d] ModalCommands.spawn() - su wrapper + wait() result");

  const { sandbox, execCalls } = createMockModalSandbox({ stdout: "bg-out" });
  const commands = new ModalCommands(sandbox as any, "worker");

  const handle = await commands.spawn("sleep 1 && echo bg-out", { envs: { B: "2" } });
  assertEqual(execCalls[0].args[1], "worker", "spawn exec uses configured user");
  assertEqual(decodeSuPayload(execCalls[0].args), "export B='2'; sleep 1 && echo bg-out", "spawn payload carries envs");

  const result = await handle.wait();
  assertEqual(result, { exitCode: 0, stdout: "bg-out", stderr: "" }, "wait() returns accumulated result");
  assertEqual(await handle.kill(), false, "kill() reports unsupported (false) for Modal");
}

// =============================================================================
// [8] ModalFiles — chown behavior
// =============================================================================

async function testFilesMakeDirChownsToUser(): Promise<void> {
  console.log("\n[8a] ModalFiles.makeDir() - chowns to the configured user");

  const { sandbox, execCalls } = createMockModalSandbox();
  const files = new ModalFiles(sandbox as any, "worker");

  await files.makeDir("/workspace/data");

  assertEqual(execCalls[0].args, ["mkdir", "-p", "/workspace/data"], "mkdir issued first");
  assertEqual(
    execCalls[1].args,
    ["chown", "-R", "worker:worker", "/workspace/data"],
    "chown targets the configured user, not a hardcoded account"
  );
}

async function testFilesMakeDirRootSkipsChown(): Promise<void> {
  console.log("\n[8b] ModalFiles.makeDir() - root skips chown entirely");

  const { sandbox, execCalls } = createMockModalSandbox();
  const files = new ModalFiles(sandbox as any, "root");

  await files.makeDir("/workspace/data");

  assertEqual(execCalls.length, 1, "Only mkdir runs; no chown for root");
  assertEqual(execCalls[0].args[0], "mkdir", "The single call is mkdir");
}

async function testFilesWriteChownsToUser(): Promise<void> {
  console.log("\n[8c] ModalFiles.write() - file chowned to configured user after write");

  const { sandbox, execCalls } = createMockModalSandbox();
  const files = new ModalFiles(sandbox as any, "worker");

  await files.write("/workspace/out.txt", "hello");

  const chownCalls = execCalls.filter((c) => c.args[0] === "chown");
  assert(chownCalls.length >= 1, "At least one chown after write");
  assert(
    chownCalls.every((c) => c.args.includes("worker:worker")),
    "All chowns target worker:worker"
  );
}

async function testFilesWriteRootNoChown(): Promise<void> {
  console.log("\n[8d] ModalFiles.write() - no chown calls when user is root");

  const { sandbox, execCalls } = createMockModalSandbox();
  const files = new ModalFiles(sandbox as any, "root");

  await files.write("/workspace/out.txt", "hello");

  const chownCalls = execCalls.filter((c) => c.args[0] === "chown");
  assertEqual(chownCalls.length, 0, "Zero chown calls for root");
}

// =============================================================================
// [8x] ModalFiles.read() — text-vs-binary decided by content, byte-exact
// =============================================================================

async function testFilesReadBinaryByContentNotExtension(): Promise<void> {
  console.log("\n[8e] ModalFiles.read() - binary is decided by CONTENT; a .bin payload survives byte-exact");

  // The E2E-proven mangle: these bytes are not valid UTF-8 (0xff/0xfe leads,
  // a NUL) and .bin sat in no extension table, so the old extension-steered
  // read sent them through a lossy text decode and returned U+FFFD soup.
  const bytes = Uint8Array.from([0x00, 0xff, 0xfe, 0x80, 0x9c, 0xc3, 0x28, 0x01]);
  const { sandbox } = createMockModalSandbox({ stdoutBytes: bytes });
  const files = new ModalFiles(sandbox as any, "root");

  const result = await files.read("/workspace/blob.bin");
  assert(result instanceof Uint8Array, "non-UTF8 content reads back as bytes, whatever the name");
  assertEqual(Array.from(result as Uint8Array), Array.from(bytes), "every byte survives exactly");

  // NUL is the binary tell even when the bytes happen to decode as UTF-8
  // (the platform's agent-home sniff, git's own heuristic).
  const nulled = Uint8Array.from([0x68, 0x00, 0x69]);
  const { sandbox: nulBox } = createMockModalSandbox({ stdoutBytes: nulled });
  const nulRead = await new ModalFiles(nulBox as any, "root").read("/workspace/data.txt");
  assert(nulRead instanceof Uint8Array, "a NUL byte marks binary even inside valid UTF-8");
}

async function testFilesReadTextByContentNotExtension(): Promise<void> {
  console.log("\n[8f] ModalFiles.read() - valid UTF-8 is a string, even under a binary-looking name");

  const text = "héllo → wörld\n";
  const { sandbox } = createMockModalSandbox({ stdoutBytes: new TextEncoder().encode(text) });
  const files = new ModalFiles(sandbox as any, "root");

  const result = await files.read("/workspace/report.png");
  assertEqual(result, text, "the extension plays no part — valid UTF-8 reads back as a string");

  // ignoreBOM: a BOM is content, not framing. The default decoder would eat
  // it and the string would no longer re-encode to the file's exact bytes.
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]);
  const { sandbox: bomBox } = createMockModalSandbox({ stdoutBytes: bom });
  const bomRead = await new ModalFiles(bomBox as any, "root").read("/workspace/bom.txt");
  assertEqual(
    Array.from(new TextEncoder().encode(bomRead as string)),
    Array.from(bom),
    "a leading BOM survives the decode, so the string rebuilds the identical bytes"
  );
}

// =============================================================================
// [9] ModalFiles — stdin chunking (Modal's 100MiB gRPC message cap)
// =============================================================================

/** Modal's hard per-message gRPC cap (TaskExecStdinWrite): 100MiB. */
const MODAL_GRPC_MESSAGE_CAP = 100 * 1024 * 1024;

/** Deterministic patterned buffer so reassembly errors are detectable. */
function patternedBuffer(size: number): Buffer {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i++) buf[i] = i % 251; // prime modulus: no 8MiB-period aliasing
  return buf;
}

async function testFilesWriteSmallSingleChunk(): Promise<void> {
  console.log("\n[9a] ModalFiles.write() - small payload stays a single stdin write");

  const { sandbox, stdinWrites } = createMockModalSandbox();
  const files = new ModalFiles(sandbox as any, "root");

  await files.write("/workspace/small.bin", Buffer.from("hello world"));

  assertEqual(stdinWrites.length, 1, "One writeBytes call for a small file");
  assertEqual(stdinWrites[0].toString("utf-8"), "hello world", "Payload delivered intact");
}

async function testFilesWriteChunksOverCap(): Promise<void> {
  console.log("\n[9b] ModalFiles.write() - payload over Modal's 100MiB cap is chunked at 8MiB");

  const size = MODAL_GRPC_MESSAGE_CAP + 1; // 104,857,601 bytes: one byte over the gRPC cap
  const data = Buffer.allocUnsafe(size);
  data[0] = 0xaa;
  data[size - 1] = 0xbb;

  const { sandbox, stdinWrites } = createMockModalSandbox();
  const files = new ModalFiles(sandbox as any, "root");
  await files.write("/workspace/huge.tar.gz", data);

  const expectedChunks = Math.ceil(size / MODAL_STDIN_CHUNK_BYTES);
  assertEqual(stdinWrites.length, expectedChunks, `Split into ceil(size/8MiB) = ${expectedChunks} writes`);
  assert(
    stdinWrites.every((c) => c.length <= MODAL_STDIN_CHUNK_BYTES),
    "Every chunk is at most 8MiB"
  );
  assert(
    stdinWrites.every((c) => c.length < MODAL_GRPC_MESSAGE_CAP),
    "No single gRPC message reaches Modal's 100MiB cap"
  );
  const total = stdinWrites.reduce((n, c) => n + c.length, 0);
  assertEqual(total, size, "Total bytes across chunks equal the payload size");
  assertEqual(stdinWrites[0][0], 0xaa, "First byte lands in the first chunk");
  const last = stdinWrites[stdinWrites.length - 1];
  assertEqual(last[last.length - 1], 0xbb, "Last byte lands in the last chunk");
}

async function testFilesWriteChunksReassembleExactly(): Promise<void> {
  console.log("\n[9c] ModalFiles.write() - chunks reassemble byte-identical, in order");

  const size = 2 * MODAL_STDIN_CHUNK_BYTES + 12345; // 3 chunks, ragged tail
  const data = patternedBuffer(size);

  const { sandbox, stdinWrites } = createMockModalSandbox();
  const files = new ModalFiles(sandbox as any, "root");
  await files.write("/workspace/patterned.bin", data);

  assertEqual(stdinWrites.length, 3, "2 full chunks + 1 ragged tail");
  assertEqual(stdinWrites[0].length, MODAL_STDIN_CHUNK_BYTES, "Chunk 1 is exactly 8MiB");
  assertEqual(stdinWrites[1].length, MODAL_STDIN_CHUNK_BYTES, "Chunk 2 is exactly 8MiB");
  assertEqual(stdinWrites[2].length, 12345, "Tail chunk carries the remainder");
  assert(Buffer.concat(stdinWrites).equals(data), "Reassembled bytes are identical to the input");
}

async function testFilesWriteBatchChunksOverCap(): Promise<void> {
  console.log("\n[9d] ModalFiles.writeBatch() - tar stream over the cap is chunked at 8MiB");

  // One >100MiB file: the tar buffer (payload + 512B header + padding) exceeds the cap
  const size = MODAL_GRPC_MESSAGE_CAP + 1;
  const data = Buffer.allocUnsafe(size);

  const { sandbox, execCalls, stdinWrites } = createMockModalSandbox();
  const files = new ModalFiles(sandbox as any, "root");
  await files.writeBatch([{ path: "/workspace/bundle.tar.gz", data }]);

  const tarExec = execCalls.find((c) => c.args[0] === "tar");
  assert(tarExec !== undefined, "Batch upload still goes through a single tar exec");
  assert(stdinWrites.length >= Math.ceil(size / MODAL_STDIN_CHUNK_BYTES), "Tar stream split into multiple writes");
  assert(
    stdinWrites.every((c) => c.length <= MODAL_STDIN_CHUNK_BYTES),
    "Every tar chunk is at most 8MiB"
  );
  assert(
    stdinWrites.every((c) => c.length < MODAL_GRPC_MESSAGE_CAP),
    "No single gRPC message reaches Modal's 100MiB cap"
  );
  const total = stdinWrites.reduce((n, c) => n + c.length, 0);
  assert(total > size, "Total stdin bytes cover payload + tar header/padding");
  assertEqual(total % 512, 0, "Reassembled stream is 512-byte aligned (valid tar framing preserved)");
}

async function testFilesWriteBatchSmallSingleChunk(): Promise<void> {
  console.log("\n[9e] ModalFiles.writeBatch() - small batch stays a single stdin write");

  const { sandbox, stdinWrites } = createMockModalSandbox();
  const files = new ModalFiles(sandbox as any, "root");
  await files.writeBatch([
    { path: "/workspace/a.txt", data: "aaa" },
    { path: "/workspace/b.txt", data: "bbb" },
  ]);

  assertEqual(stdinWrites.length, 1, "One writeBytes call for a small tar");
  const tar = stdinWrites[0];
  assert(tar.includes("workspace/a.txt") && tar.includes("workspace/b.txt"), "Tar contains both entries");
}

// =============================================================================
// [10] Versioned image pipeline
// =============================================================================

async function testImageMapUsesVersionedTag(): Promise<void> {
  console.log("\n[10a] IMAGE_MAP - versioned default plus untouched legacy name (Daytona's rule)");

  // Modal caches images by REFERENCE: a re-pushed :latest is never re-pulled,
  // so only a per-release tag makes updates reach users. The version is
  // DERIVED from the image build inputs (c-<12hex>, never hand-written) and
  // held coherent with assets/ and packages/daytona by the coherence test in
  // packages/daytona/tests/unit/daytona-image-version.test.ts.
  assert(/^c-[0-9a-f]{12}$/.test(EVOLVE_IMAGE_VERSION), `version "${EVOLVE_IMAGE_VERSION}" is a c-<12hex> content tag`);
  assertEqual(
    _testImageMap[`evolve-all-${EVOLVE_IMAGE_VERSION}`],
    `evolvingmachines/evolve-all:${EVOLVE_IMAGE_VERSION}`,
    "the versioned image name resolves to the immutable versioned tag"
  );
  assertEqual(
    _testImageMap["evolve-all"],
    "evolvingmachines/evolve-all",
    "the legacy 'evolve-all' name still resolves to what it always did"
  );
}

async function testDefaultImageNameIsVersioned(): Promise<void> {
  console.log("\n[10b] createModalProvider() - the default image name carries the release version");

  const provider = createModalProvider({ tokenId: "ak-test", tokenSecret: "as-test" });
  assertEqual(
    (provider as unknown as { imageName: string }).imageName,
    `evolve-all-${EVOLVE_IMAGE_VERSION}`,
    "a provider with no imageName defaults to the versioned name"
  );

  const pinned = createModalProvider({
    tokenId: "ak-test",
    tokenSecret: "as-test",
    imageName: "evolve-all",
  });
  assertEqual(
    (pinned as unknown as { imageName: string }).imageName,
    "evolve-all",
    "an explicit imageName passes through untouched"
  );
}

// =============================================================================
// RUNNER
// =============================================================================

const tests = [
  // [1] wrapCommand pure function
  testWrapCommandRootPassthrough,
  testWrapCommandSuWrapper,
  testWrapCommandParameterizedUser,
  testWrapCommandCwdAndEnvs,
  testWrapCommandEscaping,
  testWrapCommandEnvFiltering,
  testWrapCommandComplexQuoting,
  testWrapCommandNonStringEnv,
  // [2] mapNetworkPolicy
  testNetworkNoPolicy,
  testNetworkOpenWithDestinationsThrows,
  testNetworkBlockedAll,
  testNetworkDomainAllowlist,
  testNetworkCidrAllowlist,
  testNetworkMixedAllowlist,
  testNetworkPortRejected,
  testNetworkTrueIpv6StillCidr,
  testNetworkInvalidIpv4Rejected,
  // [2x] mapResources
  testMapResourcesDefaults,
  testMapResourcesHonored,
  testMapResourcesDiskRejected,
  // [3] resolveImageRegistry
  testImageRegistryDetection,
  // [4] buildSandboxInfo
  testSandboxInfoFromTags,
  testSandboxInfoForeignSandbox,
  testSandboxInfoFallbackImage,
  // [5] validateTimeout
  testTimeoutCap,
  // [5b] mapIdleTimeout
  testIdleTimeoutUnsetIsAbsent,
  testIdleTimeoutHonored,
  testIdleTimeoutRejectsNonPositive,
  testIdleTimeoutRejectsOverCap,
  // [6] provider create validation
  testCreateValidatesBeforeNetwork,
  testCreateNoLongerRejectsUserAndNetwork,
  testCreateValidatesIdleTimeoutBeforeNetwork,
  // [7] ModalCommands
  testCommandsRunAsUser,
  testCommandsRunAsRoot,
  testCommandsStreamingCallbacks,
  testCommandsSpawnWrapsUser,
  // [8] ModalFiles
  testFilesMakeDirChownsToUser,
  testFilesMakeDirRootSkipsChown,
  testFilesWriteChownsToUser,
  testFilesWriteRootNoChown,
  // [8x] ModalFiles read fidelity (content-sniffed, byte-exact)
  testFilesReadBinaryByContentNotExtension,
  testFilesReadTextByContentNotExtension,
  // [9] ModalFiles stdin chunking (100MiB gRPC cap)
  testFilesWriteSmallSingleChunk,
  testFilesWriteChunksOverCap,
  testFilesWriteChunksReassembleExactly,
  testFilesWriteBatchChunksOverCap,
  testFilesWriteBatchSmallSingleChunk,
  // [10] versioned image pipeline
  testImageMapUsesVersionedTag,
  testDefaultImageNameIsVersioned,
];

(async () => {
  console.log("=== Modal Provider: wrapCommand + network policy + registry + info + cap Tests ===");
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
