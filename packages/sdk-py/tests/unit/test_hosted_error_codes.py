"""The error-code vocabulary has not drifted from the server's.

The failure this exists to kill is silent by construction. A code the server can
send and this SDK has never heard of does not raise anywhere — the Literal stops
covering it, ``is_hosted_error_code`` answers False, and a caller's branch falls
through to the arm it wrote for genuinely unknown codes. It drifted exactly that
way once (``upstream_not_watchable`` shipped server-side and reached neither SDK).

The referee is ``packages/sdk-ts/hosted-error-codes.json``: a checked-in copy of
the server's HOSTED_API_ERROR_CODES that the dashboard's own test regenerates and
diffs. Server -> json (proven in the dashboard repo) -> TypeScript (proven in its
own test) -> here. No link is a copy nobody checks.

The file lives in the sibling TypeScript package rather than here because that is
the one copy both repos can reach: the dashboard depends on @evolvingmachines/sdk
and reads it out of node_modules.
"""

import json
from pathlib import Path
from typing import get_args

from evolve import HOSTED_ERROR_CODES, is_hosted_error_code
from evolve.hosted import HostedErrorCode

REFEREE_PATH = (
    Path(__file__).resolve().parents[3] / 'sdk-ts' / 'hosted-error-codes.json'
)


def _server_codes() -> 'list[str]':
    codes = json.loads(REFEREE_PATH.read_text())['codes']
    # A referee that failed to parse into a list would make every assertion
    # below vacuously true, which is the one way this file could rot into a
    # no-op.
    assert isinstance(codes, list) and len(codes) > 10
    return codes


def test_tuple_is_the_server_list_in_order():
    codes = _server_codes()
    missing = [c for c in codes if c not in HOSTED_ERROR_CODES]
    extra = [c for c in HOSTED_ERROR_CODES if c not in codes]
    assert not missing, f'HOSTED_ERROR_CODES is missing server codes: {missing}'
    assert not extra, f'HOSTED_ERROR_CODES carries codes the server does not: {extra}'
    # Order too, not just membership: the referee is regenerated from the server
    # array, so a matching order keeps the diff of a real change to one line.
    assert list(HOSTED_ERROR_CODES) == codes


def test_literal_matches_the_tuple():
    # The runtime tuple is DERIVED from the Literal (get_args), so today this
    # cannot fail. It stays as the tripwire for the regression that created it:
    # the two were once spelled out separately, and a hand-rewritten tuple
    # would drift from the type in a way only a type-checker would notice.
    assert list(get_args(HostedErrorCode)) == list(HOSTED_ERROR_CODES)
    assert len(HOSTED_ERROR_CODES) > 10


def test_runtime_guard_reads_the_same_vocabulary():
    assert all(is_hosted_error_code(code) for code in _server_codes())
    assert not is_hosted_error_code('insufficient_creidts')
