#!/usr/bin/env tsx
/**
 * LIVE E2E: dynamic network phase switching on E2B.
 *
 * Same claim as the modal and daytona runs — setup-time and agent-time egress
 * genuinely differ on ONE running box — driven entirely through the adapter,
 * not the vendor client.
 *
 * THE QUESTION THIS EXISTS TO SETTLE, e2b's version of it. E2B documents the
 * update as replacing the egress configuration atomically, with "fields that
 * are omitted cleared on the server". The adapter leans on exactly that: it
 * always states allowInternetAccess, and states `network` ONLY when an
 * allowlist is in force, so switching away from an allowlist is expected to
 * clear it by the server's own rule rather than by a second call. If that rule
 * did not hold, a switch from allowlist to sealed would leave the old hosts
 * reachable — a box that reads as sealed and is not. Step [4] is that test:
 * the previously-allowed host must go dark.
 *
 * (The daytona equivalent is its cleared-to-"" allowlist; the modal one is its
 * two always-stated dimensions. Same failure shape, three different spellings.)
 *
 * REQUIRES e2b >= 2.25.0, where Sandbox.updateNetwork first appears. On an
 * older client this SKIPS rather than failing: the adapter's typed refusal is
 * the correct behaviour there and is unit-tested. It runs for real once the
 * client bump lands.
 *
 * THE SKIP IS DETECTED BY ATTEMPTING THE SWITCH, not by checking whether the
 * method is there. Probing for the method cannot work: the adapter ALWAYS
 * declares updateNetwork — the conformance seam guarantees exactly that — so
 * its presence says nothing about whether the underlying client can honour it.
 * The capability lives one layer down and only answers when asked. (A first
 * version of this file probed for the method, found it, and failed on a client
 * that could never have worked.)
 *
 * LIVE, and it costs a real E2B sandbox — run it deliberately, not in CI:
 *   E2B_API_KEY=... npx tsx tests/integration/e2e-dynamic-network.ts
 *
 * Last run 2026-08-15 against e2b 2.39.0: all six checks passed — sealed
 * BLOCKED -> public REACHABLE -> allowlist admits only its host -> sealed
 * BLOCKED again, same running box.
 */
import { createE2BProvider, E2BNetworkUpdateUnsupportedError } from "../../src/index.ts";

const PROBE_TIMEOUT_SEC = 15;
const PROBE_IMAGE = "base";
/** On the allowlist for step [3]; must go dark again in step [4]. */
const ALLOWED_HOST = "pypi.org";
/** Never on any allowlist — proves an allowlist filters rather than opens. */
const FORBIDDEN_HOST = "example.com";

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
const RUN_ID = `e2b-dynnet-${Date.now()}`;

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

type Box = Awaited<ReturnType<ReturnType<typeof createE2BProvider>["create"]>>;

async function reaches(box: Box, host: string, label: string): Promise<boolean> {
  const py = [
    "import urllib.request as u",
    "try:",
    `    u.urlopen('https://${host}', timeout=${PROBE_TIMEOUT_SEC}); print('OK')`,
    "except Exception as e:",
    "    print('BLOCKED_' + type(e).__name__)",
  ].join("\n");
  // base64 so no shell layer can reinterpret a newline or a quote.
  const b64 = Buffer.from(py, "utf-8").toString("base64");
  const r = await box.commands
    .run(`echo ${b64} | base64 -d | python3`)
    .catch((e: unknown) => ({ exitCode: 1, stdout: "", stderr: String(e) }));
  const ok = `${r.stdout}${r.stderr}`.includes("OK");
  console.log(`   [${label}:${host}] ${ok ? "REACHABLE" : "BLOCKED"}`);
  return ok;
}

async function main(): Promise<void> {
  const provider = createE2BProvider({ apiKey: process.env.E2B_API_KEY });

  const baseline = { outbound: "blocked" as const, allowedDestinations: ["1.2.3.4/32"] };
  const agentPhase = { outbound: "open" as const };

  console.log("[1] create the box under the [environment] baseline (sealed)");
  const box = await provider.create({
    image: PROBE_IMAGE,
    network: baseline,
    phaseNetworkPolicies: [agentPhase],
    timeoutMs: 10 * 60 * 1000,
    metadata: { e2e: 'e2b-dynnet', run: RUN_ID },
  });
  console.log(`    sandbox ${box.sandboxId}`);

  try {
    console.log("\n[2] SETUP PHASE — egress must be denied");
    expect(!(await reaches(box, ALLOWED_HOST, "setup")), "the box cannot reach the internet under the baseline");

    console.log("\n[3] switch to the [agent] phase (public) — no restart");
    const t0 = Date.now();
    try {
      await box.updateNetwork(agentPhase);
    } catch (e) {
      if (e instanceof E2BNetworkUpdateUnsupportedError) {
        console.log(`\n[SKIPPED] ${e.message}`);
        return;
      }
      throw e;
    }
    console.log(`    switch returned in ${Date.now() - t0}ms`);
    expect(await reaches(box, ALLOWED_HOST, "agent"), "the SAME box reaches the internet during the agent phase");

    console.log("\n[4] switch to an ALLOWLIST, then away from it — THE DISCRIMINATOR");
    await box.updateNetwork({ outbound: "blocked", allowedDestinations: [ALLOWED_HOST] });
    expect(await reaches(box, ALLOWED_HOST, "allowlist"), "an allowlisted host is reachable");
    expect(
      !(await reaches(box, FORBIDDEN_HOST, "allowlist")),
      "a host NOT on the allowlist is blocked — the allowlist filters, it does not open",
    );

    // The real question: switching AWAY from the allowlist must clear it.
    await box.updateNetwork(baseline);
    expect(
      !(await reaches(box, ALLOWED_HOST, "resealed")),
      "the previously-allowed host goes dark — the old allowlist was cleared, not carried over",
    );

    console.log("\n[5] the box was never restarted");
    expect((await box.isRunning?.()) === true, "still the same running sandbox");
  } finally {
    console.log("\n[cleanup] killing sandbox");
    await hardKill(box);
  }

  console.log(`\n=== ${failures === 0 ? "E2E PASSED" : `E2E FAILED (${failures})`} ===`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("E2E ERROR:", err);
  process.exit(1);
});
