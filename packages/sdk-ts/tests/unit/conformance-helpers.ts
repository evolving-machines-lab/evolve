/**
 * The type-level assertions every provider's contract-conformance file is
 * built from. Compile-time only; no runtime code.
 *
 * ONE DEFINITION, THREE USERS, AND A SABOTAGE TEST. These lived as a copy per
 * provider package, which is fine until the day a copy is subtly wrong — and
 * a wrong assertion does not fail, it silently passes everything, which is the
 * one failure mode a conformance seam cannot afford. Defined once here so
 * conformance-sabotage.ts can prove THIS code catches a narrowing, and so
 * that proof covers all three providers rather than one copy of it.
 */

/** Fails to compile unless `Sub` is assignable to `Sup`. */
export type AssertAssignable<Sup, Sub extends Sup> = Sub;

/**
 * The members whose PARAMETERS are narrower than the contract's — ideally
 * `never`, and the member's name when not.
 *
 * WHY THIS IS NEEDED AT ALL, given the assignability checks that surround it:
 * TypeScript compares method parameters BIVARIANTLY. A member that accepts
 * LESS than the contract promises still satisfies `implements` and still
 * satisfies interface assignability — it fails only at runtime, on the caller
 * who passes the value the contract said was legal. Narrowing
 * `getHost(port: number)` to `getHost(port: 8080)`, or `prepareImage`'s
 * optional string to a single literal, left the entire parity suite green
 * before this existed.
 *
 * Parameters are therefore compared as TUPLE types, which are not subject to
 * that bivariance, in the one direction that matters: whatever the SDK would
 * pass must be ACCEPTED by the provider. Accepting MORE than the contract
 * stays perfectly legal.
 *
 * `NonNullable` is what lets this cover OPTIONAL members — `prepareImage?`,
 * `updateNetwork?` — which are exactly the shape most likely to drift, since
 * a provider may legally omit them entirely.
 */
export type NarrowedParams<Contract, Impl> = {
  [K in keyof Contract & keyof Impl]: NonNullable<Contract[K]> extends (
    ...a: infer ContractArgs
  ) => unknown
    ? NonNullable<Impl[K]> extends (...a: infer ImplArgs) => unknown
      ? ContractArgs extends ImplArgs
        ? never
        : K
      : never
    : never;
}[keyof Contract & keyof Impl];

/**
 * HOW TO APPLY IT, and the one way that looks nicer but does not work.
 *
 * Write the assertion out with CONCRETE types at each use:
 *
 *   export type _Params = AssertAssignable<never, NarrowedParams<Contract, Impl>>;
 *
 * Do NOT wrap that pair in a generic helper of your own. A constraint inside a
 * generic alias body is checked against the alias's own type PARAMETERS, and
 * with a deferred conditional type in the way it is never re-checked per
 * instantiation — so the helper compiles happily while every narrowing sails
 * through it. That was tried, and it silently passed all three sabotage cases
 * until the indirection was removed.
 */
