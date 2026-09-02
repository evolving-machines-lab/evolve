"""The DIRECTION rule of the cross-repo contract gates — the Python mirror of
the TypeScript SDK's ``tests/unit/spec-lag.ts``, holding the same law with the
same lanes.

The spec-reading gates hold this SDK to ``spec/openapi.yaml``, which lives in
the private server repo. Plain equality is the wrong test in one direction,
because the two repos do not ship together: the server merges a wave and its
spec names the new operations and error codes immediately, while this SDK
learns them in the publish that follows. Between those two moments the spec is
a strict SUPERSET of the SDK — the normal, intended, pre-publish state — and
equality turned it into a red build that said "drift" about work nobody got
wrong.

So the law is asymmetric, and it is the law the server repo already encodes in
its own parity test (``__tests__/lib/evaluations-error-code-parity.test.ts``,
the ``preTeamsSdk`` / ``preJobSecretsSdk`` sentinels):

* SPEC AHEAD OF SDK — legal, and only while it is DECLARED. A member the spec
  has and the SDK lacks is tolerated when a lane below claims it, and the
  toleration is loud: the notice names every member the SDK owes. A member no
  lane claims is drift and still fails, so this is a door for sequenced work,
  not a hole.

* SDK AHEAD OF SPEC — always a hard fail. This SDK cannot invent an operation
  or a code the contract does not declare; that is the direction that ships a
  lie to callers.

* SHARED MEMBERS DIVERGING — always a hard fail. Everything both sides have
  must agree, and on ordered axes in the spec's order. Lag never excuses a
  mismatch inside the overlap.

SELF-ARMING, so a lane cannot outlive its wave: a lane is tolerated only while
the SDK has adopted NONE of it. The moment the SDK gains any single member the
whole lane must match byte-exact — a half-adopted lane fails exactly like
drift, because that is what it is.

STRICT MODE turns the door off: with ``EVOLVE_SPEC_GATE_STRICT=1`` the only
passing state is full equality. Who sets it, exactly:

    stable release  -> strict. A stable package is the SDK's final answer to
                       the contract, so the lag that is legal on a topic branch
                       cannot reach the callers who install it.
    dev prerelease  -> tolerant. A dev prerelease is the lag period's own
                       vehicle: a deploy train publishes one precisely so the
                       server can go live while the SDK side is still landing.
    routine gates   -> tolerant (spec-gate.yml in the SDK repo,
                       sdk-spec-gate.yml in the server repo, both leave it
                       unset).

Tolerant is not lax: the hard failures — SDK ahead of the spec, a half-adopted
lane, an undeclared lag — fail in either mode.
"""

import os
import warnings
from dataclasses import dataclass


@dataclass(frozen=True)
class LagLane:
    """One deliberately-sequenced wave, on one axis.

    ``members`` is the COMPLETE set that wave adds — completeness is what makes
    the self-arming check mean "adopted none of it" rather than "adopted none
    of the ones I remembered".
    """

    name: str
    why: str
    members: 'tuple[str, ...]'


@dataclass(frozen=True)
class LagVerdict:
    ok: bool
    in_sync: bool
    failure: 'str | None'
    notice: 'str | None'
    behind: 'tuple[str, ...]'


# Read once, at import, so every axis in a run answers to the same mode.
SPEC_GATE_STRICT = os.environ.get('EVOLVE_SPEC_GATE_STRICT') == '1'

_RULE = '─' * 78


def _notice_for(unit: str, touched: 'list[tuple[LagLane, list[str]]]') -> str:
    lines = [
        '',
        _RULE,
        '  SPEC LEADS SDK — deliberately-sequenced lag, tolerated (not strict mode)',
        _RULE,
    ]
    for lane, behind in touched:
        lines.append(f'  lane: {lane.name}')
        lines.append(f'  why:  {lane.why}')
        plural = '' if len(behind) == 1 else 's'
        lines.append(f'  the SDK is behind on {len(behind)} {unit}{plural}:')
        lines.extend(f'      - {member}' for member in behind)
        lines.append('')
    lines.extend(
        [
            '  This gate re-arms itself: the moment the SDK gains ANY member of a lane',
            '  above, that whole lane must match the spec byte-exact. Set',
            '  EVOLVE_SPEC_GATE_STRICT=1 to forbid the lag outright — a STABLE',
            '  release does, so no stable package can ship while the SDK is behind.',
            _RULE,
            '',
        ]
    )
    return '\n'.join(lines)


def assess_spec_lag(
    *,
    sdk: 'list[str]',
    spec: 'list[str]',
    lanes: 'tuple[LagLane, ...]',
    unit: str,
    remedy: str,
    ordered: bool,
) -> LagVerdict:
    """Judge one axis of this SDK against the same axis of the contract.

    ``ordered`` says whether the shared members' order is part of what is
    pinned: True for the enums (compared byte-exactly, so a reordering is a
    real change), False for the operation map (a map has no order to keep).
    ``remedy`` is how THIS axis catches up, in its own words — printed for the
    one failure whose fix is axis-specific.
    """
    sdk_has = set(sdk)
    spec_has = set(spec)
    behind = tuple(member for member in spec if member not in sdk_has)

    def fail(failure: str) -> LagVerdict:
        return LagVerdict(ok=False, in_sync=False, failure=failure, notice=None, behind=behind)

    # Direction 1, always fatal: the SDK claiming something the contract does
    # not declare. No wave can be "ahead" this way — the contract is written
    # first, by definition.
    invented = [member for member in sdk if member not in spec_has]
    if invented:
        return fail(f'the SDK carries {unit}s the spec does not declare: {", ".join(invented)}')

    # Direction 2, always fatal: the overlap disagreeing. Compare the spec
    # narrowed to what the SDK actually has — that is the SDK's list as the
    # contract would order it, so a difference is a genuine reordering and not
    # an artifact of the members the SDK is simply behind on.
    if ordered:
        shared = [member for member in spec if member in sdk_has]
        if shared != list(sdk):
            return fail(
                f'the {unit}s both sides carry are in different orders: '
                f'SDK [{", ".join(sdk)}] vs the spec\'s order [{", ".join(shared)}]'
            )

    if not behind:
        return LagVerdict(ok=True, in_sync=True, failure=None, notice=None, behind=behind)

    # From here the spec leads. Everything below decides whether that is the
    # legal pre-publish state or drift wearing its clothes.

    if SPEC_GATE_STRICT:
        plural = '' if len(behind) == 1 else 's'
        return fail(
            f'EVOLVE_SPEC_GATE_STRICT=1 and the SDK is behind the contract on '
            f'{len(behind)} {unit}{plural}: {", ".join(behind)} '
            '(publish only after the SDK carries the whole contract)'
        )

    undeclared = [
        member for member in behind if not any(member in lane.members for lane in lanes)
    ]
    if undeclared:
        return fail(
            f'the SDK is behind on {unit}s no lane declares: {", ".join(undeclared)} '
            f'— {remedy}, or declare the wave as a lane in tests/unit/spec_lag.py '
            'with the reason it may lead'
        )

    # Self-arming: a lane the SDK has started adopting is no longer sequenced
    # work, it is an unfinished edit, and it is held to the same equality as
    # everything else.
    half_adopted = [
        lane
        for lane in lanes
        if any(member in sdk_has for member in lane.members)
        and any(member not in sdk_has for member in lane.members)
    ]
    if half_adopted:
        detail = '; '.join(
            f'{lane.name} (has {", ".join(m for m in lane.members if m in sdk_has)}; '
            f'still missing {", ".join(m for m in lane.members if m not in sdk_has)})'
            for lane in half_adopted
        )
        return fail(
            f'a lane is half-adopted, so its lag is no longer tolerated — finish it: {detail}'
        )

    touched = [
        (lane, [member for member in lane.members if member not in sdk_has]) for lane in lanes
    ]
    touched = [entry for entry in touched if entry[1]]

    return LagVerdict(
        ok=True,
        in_sync=False,
        failure=None,
        notice=_notice_for(unit, touched),
        behind=behind,
    )


def announce(verdict: LagVerdict) -> None:
    """Make a tolerated lag impossible to miss in a pytest run.

    pytest swallows the stdout of a passing test, so the notice would be
    invisible exactly when it matters — on the green runs this law exists to
    allow. A warning survives: pytest always prints its warnings summary. The
    print stays for ``-s`` runs and for the captured output of a later failure.
    """
    if verdict.notice is None:
        return
    print(verdict.notice)
    warnings.warn(verdict.notice, stacklevel=2)


# =============================================================================
# THE DECLARED LANES — the mirror of the TypeScript gate's, member for member.
#
# One entry per wave the contract has landed and the SDKs have not published
# yet. Each is deleted — not amended — by whoever publishes the SDK that serves
# it, and the gate makes that unmissable: the lane's own axis fails on the
# first adopted member until the lane is complete, and then the entry is simply
# unreferenced.
# =============================================================================

#: The operations axis — spec operationId against the hand-maintained
#: operationId -> client-method map. Empty today: the team-accounts wave
#: (the spec's ``x-wave: 4`` set) is stated in the map — the read pair as
#: SDK methods, the rest as declared-absent — so nothing lags on this axis.
OPERATION_LAG_LANES: 'tuple[LagLane, ...]' = ()

#: The error-code axis — the contract's ErrorCode enum against the
#: ``HostedErrorCode`` Literal this SDK publishes. Empty today: the SDK
#: carries the whole enum.
ERROR_CODE_LAG_LANES: 'tuple[LagLane, ...]' = ()
