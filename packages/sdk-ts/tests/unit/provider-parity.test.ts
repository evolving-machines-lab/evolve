/**
 * Provider Parity Check
 *
 * Compile-time + runtime verification that all sandbox providers expose the
 * API surface the SDK expects, against the one contract in src/types.ts.
 *
 * The compile-time half is enforced by the `tsc --noEmit` run at the bottom of
 * this file, NOT by the test runner. Unit tests execute under tsx, which
 * strips types without checking them, and the package's own `tsc --noEmit`
 * excludes `**\/*.test.ts` — so before that run existed, the type assertions
 * in this file were checked by nothing at all and drift could ship silently.
 *
 * Two layers are checked:
 *   - this file: the SHIPPED provider types (dist/*.d.ts) vs the contract
 *   - packages/{e2b,daytona,modal}/tests/unit/contract-conformance.ts:
 *     each provider's SOURCE, including its concrete classes and the
 *     create-options direction TypeScript's bivariant methods hide
 */

import type {
  SandboxProvider,
  SandboxInstance,
  SandboxCommands,
  SandboxFiles,
} from "../../src/types";

// ─── Type-level assignability checks ────────────────────────────
// Provider classes implement their own local SandboxProvider interface.
// These checks verify their interfaces are assignable to the SDK's canonical ones.

import type {
  SandboxProvider as E2BSandboxProvider,
  SandboxInstance as E2BSandboxInstance,
  SandboxCommands as E2BSandboxCommands,
  SandboxFiles as E2BSandboxFiles,
} from "@evolvingmachines/e2b";

import type {
  SandboxProvider as DaytonaSandboxProvider,
  SandboxInstance as DaytonaSandboxInstance,
  SandboxCommands as DaytonaSandboxCommands,
  SandboxFiles as DaytonaSandboxFiles,
} from "@evolvingmachines/daytona";

import type {
  SandboxProvider as ModalSandboxProvider,
  SandboxInstance as ModalSandboxInstance,
  SandboxCommands as ModalSandboxCommands,
  SandboxFiles as ModalSandboxFiles,
} from "@evolvingmachines/modal";

// E2B → SDK canonical
type _E2BProvider = E2BSandboxProvider extends SandboxProvider ? true : never;
type _E2BInstance = E2BSandboxInstance extends SandboxInstance ? true : never;
type _E2BCommands = E2BSandboxCommands extends SandboxCommands ? true : never;
type _E2BFiles = E2BSandboxFiles extends SandboxFiles ? true : never;

const _e2b1: _E2BProvider = true;
const _e2b2: _E2BInstance = true;
const _e2b3: _E2BCommands = true;
const _e2b4: _E2BFiles = true;

// Daytona → SDK canonical
type _DaytonaProvider = DaytonaSandboxProvider extends SandboxProvider ? true : never;
type _DaytonaInstance = DaytonaSandboxInstance extends SandboxInstance ? true : never;
type _DaytonaCommands = DaytonaSandboxCommands extends SandboxCommands ? true : never;
type _DaytonaFiles = DaytonaSandboxFiles extends SandboxFiles ? true : never;

const _daytona1: _DaytonaProvider = true;
const _daytona2: _DaytonaInstance = true;
const _daytona3: _DaytonaCommands = true;
const _daytona4: _DaytonaFiles = true;

// Modal → SDK canonical
type _ModalProvider = ModalSandboxProvider extends SandboxProvider ? true : never;
type _ModalInstance = ModalSandboxInstance extends SandboxInstance ? true : never;
type _ModalCommands = ModalSandboxCommands extends SandboxCommands ? true : never;
type _ModalFiles = ModalSandboxFiles extends SandboxFiles ? true : never;

const _modal1: _ModalProvider = true;
const _modal2: _ModalInstance = true;
const _modal3: _ModalCommands = true;
const _modal4: _ModalFiles = true;

// ─── Runtime checks ─────────────────────────────────────────────

import { createE2BProvider } from "@evolvingmachines/e2b";
import { createDaytonaProvider } from "@evolvingmachines/daytona";
import { createModalProvider } from "@evolvingmachines/modal";

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** packages/sdk-ts/tests/unit → repo root */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** Files the compiler must accept for the contract to be considered intact. */
const CONFORMANCE_FILES = [
  "packages/e2b/tests/unit/contract-conformance.ts",
  "packages/daytona/tests/unit/contract-conformance.ts",
  "packages/modal/tests/unit/contract-conformance.ts",
  "packages/sdk-ts/tests/unit/provider-parity.test.ts",
];

// Methods the SDK actually calls
const REQUIRED_PROVIDER = ["providerType", "create", "connect"] as const;

function checkMethods(obj: Record<string, unknown>, required: readonly string[], label: string): string[] {
  const missing: string[] = [];
  for (const method of required) {
    if (!(method in obj)) {
      missing.push(`${label}.${method}`);
    }
  }
  return missing;
}

let passed = 0;
let failed = 0;

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

console.log("\n═══ Provider Parity Check ═══\n");

// E2B
console.log("E2B:");
const e2b = createE2BProvider({ apiKey: "test-key" });
let missing = checkMethods(e2b as any, REQUIRED_PROVIDER, "E2BProvider");
assert(missing.length === 0, `implements SandboxProvider${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);
assert(e2b.providerType === "e2b", `providerType = "e2b"`);

// Daytona
console.log("\nDaytona:");
const daytona = createDaytonaProvider({ apiKey: "test-key" });
missing = checkMethods(daytona as any, REQUIRED_PROVIDER, "DaytonaProvider");
assert(missing.length === 0, `implements SandboxProvider${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);
assert(daytona.providerType === "daytona", `providerType = "daytona"`);

// Modal
console.log("\nModal:");
const modal = createModalProvider({ tokenId: "test-id", tokenSecret: "test-secret" });
missing = checkMethods(modal as any, REQUIRED_PROVIDER, "ModalProvider");
assert(missing.length === 0, `implements SandboxProvider${missing.length ? ` — missing: ${missing.join(", ")}` : ""}`);
assert(modal.providerType === "modal", `providerType = "modal"`);

// Factory parity
console.log("\nFactories:");
assert(typeof createE2BProvider === "function", "createE2BProvider exists");
assert(typeof createDaytonaProvider === "function", "createDaytonaProvider exists");
assert(typeof createModalProvider === "function", "createModalProvider exists");

// ─── Sandbox user + network options: all providers enforce them now ───

(async () => {
  // Daytona enforces the user option (create-time OS user / root sudo
  // wrapper) and the network policy instead of rejecting them. Checks stay
  // offline: create() validates the network policy before any API call, so
  // an invalid combo / unenforceable destination proves the options passed
  // capability validation.
  console.log("\nDaytona enforcement (user + network accepted, constraints typed):");
  let daytonaUserError = "";
  try {
    await daytona.create({
      image: "evolve-all",
      user: "worker",
      network: { outbound: "open", allowedDestinations: ["api.example.com"] },
    });
  } catch (error) {
    daytonaUserError = String(error);
  }
  assert(
    !daytonaUserError.includes("sandbox user option") && !daytonaUserError.includes("does not yet implement"),
    "Daytona accepts the sandbox user option (create-time OS user / sudo wrapper)",
  );
  assert(
    daytonaUserError.includes("only valid when outbound is blocked"),
    "Daytona validates network policy (open + allowedDestinations rejected) instead of rejecting all policies",
  );

  let daytonaIpv6Error = "";
  try {
    await daytona.create({
      image: "evolve-all",
      network: { outbound: "blocked", allowedDestinations: ["2001:db8::1"] },
    });
  } catch (error) {
    daytonaIpv6Error = String(error);
  }
  assert(
    daytonaIpv6Error.includes("DaytonaNetworkPolicyError") || daytonaIpv6Error.includes("IPv4"),
    "Daytona typed-rejects destinations it cannot enforce (IPv6) instead of silently weakening",
  );

  // Modal enforces the user option (su wrapper) and the network policy instead
  // of rejecting them. Both checks below stay offline: create() validates the
  // 24h lifetime cap and the network combo before any API call, so an over-cap
  // timeout / invalid combo proves the options passed capability validation.
  console.log("\nModal enforcement (user + network accepted, constraints typed):");
  let modalUserError = "";
  try {
    await modal.create({
      image: "evolve-all",
      user: "worker",
      timeoutMs: 25 * 3600 * 1000,
    });
  } catch (error) {
    modalUserError = String(error);
  }
  assert(
    !modalUserError.includes("sandbox user option") && !modalUserError.includes("does not yet implement"),
    "Modal accepts the sandbox user option (enforced via su wrapper)",
  );
  assert(
    modalUserError.includes("24h"),
    "Modal enforces the 24h lifetime cap with a typed error pointing at checkpoints",
  );

  let modalNetworkError = "";
  try {
    await modal.create({
      image: "evolve-all",
      timeoutMs: 1000,
      network: { outbound: "open", allowedDestinations: ["api.example.com"] },
    });
  } catch (error) {
    modalNetworkError = String(error);
  }
  assert(
    modalNetworkError.includes("only valid when outbound is blocked"),
    "Modal validates network policy (open + allowedDestinations rejected) instead of rejecting all policies",
  );

  // ─── Contract conformance, actually compiled ────────────────────
  // tsx runs this file without type-checking it, so the assertions above are
  // only real if something invokes the compiler. This does, over this file
  // (shipped provider types) and each provider's conformance file (provider
  // source + concrete classes). A drifted member fails the unit suite here.

  console.log("\nContract conformance (tsc --noEmit):");
  const check = spawnSync(
    process.execPath,
    [
      resolve(REPO_ROOT, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--target", "es2022",
      "--module", "esnext",
      "--moduleResolution", "bundler",
      "--esModuleInterop",
      "--skipLibCheck",
      "--forceConsistentCasingInFileNames",
      ...CONFORMANCE_FILES.map((f) => resolve(REPO_ROOT, f)),
    ],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  if (check.status !== 0) {
    console.error((check.stdout || "") + (check.stderr || ""));
  }
  assert(
    check.status === 0,
    `all ${CONFORMANCE_FILES.length} conformance files type-check against src/types.ts`,
  );

  // ─── The seam guarding the seam ────────────────────────────────
  // A conformance assertion that is silently wrong does not fail; it passes
  // everything. So the pins are proved by BREAKING something and watching for
  // the error, not by watching green. conformance-sabotage.ts narrows a
  // required member and an optional parameterized one, and must be REJECTED —
  // naming both — while its widened control stays legal.

  console.log("\nSeam sabotage (the pins must actually reject a narrowing):");
  const sabotageFile = resolve(REPO_ROOT, "packages/sdk-ts/tests/unit/conformance-sabotage.ts");
  const sabotage = spawnSync(
    process.execPath,
    [
      resolve(REPO_ROOT, "node_modules/typescript/bin/tsc"),
      "--noEmit",
      "--strict",
      "--target", "es2022",
      "--module", "esnext",
      "--moduleResolution", "bundler",
      "--esModuleInterop",
      "--skipLibCheck",
      "--forceConsistentCasingInFileNames",
      sabotageFile,
    ],
    { encoding: "utf8", cwd: REPO_ROOT },
  );
  const sabotageOut = (sabotage.stdout || "") + (sabotage.stderr || "");
  assert(sabotage.status !== 0, "a narrowed member is REJECTED (the pins are not vacuous)");
  // Named, not merely "some error": an unrelated compile failure — a typo, a
  // renamed import — would otherwise read exactly like a working seam.
  assert(
    sabotageOut.includes(`Type '"getHost"' does not satisfy`),
    "the rejection NAMES the narrowed required member (getHost)",
  );
  assert(
    sabotageOut.includes(`Type '"prepareImage"' does not satisfy`),
    "and names the narrowed OPTIONAL parameterized member (prepareImage)",
  );
  // THE CONTROL, and it has to be exact. A pin that rejected EVERYTHING would
  // pass both assertions above and look perfect, so the sabotage file also
  // holds a member that accepts MORE than the contract — which is legal. Two
  // errors and no more is the proof the pin discriminates rather than blankets.
  const sabotageErrors = sabotageOut
    .split("\n")
    .filter((line) => line.includes("error TS")).length;
  assert(
    sabotageErrors === 2,
    `exactly the two narrowings are flagged and the widened control is not (saw ${sabotageErrors} errors)`,
  );

  console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
  if (failed > 0) process.exit(1);
})();
