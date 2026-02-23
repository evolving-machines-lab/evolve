"""Unit tests for bridge request/response lifecycle edge cases."""

import asyncio

import pytest

from evolve.bridge import BridgeConnectionError, BridgeManager


class _DummyStdin:
    def write(self, _data: bytes):
        return None

    async def drain(self):
        return None


class _DummyProcess:
    def __init__(self):
        self.stdin = _DummyStdin()


class TestBridgeTimeoutSafety:
    @pytest.mark.asyncio
    async def test_call_timeout_removes_pending_and_ignores_late_response(self):
        bridge = BridgeManager()
        bridge.process = _DummyProcess()

        with pytest.raises(BridgeConnectionError, match="timed out"):
            await bridge.call("run", timeout_s=0.01)

        assert bridge.pending_requests == {}

        # Late bridge response after timeout should be ignored safely.
        bridge._handle_response({"jsonrpc": "2.0", "id": 1, "result": {"ok": True}})
        assert bridge.pending_requests == {}

    def test_handle_response_ignores_cancelled_future(self):
        bridge = BridgeManager()
        loop = asyncio.new_event_loop()
        try:
            future = loop.create_future()
            future.cancel()
            bridge.pending_requests[99] = future

            # This used to raise InvalidStateError when set_result hit a cancelled future.
            bridge._handle_response({"jsonrpc": "2.0", "id": 99, "result": "late"})
            assert 99 not in bridge.pending_requests
        finally:
            loop.close()

    @pytest.mark.asyncio
    async def test_call_cancellation_cleans_pending_request(self):
        bridge = BridgeManager()
        bridge.process = _DummyProcess()

        task = asyncio.create_task(bridge.call("run", timeout_s=5.0))
        await asyncio.sleep(0)
        task.cancel()

        with pytest.raises(asyncio.CancelledError):
            await task

        assert bridge.pending_requests == {}
