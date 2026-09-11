"""The gateway meter's usage line on a trace event — the Python mirror of the
TypeScript SDK's ``gatewayUsageOf``: only a ``usage`` event whose
``update.source`` is ``"gateway"`` carries tokens and money a client may show;
a harness's own usage line (no ``source``) answers None, like every other
event. The band constant mirrors the server's."""

from evolve import GATEWAY_TRACE_SEQ_BASE, TraceEvent, gateway_usage_of


def _gateway_event(seq: int = GATEWAY_TRACE_SEQ_BASE) -> TraceEvent:
    return TraceEvent(
        seq=seq,
        type='usage',
        data={
            'timestamp': '2026-09-10T08:22:23.682Z',
            'model': 'openai/glm-5.3-flash',
            'update': {
                'sessionUpdate': 'usage',
                'scope': 'call',
                'source': 'gateway',
                'callId': 'chatcmpl-1',
                'status': 'success',
                'startedAt': '2026-09-10T08:22:23.682Z',
                'endedAt': '2026-09-10T08:22:35.912Z',
                'receivedAt': '2026-09-10T08:22:40.000Z',
                'usage': {
                    'promptTokens': 21179,
                    'completionTokens': 1123,
                    'cachedTokens': 0,
                    'costUsd': 0.00385,
                    'extra': {'cache_write_tokens': 0},
                },
            },
        },
    )


def test_gateway_usage_of_reads_the_meters_line():
    usage = gateway_usage_of(_gateway_event())
    assert usage is not None
    assert usage['callId'] == 'chatcmpl-1'
    assert usage['usage']['costUsd'] == 0.00385
    assert usage['usage']['promptTokens'] == 21179


def test_band_constant_mirrors_the_server():
    assert GATEWAY_TRACE_SEQ_BASE == 1_000_000_000
    assert _gateway_event().seq >= GATEWAY_TRACE_SEQ_BASE


def test_harness_usage_and_other_events_answer_none():
    harness_run = TraceEvent(seq=9, type='usage', data={'update': {'sessionUpdate': 'usage', 'scope': 'run', 'usage': {'costUsd': 3.81}}})
    harness_call = TraceEvent(seq=3, type='usage', data={'update': {'sessionUpdate': 'usage', 'scope': 'call', 'usage': {'promptTokens': 0}}})
    tool = TraceEvent(seq=4, type='tool_call', data={'update': {'sessionUpdate': 'tool_call', 'title': 'Read'}})
    bare = TraceEvent(seq=0, type='unknown', data={})
    assert gateway_usage_of(harness_run) is None
    assert gateway_usage_of(harness_call) is None
    assert gateway_usage_of(tool) is None
    assert gateway_usage_of(bare) is None
    # A gateway line without a usage object is not a reading either.
    broken = TraceEvent(seq=1, type='usage', data={'update': {'sessionUpdate': 'usage', 'scope': 'call', 'source': 'gateway'}})
    assert gateway_usage_of(broken) is None
