/**
 * The DIRECTION rule of the cross-repo contract gates, in one place.
 *
 * The spec-reading gates in this directory hold the SDK to spec/openapi.yaml,
 * which lives in the private server repo. Until this file existed they held it
 * with plain equality in both directions, and that is wrong for one of them:
 * the two repos do not ship together. The server merges a wave and its spec
 * names the new operations and error codes immediately; the SDK learns them in
 * the publish that follows. Between those two moments the spec is a strict
 * SUPERSET of the SDK — the normal, intended, pre-publish state — and equality
 * turned it into a red build that says "drift" about work nobody got wrong.
 *
 * So the law is asymmetric, and it is the same law the server repo already
 * encodes in its own parity test (swarm_dashboard's
 * __tests__/lib/evaluations-error-code-parity.test.ts, the preTeamsSdk /
 * preJobSecretsSdk sentinels):
 *
 *   SPEC AHEAD OF SDK — legal, and only while it is DECLARED. A member the
 *   spec has and the SDK lacks is tolerated when a lane below claims it, and
 *   the toleration is loud: the notice names every member the SDK owes. A
 *   member no lane claims is drift and still fails, so this is a door for
 *   sequenced work, not a hole.
 *
 *   SDK AHEAD OF SPEC — always a hard fail. The SDK cannot invent an operation
 *   or a code the contract does not declare; that is the direction that ships
 *   a lie to callers.
 *
 *   SHARED MEMBERS DIVERGING — always a hard fail. Everything both sides have
 *   must agree, and on ordered axes it must agree in the spec's order. Lag
 *   never excuses a mismatch inside the overlap.
 *
 * SELF-ARMING, so a lane cannot outlive its wave. A lane is tolerated only
 * while the SDK has adopted NONE of it. The moment the SDK gains any single
 * member, the whole lane must match byte-exact — a half-adopted lane fails
 * exactly like drift, because that is what it is. The lane's entry below then
 * becomes dead weight that the next reader deletes; it can never hide the
 * next wave's mistake.
 *
 * STRICT MODE turns the door off entirely: with EVOLVE_SPEC_GATE_STRICT=1 the
 * only passing state is full equality. Who sets it, exactly:
 *
 *   stable release  -> strict. A stable package is the SDK's final answer to
 *                      the contract, so the lag that is legal on a topic
 *                      branch cannot reach the callers who install it.
 *   dev prerelease  -> tolerant. A dev prerelease is the lag period's own
 *                      vehicle: a deploy train publishes one precisely so the
 *                      server can go live while the SDK side is still landing.
 *   routine gates   -> tolerant (spec-gate.yml here, sdk-spec-gate.yml in the
 *                      server repo leave it unset).
 *
 * Tolerant is not lax: the hard failures below — SDK ahead of the spec, a
 * half-adopted lane, an undeclared lag — fail in either mode.
 */

/**
 * One deliberately-sequenced wave, on one axis. `members` is the complete set
 * that wave adds — completeness is what makes the self-arming check mean
 * "adopted none of it" rather than "adopted none of the ones I remembered".
 */
export interface LagLane {
  /** Printed in the notice: the wave, in the words the spec uses for it. */
  readonly name: string;
  /** Printed under the name: why this lane may lead the SDK at all. */
  readonly why: string;
  readonly members: readonly string[];
}

export interface LagVerdict {
  /** May the caller's assertion pass? */
  readonly ok: boolean;
  /** True when the lists already match exactly — no lag, nothing tolerated. */
  readonly inSync: boolean;
  /** The hard-fail sentence, when `ok` is false. */
  readonly failure: string | null;
  /** The loud block to print before the assertion, when a lag is tolerated. */
  readonly notice: string | null;
  /** Every member the spec has and the SDK lacks. */
  readonly behind: readonly string[];
}

/**
 * Set by the publish workflow. Read once, at module load, so every axis in a
 * run answers to the same mode.
 */
export const SPEC_GATE_STRICT = process.env.EVOLVE_SPEC_GATE_STRICT === "1";

const RULE = "─".repeat(78);

function noticeFor(unit: string, lanes: readonly { lane: LagLane; behind: readonly string[] }[]): string {
  const lines: string[] = [
    "",
    RULE,
    `  SPEC LEADS SDK — deliberately-sequenced lag, tolerated (not strict mode)`,
    RULE,
  ];
  for (const { lane, behind } of lanes) {
    lines.push(`  lane: ${lane.name}`);
    lines.push(`  why:  ${lane.why}`);
    lines.push(`  the SDK is behind on ${behind.length} ${unit}${behind.length === 1 ? "" : "s"}:`);
    for (const member of behind) lines.push(`      - ${member}`);
    lines.push("");
  }
  lines.push(
    "  This gate re-arms itself: the moment the SDK gains ANY member of a lane",
    "  above, that whole lane must match the spec byte-exact. Set",
    "  EVOLVE_SPEC_GATE_STRICT=1 to forbid the lag outright — a STABLE release",
    "  does, so no stable package can ship while the SDK is behind.",
    RULE,
    "",
  );
  return lines.join("\n");
}

/**
 * Judge one axis of the SDK against the same axis of the contract.
 *
 * `ordered` says whether the shared members' order is part of what is pinned:
 * true for the enums (they are compared byte-exactly, so a reordering is a
 * real change), false for the operation map (a map has no order to keep).
 */
export function assessSpecLag(options: {
  /** What the SDK carries today. */
  readonly sdk: readonly string[];
  /** What the contract declares. */
  readonly spec: readonly string[];
  /** The declared waves the spec is allowed to lead on, for THIS axis. */
  readonly lanes: readonly LagLane[];
  /** The word for one member, for printed text: "operation", "error code". */
  readonly unit: string;
  /**
   * How THIS axis catches up, in its own words ("state their SDK answer in the
   * map", "add them to src/hosted/types.ts"). Printed when the SDK is behind on
   * something no lane declares — the one failure whose fix is axis-specific.
   */
  readonly remedy: string;
  readonly ordered: boolean;
}): LagVerdict {
  const { sdk, spec, lanes, unit, remedy, ordered } = options;
  const sdkHas = new Set(sdk);
  const specHas = new Set(spec);

  const fail = (failure: string): LagVerdict => ({
    ok: false,
    inSync: false,
    failure,
    notice: null,
    behind: spec.filter((member) => !sdkHas.has(member)),
  });

  // Direction 1, always fatal: the SDK claiming something the contract does
  // not declare. No wave can be "ahead" this way — the contract is written
  // first, by definition.
  const invented = sdk.filter((member) => !specHas.has(member));
  if (invented.length > 0) {
    return fail(`the SDK carries ${unit}s the spec does not declare: ${invented.join(", ")}`);
  }

  // Direction 2, always fatal: the overlap disagreeing. Compare the spec
  // narrowed to what the SDK actually has — that is the SDK's list as the
  // contract would order it, so a difference is a genuine reordering and not
  // an artifact of the members the SDK is simply behind on.
  if (ordered) {
    const shared = spec.filter((member) => sdkHas.has(member));
    if (JSON.stringify(shared) !== JSON.stringify([...sdk])) {
      return fail(
        `the ${unit}s both sides carry are in different orders: ` +
          `SDK [${sdk.join(", ")}] vs the spec's order [${shared.join(", ")}]`,
      );
    }
  }

  const behind = spec.filter((member) => !sdkHas.has(member));
  if (behind.length === 0) {
    return { ok: true, inSync: true, failure: null, notice: null, behind };
  }

  // From here the spec leads. Everything below decides whether that is the
  // legal pre-publish state or drift wearing its clothes.

  if (SPEC_GATE_STRICT) {
    return fail(
      `EVOLVE_SPEC_GATE_STRICT=1 and the SDK is behind the contract on ` +
        `${behind.length} ${unit}${behind.length === 1 ? "" : "s"}: ${behind.join(", ")} ` +
        "(publish only after the SDK carries the whole contract)",
    );
  }

  const undeclared = behind.filter(
    (member) => !lanes.some((lane) => lane.members.includes(member)),
  );
  if (undeclared.length > 0) {
    return fail(
      `the SDK is behind on ${unit}s no lane declares: ${undeclared.join(", ")} ` +
        `— ${remedy}, or declare the wave as a lane in tests/unit/spec-lag.ts ` +
        "with the reason it may lead",
    );
  }

  // Self-arming: a lane the SDK has started adopting is no longer sequenced
  // work, it is an unfinished edit, and it is held to the same equality as
  // everything else.
  const halfAdopted = lanes.filter(
    (lane) =>
      lane.members.some((member) => sdkHas.has(member)) &&
      lane.members.some((member) => !sdkHas.has(member)),
  );
  if (halfAdopted.length > 0) {
    const detail = halfAdopted
      .map(
        (lane) =>
          `${lane.name} (has ${lane.members.filter((m) => sdkHas.has(m)).join(", ")}; ` +
          `still missing ${lane.members.filter((m) => !sdkHas.has(m)).join(", ")})`,
      )
      .join("; ");
    return fail(
      `a lane is half-adopted, so its lag is no longer tolerated — finish it: ${detail}`,
    );
  }

  const touched = lanes
    .map((lane) => ({ lane, behind: lane.members.filter((member) => !sdkHas.has(member)) }))
    .filter((entry) => entry.behind.length > 0);

  return {
    ok: true,
    inSync: false,
    failure: null,
    notice: noticeFor(unit, touched),
    behind,
  };
}

// =============================================================================
// THE DECLARED LANES
//
// One entry per wave the contract has landed and the SDK has not published
// yet. Each is deleted — not amended — by whoever publishes the SDK that
// serves it, and the gate makes that unmissable: the lane's own axis fails on
// the first adopted member until the lane is complete, and then the entry is
// simply unreferenced.
// =============================================================================

const TEAMS_WHY =
  "x-wave: 4 — the server lands team accounts first, the SDK serves them at its next publish";

const TASK_ENV_CONSENT_WHY =
  "parity wave — the server lands the task-env consent gate first, the SDK serves it at its next publish";

/**
 * The operations axis — spec operationId against the hand-maintained
 * operationId -> client-method map. These twelve are the spec's complete
 * `x-wave: 4` set.
 */
export const OPERATION_LAG_LANES: readonly LagLane[] = [
  {
    name: "team accounts (orgs, members, invite links)",
    why: TEAMS_WHY,
    members: [
      "listOrgs",
      "createOrg",
      "getOrg",
      "updateOrg",
      "deleteOrg",
      "listOrgMembers",
      "updateOrgMember",
      "removeOrgMember",
      "listOrgInvites",
      "createOrgInvite",
      "revokeOrgInvite",
      "acceptOrgInvite",
    ],
  },
];

/**
 * The error-code axis — the contract's ErrorCode enum against both copies the
 * SDK ships: the HOSTED_ERROR_CODES list and the hosted-error-codes.json
 * shadow the Python SDK reads. Same wave as the operations above, plus
 * `read_only_key`, which is the 403 every mutating org verb answers with.
 */
export const ERROR_CODE_LAG_LANES: readonly LagLane[] = [
  {
    name: "team accounts (orgs, members, invite links)",
    why: TEAMS_WHY,
    members: [
      "read_only_key",
      "org_not_found",
      "org_slug_taken",
      "org_forbidden",
      "org_personal_immutable",
      "org_last_owner",
      "org_in_use",
      "org_member_not_found",
      "invite_not_found",
      "invite_invalid",
    ],
  },
  {
    // A task's [environment.env] may ask for a secret by name; the job's
    // owner satisfies it by ATTACHING one. A selected task whose request
    // nothing satisfies — and whose declaration states no `${VAR:-default}`
    // fallback — is refused at job create with this code. Deliberately not
    // `secret_not_found`: the row usually DOES exist in the owner's vault, and
    // the remedy is to attach it to the job rather than to create it, so a
    // client that branches on the code would send the caller the wrong way.
    //
    // ONE MEMBER, so the self-arming rule is at its sharpest here: the moment
    // the SDK learns this code, this lane must be deleted rather than adjusted.
    // The shadow regeneration (hosted-error-codes.json) is the staging
    // assembly's lockstep commit under strict mode, not this branch's.
    name: "task-env consent gate (attach-is-consent)",
    why: TASK_ENV_CONSENT_WHY,
    members: ["secret_not_attached"],
  },
];
