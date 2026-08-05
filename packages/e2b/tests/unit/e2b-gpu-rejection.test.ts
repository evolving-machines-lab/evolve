#!/usr/bin/env tsx
/**
 * Unit Test: E2B GPU rejection — offline, typed, before any API call.
 *
 * e2b offers no GPU allocation at any tier: neither Template.build nor
 * Sandbox.create takes a GPU parameter. The provider law (SandboxCreateOptions
 * doc in the SDK) says reject what cannot be enforced, never silently ignore —
 * a `resources.gpu` request that fell through would boot a CPU box and mis-run
 * the caller's GPU workload with no trace of the downgrade.
 *
 * Usage:
 *   npx tsx tests/unit/e2b-gpu-rejection.test.ts
 */

import { E2BResourcesError, createE2BProvider } from "../../src/index.ts";

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

async function main(): Promise<void> {
  console.log("\n[1] create() - GPU request typed-rejected offline");
  const provider = createE2BProvider({ apiKey: "test-key" });

  let gpuError: unknown;
  try {
    await provider.create({ resources: { gpu: 1 } });
  } catch (e) {
    gpuError = e;
  }
  assert(gpuError instanceof E2BResourcesError, "resources.gpu throws E2BResourcesError");
  assert(
    String(gpuError).includes("no GPU allocation"),
    "the message states e2b has no GPU offering (not a create-time-only limitation)"
  );
  assert(String(gpuError).includes("modal"), "the message points at the provider that CAN");

  let typesError: unknown;
  try {
    await provider.create({ resources: { gpuTypes: ["H100"] } });
  } catch (e) {
    typesError = e;
  }
  assert(typesError instanceof E2BResourcesError, "resources.gpuTypes alone is rejected too");

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
