/**
 * Modal ↔ SDK contract conformance (compile-time only).
 *
 * This file contains no runtime code. It is type-checked by
 * packages/sdk-ts/tests/unit/provider-parity.test.ts, which runs `tsc
 * --noEmit` over it and fails the unit suite on any error. If the Modal
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
  SandboxProvider as ModalSandboxProviderInterface,
  SandboxInstance as ModalSandboxInstanceInterface,
  SandboxCommands as ModalSandboxCommandsInterface,
  SandboxFiles as ModalSandboxFilesInterface,
  SandboxCreateOptions as ModalSandboxCreateOptions,
} from "../../src/index";

import type { _testModalSandboxImpl, ModalProvider, ModalCommands, ModalFiles } from "../../src/index";


// ─── Concrete classes satisfy the SDK contract ──────────────────

export type _ProviderClass = AssertAssignable<SdkSandboxProvider, ModalProvider>;
export type _CommandsClass = AssertAssignable<SdkSandboxCommands, ModalCommands>;
export type _FilesClass = AssertAssignable<SdkSandboxFiles, ModalFiles>;

/** The sandbox impl class is not exported; take it off create()'s return type. */
type ModalInstanceImpl = Awaited<ReturnType<ModalProvider["create"]>>;
export type _InstanceClass = AssertAssignable<SdkSandboxInstance, ModalInstanceImpl>;

// ─── The package's own declared interfaces stay contract-shaped ──

export type _ProviderInterface = AssertAssignable<SdkSandboxProvider, ModalSandboxProviderInterface>;
export type _InstanceInterface = AssertAssignable<SdkSandboxInstance, ModalSandboxInstanceInterface>;
export type _CommandsInterface = AssertAssignable<SdkSandboxCommands, ModalSandboxCommandsInterface>;
export type _FilesInterface = AssertAssignable<SdkSandboxFiles, ModalSandboxFilesInterface>;

// ─── Create options, checked in the direction the SDK uses them ──
// The SDK builds an SdkSandboxCreateOptions and passes it to create(), so the
// SDK's options must be accepted by the provider's — the contravariant
// direction, which TypeScript's bivariant method parameters do not check.

export type _CreateOptions = AssertAssignable<ModalSandboxCreateOptions, SdkSandboxCreateOptions>;


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

export type _ParamsInstanceInterface = AssertAssignable<never, NarrowedParams<SdkSandboxInstance, ModalSandboxInstanceInterface>>;
export type _ParamsInstanceImpl = AssertAssignable<never, NarrowedParams<SdkSandboxInstance, _testModalSandboxImpl>>;
export type _ParamsProviderInterface = AssertAssignable<never, NarrowedParams<SdkSandboxProvider, ModalSandboxProviderInterface>>;
// The provider CLASS carries prepareImage — optional AND parameterized, the
// exact shape that proved vulnerable.
export type _ParamsProviderClass = AssertAssignable<never, NarrowedParams<SdkSandboxProvider, ModalProvider>>;
export type _ParamsCommands = AssertAssignable<never, NarrowedParams<SdkSandboxCommands, ModalCommands>>;
export type _ParamsFiles = AssertAssignable<never, NarrowedParams<SdkSandboxFiles, ModalFiles>>;
