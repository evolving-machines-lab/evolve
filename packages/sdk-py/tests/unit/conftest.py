"""Shared setup for the unit tests that read the API contract.

The contract lives in the private server repo, so every spec-reading test
module needs the same two lines before it can parse anything: find the spec,
and skip the whole module cleanly when it is not there. That preamble lives
here once instead of being copied into each module.
"""

import os
from pathlib import Path

import pytest


def resolve_spec_path() -> Path:
    """The path to spec/openapi.yaml, or skip the calling module.

    The contract lives in the private server repo; EVOLVE_OPENAPI_SPEC_PATH
    points at a checkout of it. The repo-root path stays as the legacy
    fallback for checkouts that still carry a copy.

    Call this at module level: with no spec present it raises pytest's
    module-level skip, so the importing module skips as a whole — the same
    way a missing spec skips the gate in CI.
    """
    override = os.environ.get('EVOLVE_OPENAPI_SPEC_PATH')
    spec_path = (
        Path(override)
        if override
        else Path(__file__).resolve().parents[4] / 'spec' / 'openapi.yaml'
    )
    if not spec_path.exists():
        pytest.skip(
            'spec not present — gate runs in private CI or with EVOLVE_OPENAPI_SPEC_PATH',
            allow_module_level=True,
        )
    return spec_path
