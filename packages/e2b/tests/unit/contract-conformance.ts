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

import type { AssertAssignable, NarrowedParams } from "../../../sdk-ts/tests/unit/conformance-helpers";

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

import type { _testE2BSandboxImpl, E2BProvider, E2BCommands, E2BFiles } from "../../src/index";


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


// ─── Every member's parameters, pinned against the contract ──
// WHY A GENERIC AND NOT A LIST: the checks above prove the provider is
// ASSIGNABLE to the contract, which sounds like it covers parameters and does
// not. TypeScript compares method parameters BIVARIANTLY, so a member that
// accepts LESS than the contract promises still satisfies `implements` and
// still satisfies assignability — it fails only at runtime, on the caller who
// passes the value the contract said was legal.
//
// Demonstrated, not assumed: narrowing `getHost(port: number)` to
// `getHost(port: 8080)`, and `prepareImage(image?: string)` to a single string
// literal, both left this entire suite green before these lines existed.
//
// So parameters are compared as TUPLE TYPES, which are not subject to the
// bivariance, in the one direction that matters: whatever the SDK would pass
// must be ACCEPTED. Accepting more than the contract is fine and stays legal.
// The generic form means a member added to the contract tomorrow is covered
// the day it lands, with nobody remembering to extend a list.


// Each assertion below is written OUT, with AssertAssignable applied to
// concrete types. Wrapping it in a generic helper looks tidier and silently
// stops working: a constraint inside a generic alias body is checked against
// the alias's own type PARAMETERS, and with a deferred conditional in the way
// it is never re-checked per instantiation — so the helper compiled happily
// while every narrowing sailed through. Verified by narrowing getHost,
// prepareImage and updateNetwork in turn.
//
// Failure reads: `Type '"getHost"' does not satisfy the constraint 'never'`,
// which names the offending member.

export type _ParamsInstanceInterface = AssertAssignable<never, NarrowedParams<SdkSandboxInstance, E2BSandboxInstanceInterface>>;
export type _ParamsInstanceImpl = AssertAssignable<never, NarrowedParams<SdkSandboxInstance, _testE2BSandboxImpl>>;
export type _ParamsProviderInterface = AssertAssignable<never, NarrowedParams<SdkSandboxProvider, E2BSandboxProviderInterface>>;
// The provider CLASS carries prepareImage — optional AND parameterized, the
// exact shape that proved vulnerable.
export type _ParamsProviderClass = AssertAssignable<never, NarrowedParams<SdkSandboxProvider, E2BProvider>>;
export type _ParamsCommands = AssertAssignable<never, NarrowedParams<SdkSandboxCommands, E2BCommands>>;
export type _ParamsFiles = AssertAssignable<never, NarrowedParams<SdkSandboxFiles, E2BFiles>>;
