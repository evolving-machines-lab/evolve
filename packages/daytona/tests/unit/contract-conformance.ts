/**
 * Daytona ↔ SDK contract conformance (compile-time only).
 *
 * This file contains no runtime code. It is type-checked by
 * packages/sdk-ts/tests/unit/provider-parity.test.ts, which runs `tsc
 * --noEmit` over it and fails the unit suite on any error. If the Daytona
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
  SandboxProvider as DaytonaSandboxProviderInterface,
  SandboxInstance as DaytonaSandboxInstanceInterface,
  SandboxCommands as DaytonaSandboxCommandsInterface,
  SandboxFiles as DaytonaSandboxFilesInterface,
  SandboxCreateOptions as DaytonaSandboxCreateOptions,
} from "../../src/index";

import type { _testDaytonaSandboxImpl, DaytonaProvider, DaytonaCommands, DaytonaFiles } from "../../src/index";

/** Fails to compile unless `Sub` is assignable to `Sup`. */
type AssertAssignable<Sup, Sub extends Sup> = Sub;

// ─── Concrete classes satisfy the SDK contract ──────────────────

export type _ProviderClass = AssertAssignable<SdkSandboxProvider, DaytonaProvider>;
export type _CommandsClass = AssertAssignable<SdkSandboxCommands, DaytonaCommands>;
export type _FilesClass = AssertAssignable<SdkSandboxFiles, DaytonaFiles>;

/** The sandbox impl class is not exported; take it off create()'s return type. */
type DaytonaInstanceImpl = Awaited<ReturnType<DaytonaProvider["create"]>>;
export type _InstanceClass = AssertAssignable<SdkSandboxInstance, DaytonaInstanceImpl>;

// ─── The package's own declared interfaces stay contract-shaped ──

export type _ProviderInterface = AssertAssignable<SdkSandboxProvider, DaytonaSandboxProviderInterface>;
export type _InstanceInterface = AssertAssignable<SdkSandboxInstance, DaytonaSandboxInstanceInterface>;
export type _CommandsInterface = AssertAssignable<SdkSandboxCommands, DaytonaSandboxCommandsInterface>;
export type _FilesInterface = AssertAssignable<SdkSandboxFiles, DaytonaSandboxFilesInterface>;

// ─── Create options, checked in the direction the SDK uses them ──
// The SDK builds an SdkSandboxCreateOptions and passes it to create(), so the
// SDK's options must be accepted by the provider's — the contravariant
// direction, which TypeScript's bivariant method parameters do not check.

export type _CreateOptions = AssertAssignable<DaytonaSandboxCreateOptions, SdkSandboxCreateOptions>;


// ─── Optional capabilities keep ONE signature across every package ──
// A member declared `updateNetwork?()` on the SDK contract is satisfied by a
// provider that OMITS it, so plain assignability cannot catch a provider that
// ships the capability with the wrong shape — and the whole promise of an
// optional capability is that every provider offering it offers the same one.
//
// Two things are pinned, because two different mistakes are possible.
//
// The INTERFACE copy is the surface callers read. The IMPL class is what
// actually runs, and it needs its own check: create() is declared to return
// the local interface, so a seam reading create()'s return type never sees the
// class at all. TypeScript's bivariant method parameters then let a narrowed
// method satisfy `implements` silently — verified by narrowing the modal impl
// to `{ outbound: "open" }` and watching the whole suite stay green until
// these lines existed.
//
// The parameter comparison runs in the direction that matters: whatever the
// SDK would hand the provider must be ACCEPTED by it. Comparing the parameter
// TYPES rather than the function types is what defeats the bivariance.

type SdkUpdateNetwork = NonNullable<SdkSandboxInstance["updateNetwork"]>;
type SdkNetworkPolicyParam = Parameters<SdkUpdateNetwork>[0];

type DaytonaInterfaceUpdateNetwork = DaytonaSandboxInstanceInterface["updateNetwork"];
type DaytonaImplUpdateNetwork = _testDaytonaSandboxImpl["updateNetwork"];

export type _UpdateNetworkOnInterface = AssertAssignable<
  Parameters<DaytonaInterfaceUpdateNetwork>[0],
  SdkNetworkPolicyParam
>;
export type _UpdateNetworkOnImpl = AssertAssignable<
  Parameters<DaytonaImplUpdateNetwork>[0],
  SdkNetworkPolicyParam
>;
