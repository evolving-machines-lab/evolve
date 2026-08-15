#!/usr/bin/env tsx
/**
 * LIVE E2E: dynamic network phase switching on Modal.
 *
 * Proves the thing the whole lane exists for — that setup-time egress and
 * agent-time egress genuinely DIFFER on one running box, with no restart —
 * by probing real egress at each phase rather than trusting the API's
 * acknowledgement.
 *
 * Shape under test is harbor's dynamic/e-a-diff
 * (examples/tasks/network-policy-matrix/dynamic/e-a-diff/task.toml):
 * [environment] network_mode = "no-network", [agent] network_mode = "public".
 *
 *   boot   sealed  -> probe MUST fail   (setup phase)
 *   switch open    -> probe MUST succeed (agent phase)
 *   switch sealed  -> probe MUST fail   (baseline restored)
 *
 * The middle step is the claim; the third proves the switch is a real policy
 * change and not a one-way door.
 *
 * LIVE, and it costs a real Modal sandbox — run it deliberately, not in CI:
 *   MODAL_TOKEN_ID=... MODAL_TOKEN_SECRET=... npx tsx tests/integration/e2e-dynamic-network.ts
 *
 * Last run 2026-08-14: all five checks passed, switch acknowledged in 95ms,
 * and it is what found modal's undocumented precondition that an empty domain
 * allowlist leaves domain filtering off and unswitchable (see
 * withDomainFilteringEnabled in the adapter).
 */
import { createModalProvider } from "../../src/index.ts";

const PROBE_URL = "https://pypi.org/simple/";
/** Small public image with bash and python — no dependency on our own image pipeline. */
const PROBE_IMAGE = "python:3.11-slim";
/** Short, so a blocked probe fails by policy rather than by our patience. */
const PROBE_TIMEOUT_SEC = 20;

type ProbeResult = { reachable: boolean; detail: string };

async function probeEgress(
  sandbox: { commands: { run(cmd: string, opts?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }> } },
  label: string,
): Promise<ProbeResult> {
  // Python's urlopen is the verdict: a status line means the bytes arrived,
  // any exception (DNS failure, connection refused, timeout) means egress was
  // denied. Printed as one token so the transcript shows WHY, not just that.
  const py = [
    "import urllib.request as u",
    "try:",
    `    r = u.urlopen('${PROBE_URL}', timeout=${PROBE_TIMEOUT_SEC})`,
    "    print('HTTP_' + str(r.status))",
    "except Exception as e:",
    "    print('BLOCKED_' + type(e).__name__ + ':' + str(e)[:120])",
  ].join("\n");
  // Shipped as base64 so no layer between here and python can reinterpret a
  // newline or a quote — an earlier version passed the source through a shell
  // double-quote and python received a literal backslash-n, failed to parse,
  // and the probe read that SyntaxError as "egress blocked".
  const b64 = Buffer.from(py, "utf-8").toString("base64");
  const cmd = `echo ${b64} | base64 -d | python3`;
  const res = await sandbox.commands.run(cmd, { timeoutMs: (PROBE_TIMEOUT_SEC + 20) * 1000 });
  const out = `${res.stdout}${res.stderr}`.trim();
  const reachable = out.includes("HTTP_200");
  console.log(`   [${label}] exit=${res.exitCode} out=${JSON.stringify(out.slice(0, 200))} -> ${reachable ? "REACHABLE" : "BLOCKED"}`);
  return { reachable, detail: out.slice(0, 200) };
}

let failures = 0;
function expect(condition: boolean, message: string): void {
  if (condition) {
    console.log(`   PASS  ${message}`);
  } else {
    failures += 1;
    console.log(`   FAIL  ${message}`);
  }
}

/**
 * Unique to THIS run, stamped into the box's metadata so the sweep below can
 * tell "my box is gone" from "someone else's box is running".
 */
const RUN_ID = `modal-dynnet-${Date.now()}`;

/**
 * Kill the box and REFUSE TO BE QUIET ABOUT FAILING.
 *
 * `kill().catch(e => console.log(e))` is how a live sandbox survives a green
 * run: the E2E reports success, the log line scrolls past, and the box bills
 * until someone finds it on the provider's dashboard. Two stale boxes were
 * found by hand, which is what prompted this. One retry for a transient blip,
 * then it counts as a FAILURE.
 */
async function hardKill(box: { sandboxId: string; kill: () => Promise<void> }): Promise<void> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await box.kill();
      return;
    } catch (e) {
      if (attempt === 2) {
        failures += 1;
        console.log(`   FAIL  could not kill ${box.sandboxId} after 2 attempts: ${String(e)}`);
        return;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

async function main(): Promise<void> {
  const provider = createModalProvider({
    tokenId: process.env.MODAL_TOKEN_ID,
    tokenSecret: process.env.MODAL_TOKEN_SECRET,
  });

  // The eval lane's own shapes: the baseline is a SEALED box that may still
  // reach its model door, and the agent phase opens fully.
  const baseline = { outbound: "blocked" as const, allowedDestinations: ["1.2.3.4/32"] };
  const agentPhase = { outbound: "open" as const };

  console.log("[1] create the box under the [environment] baseline (sealed)");
  console.log("    declaring the agent phase up front, so modal builds it switchable");
  const sandbox = await provider.create({
    image: PROBE_IMAGE,
    // Modal wraps commands as `su user -c` by default; this bare image has no
    // such account, so the probe runs as root.
    user: "root",
    network: baseline,
    // Without this the adapter would use blockNetwork:true and modal could
    // never widen the box — this is the whole create-time arming question.
    phaseNetworkPolicies: [agentPhase],
    timeoutMs: 10 * 60 * 1000,
    metadata: { e2e: 'modal-dynnet', run: RUN_ID },
  });
  console.log(`    sandbox ${sandbox.sandboxId}`);

  try {
    console.log("\n[2] SETUP PHASE — egress must be denied");
    const setup = await probeEgress(sandbox, "setup");
    expect(!setup.reachable, "the box cannot reach the internet under the environment baseline");

    console.log("\n[3] switch to the [agent] phase (public) — no restart");
    expect(typeof sandbox.updateNetwork === "function", "the modal adapter exposes updateNetwork()");
    const switchedAt = Date.now();
    await sandbox.updateNetwork(agentPhase);
    console.log(`    switch returned in ${Date.now() - switchedAt}ms`);

    const agent = await probeEgress(sandbox, "agent");
    expect(agent.reachable, "the SAME box reaches the internet during the agent phase");

    console.log("\n[4] restore the baseline — the switch is not a one-way door");
    await sandbox.updateNetwork(baseline);
    const restored = await probeEgress(sandbox, "restored");
    expect(!restored.reachable, "egress is denied again once the baseline is restored");

    console.log("\n[5] the box was never restarted");
    expect(await sandbox.isRunning(), "the sandbox is still the same running box");
  } finally {
    console.log("\n[cleanup] killing sandbox");
    await hardKill(sandbox);
  }

  console.log(`\n=== ${failures === 0 ? "E2E PASSED" : `E2E FAILED (${failures})`} ===`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("E2E ERROR:", err);
  process.exit(1);
});
