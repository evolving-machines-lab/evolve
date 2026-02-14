/**
 * Provider Parity Check
 *
 * Compile-time + runtime verification that all sandbox providers
 * expose the same API surface expected by the SDK.
 *
 * If this file fails to compile, a provider has drifted from the
 * SDK's canonical interfaces in types.ts.
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

console.log(`\n═══ ${passed} passed, ${failed} failed ═══\n`);
if (failed > 0) process.exit(1);
