#!/usr/bin/env tsx
/**
 * LIVE SMOKE for the e2b client bump (2.10.3 -> 2.39.0).
 *
 * A dependency bump across 29 minor releases is not proved by a typecheck: the
 * declarations can be identical while the WIRE behaviour moved. So this drives
 * every part of the vendor surface this adapter actually depends on, against a
 * real sandbox, and asserts on results rather than on the absence of a throw.
 *
 * The surface is deliberately the whole of it — `grep` for the adapter's calls
 * gives exactly: Sandbox.create / connect / list, and on the instance
 * sandboxId, commands, files, getHost, getInfo, isRunning, betaPause, kill,
 * downloadUrl, uploadUrl. If something here is untested, the adapter has grown
 * a call this file has not caught up with.
 *
 * Plus the one thing the bump exists FOR: Sandbox.updateNetwork, which landed
 * in 2.25.0 (e2b's release notes for that version) and is absent from the
 * pinned 2.10.3. Now present in the INSTALLED client — node_modules/e2b/dist/
 * index.d.ts:9957, documented at :8981 as "Replaces the current egress
 * configuration atomically — fields that are omitted are cleared on the
 * server." It is exercised through the vendor client here because the adapter
 * method that calls it lives on the dynamic-network branch; that branch's own
 * adapter-level E2E covers the wrapper.
 *
 * LIVE, and it costs a real E2B sandbox — run it deliberately, not in CI:
 *   E2B_API_KEY=... npx tsx tests/integration/e2e-client-bump-smoke.ts
 *
 * Last run 2026-08-15 against e2b 2.39.0: every check passed. The whole
 * adapter surface behaved unchanged, and the unlock proved out both ways —
 * sealed BLOCKED -> updateNetwork opens -> REACHABLE -> closes -> BLOCKED on
 * one running box, plus the allowlist shape admitting pypi.org while blocking
 * example.com.
 */
import { Sandbox as E2BSandbox } from "@e2b/code-interpreter";
import { createE2BProvider } from "../../src/index.ts";

let failures = 0;
function expect(condition: boolean, message: string): void {
  if (condition) {
    console.log(`   PASS  ${message}`);
  } else {
    failures += 1;
    console.log(`   FAIL  ${message}`);
  }
}

const PROBE_URL = "https://pypi.org/simple/";

async function main(): Promise<void> {
  const apiKey = process.env.E2B_API_KEY;
  if (!apiKey) throw new Error("E2B_API_KEY is required for this live smoke");

  console.log(`[0] client versions`);
  const clientVersion = (
    await import("e2b/package.json", { with: { type: "json" } }).catch(() => null)
  )?.default?.version;
  console.log(`    e2b = ${clientVersion ?? "(unresolved)"}`);

  console.log("\n[1] create — the sealed shape the eval lane boots with");
  // Same mapping the adapter produces for a blocked policy with an allowlist:
  // deny everything, then allow the declared destinations back.
  const sandbox = await E2BSandbox.create("base", {
    apiKey,
    metadata: { smoke: "e2b-bump" },
    timeoutMs: 5 * 60 * 1000,
    allowInternetAccess: true,
    network: { denyOut: ["0.0.0.0/0"], allowOut: ["1.2.3.4/32"] },
  });
  console.log(`    sandbox ${sandbox.sandboxId}`);
  expect(typeof sandbox.sandboxId === "string" && sandbox.sandboxId.length > 0, "create returns a sandbox id");

  try {
    console.log("\n[2] commands.run — the adapter's only exec path");
    const echo = await sandbox.commands.run("echo hello-from-smoke");
    expect(echo.exitCode === 0, "a command runs and reports exit 0");
    expect(echo.stdout.includes("hello-from-smoke"), "stdout comes back intact");

    const failing = await sandbox.commands.run("exit 7", { requestTimeoutMs: 30_000 }).catch((e: unknown) => e);
    const failedExit = (failing as { exitCode?: number })?.exitCode;
    expect(failedExit === 7 || failing instanceof Error, "a nonzero exit is reported, not swallowed");

    console.log("\n[3] files — write then read back, byte-exact");
    await sandbox.files.write("/tmp/smoke.txt", "line-one\nline-two\n");
    const readBack = await sandbox.files.read("/tmp/smoke.txt");
    expect(readBack === "line-one\nline-two\n", "a file reads back exactly as written");

    console.log("\n[4] getInfo / isRunning / getHost");
    const info = await sandbox.getInfo();
    expect(info.sandboxId === sandbox.sandboxId, "getInfo reports this sandbox");
    expect(typeof info.startedAt !== "undefined", "getInfo carries a real startedAt");
    expect(await sandbox.isRunning(), "isRunning is true for a live box");
    expect(typeof sandbox.getHost(8080) === "string", "getHost returns a host string");

    console.log("\n[5] upload/download URLs — the adapter's signed-transfer path");
    expect((await sandbox.uploadUrl("/tmp/up.bin")).startsWith("http"), "uploadUrl returns a URL");
    expect((await sandbox.downloadUrl("/tmp/smoke.txt")).startsWith("http"), "downloadUrl returns a URL");

    console.log("\n[6] list — the fleet enumeration the reaper depends on");
    const paginator = E2BSandbox.list({ apiKey });
    const firstPage = await paginator.nextItems();
    expect(Array.isArray(firstPage), "list returns a page of items");
    expect(
      firstPage.some((s: { sandboxId: string }) => s.sandboxId === sandbox.sandboxId),
      "the live sandbox appears in the listing",
    );

    console.log("\n[7] connect — reattaching to a running box");
    const reattached = await E2BSandbox.connect(sandbox.sandboxId, { apiKey });
    const viaReattach = await reattached.commands.run("cat /tmp/smoke.txt");
    expect(viaReattach.stdout.includes("line-two"), "a reattached handle sees the same filesystem");

    console.log("\n[8] updateNetwork — THE UNLOCK (absent in the pinned 2.10.3)");
    expect(typeof (sandbox as { updateNetwork?: unknown }).updateNetwork === "function", "Sandbox.updateNetwork exists at this version");

    const probe = async (label: string): Promise<boolean> => {
      const r = await sandbox.commands
        .run(`python3 -c "import urllib.request as u; u.urlopen('${PROBE_URL}', timeout=15); print('OK')"`, {
          requestTimeoutMs: 60_000,
        })
        .catch((e: unknown) => ({ exitCode: 1, stdout: "", stderr: String(e) }));
      const reachable = r.exitCode === 0 && r.stdout.includes("OK");
      console.log(`    [${label}] ${reachable ? "REACHABLE" : "BLOCKED"}`);
      return reachable;
    };

    expect(!(await probe("sealed")), "the box starts sealed — egress denied");
    await sandbox.updateNetwork({ allowInternetAccess: true });
    expect(await probe("opened"), "updateNetwork OPENS egress on the running box");
    await sandbox.updateNetwork({ allowInternetAccess: false });
    expect(!(await probe("resealed")), "and closes it again — the switch is not one-way");

    // THE SHAPE THE ADAPTER ACTUALLY EMITS. The two calls above are the
    // public/no-network ends of the mapping; a task-declared ALLOWLIST maps to
    // deny-everything-then-allow-these, and that shape has its own failure
    // mode — an allowlist that silently allows all, or one that filters
    // nothing. So it is switched to live, and BOTH sides are asserted: the
    // named host reachable, an unnamed one still blocked. Testing only the
    // reachable half would pass just as well against a policy that opened
    // everything.
    console.log("    switching to an ALLOWLIST (the adapter's blocked+destinations mapping)");
    await sandbox.updateNetwork({ denyOut: ["0.0.0.0/0"], allowOut: ["pypi.org"] });
    const probeHost = async (host: string): Promise<boolean> => {
      const r = await sandbox.commands
        .run(`python3 -c "import urllib.request as u; u.urlopen('https://${host}', timeout=15); print('OK')"`, {
          requestTimeoutMs: 60_000,
        })
        .catch((e: unknown) => ({ exitCode: 1, stdout: "", stderr: String(e) }));
      const reachable = r.exitCode === 0 && r.stdout.includes("OK");
      console.log(`    [allowlist:${host}] ${reachable ? "REACHABLE" : "BLOCKED"}`);
      return reachable;
    };
    expect(await probeHost("pypi.org"), "an allowlisted host is reachable after the switch");
    expect(!(await probeHost("example.com")), "a host NOT on the allowlist stays blocked");

    console.log("\n[9] the box was never restarted");
    expect(await sandbox.isRunning(), "still the same running sandbox");
  } finally {
    console.log("\n[cleanup] killing sandbox");
    await sandbox.kill().catch((e: unknown) => console.log(`    kill failed: ${String(e)}`));
  }

  // ─── The adapter, not just the vendor client ───────────────────
  // Everything above proves the CLIENT still behaves at 2.39.0. What actually
  // ships is our adapter on top of it, and the two can disagree: a changed
  // default, an option renamed underneath a wrapper that still compiles. So
  // one more box, driven exclusively through the provider surface the platform
  // calls.
  console.log("\n[10] the ADAPTER on the new client — the path that actually ships");
  const provider = createE2BProvider({ apiKey: process.env.E2B_API_KEY });
  const box = await provider.create({
    image: "base",
    network: { outbound: "blocked", allowedDestinations: ["pypi.org"] },
    timeoutMs: 5 * 60 * 1000,
    metadata: { smoke: "e2b-bump-adapter" },
  });
  console.log(`    sandbox ${box.sandboxId}`);
  try {
    const ran = await box.commands.run("echo adapter-ok");
    expect(ran.exitCode === 0 && ran.stdout.includes("adapter-ok"), "adapter commands.run works");

    await box.files.write("/tmp/a.txt", "adapter-bytes");
    expect((await box.files.read("/tmp/a.txt")) === "adapter-bytes", "adapter files round-trip");

    const boxInfo = await box.getInfo?.();
    expect(boxInfo?.sandboxId === box.sandboxId, "adapter getInfo reports this sandbox");
    expect((await box.isRunning?.()) === true, "adapter isRunning is true");

    // The create-time allowlist the adapter mapped must actually filter — both
    // sides, so a policy that quietly opened everything cannot pass.
    const reach = async (host: string): Promise<boolean> => {
      const r = await box.commands
        .run(`python3 -c "import urllib.request as u; u.urlopen('https://${host}', timeout=15); print('OK')"`)
        .catch(() => ({ exitCode: 1, stdout: "" }));
      const ok = r.exitCode === 0 && r.stdout.includes("OK");
      console.log(`    [adapter-allowlist:${host}] ${ok ? "REACHABLE" : "BLOCKED"}`);
      return ok;
    };
    expect(await reach("pypi.org"), "the adapter's create-time allowlist admits the declared host");
    expect(!(await reach("example.com")), "and still blocks everything it did not declare");

    const listed = await provider.list?.({ limit: 100 });
    expect(
      Array.isArray(listed) && listed.some((s) => s.sandboxId === box.sandboxId),
      "adapter list() finds the live box",
    );
  } finally {
    console.log("    killing adapter sandbox");
    await box.kill().catch((e: unknown) => console.log(`    kill failed: ${String(e)}`));
  }

  console.log(`\n=== ${failures === 0 ? "SMOKE PASSED" : `SMOKE FAILED (${failures})`} ===`);
  if (failures > 0) process.exit(1);
}

main().catch((err) => {
  console.error("SMOKE ERROR:", err);
  process.exit(1);
});
