"""A configuration refusal relayed by the bridge (EvolveConfigError, e.g. an org the caller
is not in) reaches Python as EvolveConfigError with its field, never as SandboxNotFoundError
by the 'not found' words in its message."""
import asyncio

from evolve.bridge import BridgeManager, EvolveConfigError, SandboxNotFoundError, _typed_bridge_error

RELAYED = {
    'code': -32603,
    'message': 'Organization "acm" was not found, or you are not a member of it (org_not_found)',
    'data': {'errorType': 'EvolveConfigError', 'field': 'org'},
}


def test_typed_bridge_error_rebuilds_the_config_error():
    typed = _typed_bridge_error(RELAYED['message'], RELAYED['data'])
    assert isinstance(typed, EvolveConfigError)
    assert typed.field == 'org'
    assert 'org_not_found' in str(typed)


def test_handle_response_raises_the_config_error_not_sandbox_not_found():
    bridge = BridgeManager()
    loop = asyncio.new_event_loop()
    try:
        future = loop.create_future()
        bridge.pending_requests[7] = future
        bridge._handle_response({'jsonrpc': '2.0', 'id': 7, 'error': RELAYED})
        error = future.exception()
        assert isinstance(error, EvolveConfigError)
        assert not isinstance(error, SandboxNotFoundError)
        assert error.field == 'org'
    finally:
        loop.close()
