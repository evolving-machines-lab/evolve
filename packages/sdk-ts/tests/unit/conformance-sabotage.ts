/**
 * THE SEAM GUARDING THE SEAM. This file is EXPECTED TO FAIL to compile.
 *
 * provider-parity.test.ts compiles it on purpose and asserts two things: that
 * the compiler rejected it, and that the error NAMES the sabotaged member.
 * Both halves matter — an assertion that fails for an unrelated reason (a
 * typo, a missing import) would look exactly like success from the outside,
 * and would leave the real seam unguarded while reporting green.
 *
 * WHY IT EXISTS. A conformance assertion that is silently wrong does not fail;
 * it passes everything. That is not hypothetical here: the parameter pins in
 * this repo were written twice before they worked. The first version read
 * create()'s return type, which resolves to the local INTERFACE and never sees
 * the impl class. The second wrapped the assertion in a generic helper, where
 * the constraint stopped being checked per instantiation. Both compiled
 * cleanly. Both caught nothing. Only deliberately breaking a member and
 * watching for the error told the difference — so that experiment lives here
 * as a test instead of in someone's terminal history.
 *
 * The sabotage mirrors the real shapes rather than inventing a toy: a REQUIRED
 * method (getHost), and an OPTIONAL parameterized one (prepareImage) — the
 * shape most likely to drift, since a provider may legally omit it entirely.
 */
import type { SandboxInstance, SandboxProvider } from "../../src/types";
import type { AssertAssignable, NarrowedParams } from "./conformance-helpers";

/** A sandbox that accepts ONE port. The contract promises any `number`. */
interface NarrowedPortSandbox extends Omit<SandboxInstance, "getHost"> {
  getHost(port: 8080): Promise<string>;
}

/** A provider whose optional prewarm takes ONE image name, not any string. */
interface NarrowedPrepareImageProvider extends Omit<SandboxProvider, "prepareImage"> {
  prepareImage(image: "only-this-one"): Promise<void>;
}

// EXPECTED ERROR: Type '"getHost"' does not satisfy the constraint 'never'.
export type _SabotageRequiredMember = AssertAssignable<
  never,
  NarrowedParams<SandboxInstance, NarrowedPortSandbox>
>;

// EXPECTED ERROR: Type '"prepareImage"' does not satisfy the constraint 'never'.
export type _SabotageOptionalMember = AssertAssignable<
  never,
  NarrowedParams<SandboxProvider, NarrowedPrepareImageProvider>
>;

/**
 * The control. A provider that accepts MORE than the contract is legal and
 * must NOT be flagged — without this, a pin that simply rejected everything
 * would pass the two cases above and look correct.
 */
interface WidenedPortSandbox extends Omit<SandboxInstance, "getHost"> {
  getHost(port: number | string): Promise<string>;
}
export type _ControlWidenedIsFine = AssertAssignable<
  never,
  NarrowedParams<SandboxInstance, WidenedPortSandbox>
>;
