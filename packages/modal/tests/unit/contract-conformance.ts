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

import type { ModalProvider, ModalCommands, ModalFiles } from "../../src/index";

/** Fails to compile unless `Sub` is assignable to `Sup`. */
type AssertAssignable<Sup, Sub extends Sup> = Sub;

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
