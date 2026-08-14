"""Job.stats is a TYPED model, not ``Dict[str, Any]`` — the Python mirror of
the TypeScript SDK's ``JobStats`` / ``AgentDatasetStats`` interfaces.

The law of the shape:

- ``JobStats`` and ``AgentDatasetStats`` are ``TypedDict(total=False)``: every
  key optional, exactly like the TypeScript interfaces' ``?`` fields, and the
  runtime object stays the plain wire dict — ``stats.get('cost_usd')`` and
  ``stats['evals']`` keep working unchanged, they just type-check now.
- The key sets equal the spec's own ``JobStats`` / ``AgentDatasetStats``
  schema properties byte-exactly, parsed from spec/openapi.yaml the same way
  the contract drift gate parses it — a new wire field fails this test until
  the TypedDict states it.
- ``Job.stats`` is annotated ``JobStats`` (red on the old ``Dict[str, Any]``),
  and ``JobStats['evals']`` points at ``AgentDatasetStats`` so a reader
  drilling into a group gets typed fields, not ``Any``.
"""

import re
import typing
from typing import Any, Dict, List, Optional

from evolve import AgentDatasetStats, Job, JobStats, pass_at_k
from evolve.hosted import _map_job
from tests.unit.conftest import resolve_spec_path

SPEC_PATH = resolve_spec_path()


def _spec_schema_properties(schema_name: str) -> 'list[str]':
    """The top-level property names of one components schema, in spec order.

    Line-based against the spec's own committed formatting, like the drift
    gate: the schema starts at ``    {name}:`` (4 spaces), its ``properties:``
    block is at 6 spaces, and each property name sits at 8 spaces. The parse
    asserts non-vacuity so a renamed schema fails loudly.
    """
    lines = SPEC_PATH.read_text().split('\n')
    try:
        start = lines.index(f'    {schema_name}:')
    except ValueError:
        raise AssertionError(f'spec schema {schema_name} not found') from None
    names: List[str] = []
    in_properties = False
    for line in lines[start + 1:]:
        # Next schema at the same 4-space indent ends this one.
        if re.match(r'^ {4}\S', line):
            break
        if line == '      properties:':
            in_properties = True
            continue
        if in_properties and re.match(r'^ {6}\S', line):
            in_properties = False
            continue
        if in_properties:
            m = re.match(r'^ {8}([A-Za-z_][A-Za-z0-9_]*):', line)
            if m:
                names.append(m.group(1))
    assert names, f'vacuous parse: no properties found for {schema_name}'
    return names


def test_job_stats_annotation_is_the_typed_model() -> None:
    hints = typing.get_type_hints(Job)
    assert hints['stats'] is JobStats, (
        f"Job.stats must be annotated JobStats, got {hints['stats']!r}"
    )


def test_job_stats_keys_equal_spec_schema() -> None:
    assert list(JobStats.__annotations__) == _spec_schema_properties('JobStats')


def test_agent_dataset_stats_keys_equal_spec_schema() -> None:
    assert list(AgentDatasetStats.__annotations__) == _spec_schema_properties(
        'AgentDatasetStats'
    )


def test_every_key_is_optional_like_the_ts_interfaces() -> None:
    # TS marks every field `?`; the TypedDicts mirror that with total=False.
    assert JobStats.__total__ is False
    assert AgentDatasetStats.__total__ is False
    assert not JobStats.__required_keys__
    assert not AgentDatasetStats.__required_keys__


def test_evals_drills_into_agent_dataset_stats() -> None:
    hints = typing.get_type_hints(JobStats)
    assert hints['evals'] == Dict[str, AgentDatasetStats]


def test_field_types_match_the_ts_interfaces() -> None:
    stats_hints = typing.get_type_hints(JobStats)
    # Cumulative counters: plain ints.
    for counter in (
        'n_completed_trials',
        'n_errored_trials',
        'n_running_trials',
        'n_pending_trials',
        'n_cancelled_trials',
        'n_retries',
    ):
        assert stats_hints[counter] is int, counter
    # Nullable token totals and money: Optional, matching TS `number | null`.
    for nullable in (
        'n_input_tokens',
        'n_cache_tokens',
        'n_output_tokens',
    ):
        assert stats_hints[nullable] == Optional[int], nullable
    for money in ('cost_usd', 'gpu_cost_usd', 'judge_cost_usd'):
        assert stats_hints[money] == Optional[float], money

    group_hints = typing.get_type_hints(AgentDatasetStats)
    assert group_hints['n_trials'] is int
    assert group_hints['n_errors'] is int
    assert group_hints['metrics'] == List[Dict[str, Any]]
    assert group_hints['pass_at_k'] == Dict[str, float]
    assert group_hints['reward_stats'] == Dict[str, Dict[str, List[str]]]
    assert group_hints['exception_stats'] == Dict[str, List[str]]


def _wire_job(stats: 'dict[str, Any]') -> Job:
    return _map_job(
        {
            'id': 'job_1',
            'job_name': 'typed stats',
            'status': 'RUNNING',
            'datasets': [],
            'agents': [],
            'n_attempts': 1,
            'n_concurrent_trials': 1,
            'max_trial_spend_usd': 1.0,
            'worst_case_spend_usd': 1.0,
            'retry': {'max_retries': 0},
            'sandbox_provider': 'daytona',
            'counts': {'agents': 0, 'tasks': 0},
            'n_total_trials': 0,
            'trials': {'total': 0, 'byStatus': {}},
            'stats': stats,
            'started_at': '2026-01-01T00:00:00Z',
            'updated_at': '2026-01-01T00:00:00Z',
        }
    )


def test_runtime_is_still_the_plain_wire_dict() -> None:
    # The typed model is hints only: the mapped object IS the wire dict, so
    # every documented read (`.get`, `[...]`, `in`) behaves exactly as before.
    wire_stats = {
        'n_completed_trials': 2,
        'cost_usd': 0.5,
        'evals': {'agent__model__high__ds': {'n_trials': 2, 'pass_at_k': {'2': 1.0}}},
    }
    job = _wire_job(wire_stats)
    assert isinstance(job.stats, dict)
    assert job.stats == wire_stats
    assert job.stats.get('cost_usd') == 0.5
    assert job.stats['evals']['agent__model__high__ds']['n_trials'] == 2
    # And the pass@k reader is unchanged on top of it.
    groups = pass_at_k(job)
    assert [(g.evals_key, [(p.k, p.value) for p in g.points]) for g in groups] == [
        ('agent__model__high__ds', [(2, 1.0)])
    ]


def test_absent_stats_maps_to_the_empty_dict() -> None:
    job = _wire_job({})
    assert job.stats == {}
    assert pass_at_k(job) == []
