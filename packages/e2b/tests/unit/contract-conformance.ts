/**
 * E2B ↔ SDK contract conformance (compile-time only).
 *
 * This file contains no runtime code. It is type-checked by
 * packages/sdk-ts/tests/unit/provider-parity.test.ts, which runs `tsc
 * --noEmit` over it and fails the unit suite on any error. If the E2B
 * provider drifts from the contract in packages/sdk-ts/src/types.ts, that
 * suite goes red instead of the mismatch surfacing at sandbox boot.
 *
 * The provider packages cannot `implements` the SDK's interfaces directly:
 * @evolvingmachines/sdk DEPENDS ON this package (build order is providers →
 * sdk), so importing the SDK here would be a package cycle, and importing it
 * by relative path from src/ breaks the tsup dts build with TS6059 (the file
 * is outside the package rootDir). Conformance is therefore proved from a
 * test file, which no bundle ever sees.
 */

import type {
  SandboxProvider as SdkSandboxProvider,
  SandboxInstance as SdkSandboxInstance,
  SandboxCommands as SdkSandboxCommands,
  SandboxFiles as SdkSandboxFiles,
  SandboxCreateOptions as SdkSandboxCreateOptions,
} from "../../../sdk-ts/src/types";

import type {
  SandboxProvider as E2BSandboxProviderInterface,
  SandboxInstance as E2BSandboxInstanceInterface,
  SandboxCommands as E2BSandboxCommandsInterface,
  SandboxFiles as E2BSandboxFilesInterface,
  SandboxCreateOptions as E2BSandboxCreateOptions,
} from "../../src/index";

import type { E2BProvider, E2BCommands, E2BFiles } from "../../src/index";

/** Fails to compile unless `Sub` is assignable to `Sup`. */
type AssertAssignable<Sup, Sub extends Sup> = Sub;

// ─── Concrete classes satisfy the SDK contract ──────────────────
// The strongest check: what createE2BProvider() actually hands the SDK.

export type _ProviderClass = AssertAssignable<SdkSandboxProvider, E2BProvider>;
export type _CommandsClass = AssertAssignable<SdkSandboxCommands, E2BCommands>;
export type _FilesClass = AssertAssignable<SdkSandboxFiles, E2BFiles>;

/** The sandbox impl class is not exported; take it off create()'s return type. */
type E2BInstanceImpl = Awaited<ReturnType<E2BProvider["create"]>>;
export type _InstanceClass = AssertAssignable<SdkSandboxInstance, E2BInstanceImpl>;

// ─── The package's own declared interfaces stay contract-shaped ──

export type _ProviderInterface = AssertAssignable<SdkSandboxProvider, E2BSandboxProviderInterface>;
export type _InstanceInterface = AssertAssignable<SdkSandboxInstance, E2BSandboxInstanceInterface>;
export type _CommandsInterface = AssertAssignable<SdkSandboxCommands, E2BSandboxCommandsInterface>;
export type _FilesInterface = AssertAssignable<SdkSandboxFiles, E2BSandboxFilesInterface>;

// ─── Create options, checked in the direction the SDK uses them ──
// The SDK builds an SdkSandboxCreateOptions and passes it to create(), so the
// SDK's options must be accepted by the provider's — the contravariant
// direction. TypeScript's bivariant method parameters do NOT check this, which
// is how E2B's `image: string` (required) sat next to the contract's optional
// `image?` unnoticed: the SDK could already call create({}) and hit the
// provider's "evolve-all" fallback with the type system asserting otherwise.

export type _CreateOptions = AssertAssignable<E2BSandboxCreateOptions, SdkSandboxCreateOptions>;
