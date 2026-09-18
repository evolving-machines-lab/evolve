"""The organization a managed session starts under rides from Evolve(org=...)
to the bridge's initialize params, and an unnamed one is None (the server's
personal-org default), never an invented slug."""
import pytest

from evolve import Evolve


class FakeBridge:
    def __init__(self, calls):
        self.calls = calls

    async def start(self):
        return None

    async def call(self, method, params=None, timeout_s=None):
        self.calls.append((method, params))
        return {'ok': True}


async def _initialize_params(**kwargs):
    calls = []
    evolve = Evolve(**kwargs)
    evolve.bridge = FakeBridge(calls)
    await evolve._ensure_initialized()
    method, params = calls[0]
    assert method == 'initialize'
    return params


@pytest.mark.asyncio
async def test_org_reaches_the_bridge():
    params = await _initialize_params(org='acme')
    assert params['org'] == 'acme'


@pytest.mark.asyncio
async def test_no_org_is_none_not_a_slug():
    params = await _initialize_params()
    assert params.get('org') is None
