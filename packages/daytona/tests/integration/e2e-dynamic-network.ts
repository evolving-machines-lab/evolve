#!/usr/bin/env tsx
/**
 * LIVE E2E: dynamic network phase switching on Daytona.
 *
 * Same claim as the modal one — setup-time and agent-time egress genuinely
 * differ on ONE running box — but Daytona is worth its own live run for a
 * reason the modal test cannot answer.
 *
 * THE QUESTION THIS EXISTS TO SETTLE. Daytona's update takes allowlists as
 * COMMA-JOINED STRINGS, and the adapter clears the one it does not mean by
 * sending "". The published types never say what an empty string means, and
 * the two readings differ in the worst possible way:
 *
 *   "no allowlist in force"    -> egress opens. What we intend.
 *   "an allowlist with zero
 *    entries, so allow nothing" -> a PUBLIC agent phase silently STARVES,
 *                                  and the trial records a real-looking score
 *                                  for an agent that could not reach anything.
 *
 * Step [3] is the discriminator: it opens the box by clearing the allowlist,
 * and a reachable probe is the proof that "" means the first reading.
 *
 * Shape under test is harbor's dynamic/e-a-diff:
 * [environment] network_mode = "no-network", [agent] network_mode = "public".
 *
 *   boot   sealed  -> probe MUST fail    (setup phase)
 *   switch open    -> probe MUST succeed (agent phase; the discriminator)
 *   switch sealed  -> probe MUST fail    (baseline restored)
 *
 * LIVE, and it costs a real Daytona sandbox — run it deliberately, not in CI:
 *   DAYTONA_API_KEY=... npx tsx tests/integration/e2e-dynamic-network.ts
 *
 * Last run 2026-08-15: all five checks passed — sealed BLOCKED (DNS refused)
 * -> public HTTP_200 -> sealed BLOCKED again, same running box, switch
 * acknowledged in 161ms. So "" means "no allowlist in force", and a public
 * agent phase does not starve.
 *
 * NOT COVERED, and it cannot be by a passing run: Daytona's org-tier refusal.
 * The account this ran on is above the plan-tier gate, so the tier path never
 * fires here. That path is a TYPED error
 * (DaytonaNetworkPolicyError('org-tier-forbidden')) with unit coverage on the
 * classifier; proving it live would need a Tier 1/2 organization.
 */
import { createDaytonaProvider } from "../../src/index.ts";

const PROBE_URL = "https://pypi.org/simple/";
/** Short, so a blocked probe fails by policy rather than by our patience. */
const PROBE_TIMEOUT_SEC = 20;
/** Public image with bash and python — no dependency on our own image pipeline. */
const PROBE_IMAGE = "python:3.11-slim";

type ProbeResult = { reachable: boolean; detail: string };

async function probeEgress(
  sandbox: {
    commands: {
      run(cmd: string, opts?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
    };
  },
  label: string,
): Promise<ProbeResult> {
  const py = [
    "import urllib.request as u",
    "try:",
    `    r = u.urlopen('${PROBE_URL}', timeout=${PROBE_TIMEOUT_SEC})`,
    "    print('HTTP_' + str(r.status))",
    "except Exception as e:",
    "    print('BLOCKED_' + type(e).__name__ + ':' + str(e)[:120])",
  ].join("\n");
  // Shipped as base64 so no shell layer can reinterpret a newline or a quote.
  const b64 = Buffer.from(py, "utf-8").toString("base64");
  const cmd = `echo ${b64} | base64 -d | python3`;
  const res = await sandbox.commands.run(cmd, { timeoutMs: (PROBE_TIMEOUT_SEC + 30) * 1000 });
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

async function main(): Promise<void> {
  const provider = createDaytonaProvider({ apiKey: process.env.DAYTONA_API_KEY });

  // The eval lane's own shapes: a SEALED baseline that may still reach its
  // model door (one pinned CIDR standing in for the gateway pin), and an agent
  // phase that opens fully.
  const baseline = { outbound: "blocked" as const, allowedDestinations: ["1.2.3.4/32"] };
  const agentPhase = { outbound: "open" as const };

  console.log("[1] create the box under the [environment] baseline (sealed)");
  const sandbox = await provider.create({
    image: PROBE_IMAGE,
    network: baseline,
    // Ignored by daytona (it switches freely) but declared for the same
    // reason the platform declares it: one shape across every provider.
    phaseNetworkPolicies: [agentPhase],
    timeoutMs: 10 * 60 * 1000,
  });
  console.log(`    sandbox ${sandbox.sandboxId}`);

  try {
    console.log("\n[2] SETUP PHASE — egress must be denied");
    const setup = await probeEgress(sandbox, "setup");
    expect(!setup.reachable, "the box cannot reach the internet under the environment baseline");

    console.log("\n[3] switch to the [agent] phase (public) — THE DISCRIMINATOR");
    console.log('    the update clears the allowlist by sending ""; a reachable probe');
    console.log('    proves "" means "no allowlist", not "an allowlist of nothing"');
    expect(typeof sandbox.updateNetwork === "function", "the daytona adapter exposes updateNetwork()");
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
    await sandbox.kill().catch((e: unknown) => console.log(`    kill failed: ${String(e)}`));
  }

  console.log(`\n=== ${failures === 0 ? "E2E PASSED" : `E2E FAILED (${failures})`} ===`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("E2E ERROR:", err);
  process.exit(1);
});
