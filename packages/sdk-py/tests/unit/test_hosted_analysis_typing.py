"""The trace-analysis wire shapes are TYPED models pinned to the contract —
the analyze lane's mirror of test_hosted_stats_typing.py.

The law of the shapes:

- ``AnalyzeConfigInput`` / ``AnalyzeConfig`` / ``Rubric`` / ``RubricCriterion``
  / ``AnalysisCheck`` / ``AnalysisFailure`` / ``TrialAnalysis`` /
  ``JobAnalysisStats`` are TypedDicts: the runtime object stays the plain
  wire dict, the class only teaches type checkers the keys.
- Each key set equals its spec schema's properties byte-exactly, in spec
  order, parsed from spec/openapi.yaml the same way the drift gate parses it
  — a new wire field fails here until the TypedDict states it.
- ``Job.analyze`` is annotated ``Optional[AnalyzeConfig]``, ``Trial.analysis``
  ``Optional[TrialAnalysis]``, and ``JobStats['analysis']``
  ``Optional[JobAnalysisStats]`` — the None reading is "never analyzed",
  stated, never a fabricated empty object.
"""

import re
import typing
from typing import List, Optional

from evolve import (
    AnalysisCheck,
    AnalysisFailure,
    AnalyzeConfig,
    AnalyzeConfigInput,
    Job,
    JobAnalysisStats,
    JobStats,
    Rubric,
    RubricCriterion,
    Trial,
    TrialAnalysis,
)
from evolve.hosted import _map_job, _map_trial
from tests.unit.conftest import resolve_spec_path

SPEC_PATH = resolve_spec_path()


def _spec_schema_properties(schema_name: str) -> 'list[str]':
    """The top-level property names of one components schema, in spec order —
    the same line-based parse test_hosted_stats_typing.py uses, against the
    spec's own committed formatting; non-vacuous so a renamed schema fails
    loudly."""
    lines = SPEC_PATH.read_text().split('\n')
    try:
        start = lines.index(f'    {schema_name}:')
    except ValueError:
        raise AssertionError(f'spec schema {schema_name} not found') from None
    names: List[str] = []
    in_properties = False
    for line in lines[start + 1:]:
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


def test_every_analysis_shape_equals_its_spec_schema() -> None:
    for typed_dict, schema_name in (
        (RubricCriterion, 'RubricCriterion'),
        (Rubric, 'Rubric'),
        (AnalyzeConfigInput, 'AnalyzeConfigInput'),
        (AnalyzeConfig, 'AnalyzeConfig'),
        (AnalysisCheck, 'AnalysisCheck'),
        (AnalysisFailure, 'AnalysisFailure'),
        (TrialAnalysis, 'TrialAnalysis'),
        (JobAnalysisStats, 'JobAnalysisStats'),
    ):
        assert list(typed_dict.__annotations__) == _spec_schema_properties(schema_name), (
            f'{schema_name} keys drifted from the spec schema'
        )


def test_input_is_optional_and_resolved_is_required() -> None:
    # The input's fields are all optional ({} = all defaults); the RESOLVED
    # policy and the stored shapes state every field, like the spec's own
    # required lists.
    assert AnalyzeConfigInput.__total__ is False
    assert not AnalyzeConfigInput.__required_keys__
    for typed_dict in (AnalyzeConfig, Rubric, RubricCriterion, AnalysisCheck,
                       AnalysisFailure, TrialAnalysis, JobAnalysisStats):
        assert typed_dict.__total__ is True, typed_dict.__name__


def test_annotations_point_at_the_typed_models() -> None:
    job_hints = typing.get_type_hints(Job)
    assert job_hints['analyze'] == Optional[AnalyzeConfig]
    trial_hints = typing.get_type_hints(Trial)
    assert trial_hints['analysis'] == Optional[TrialAnalysis]
    stats_hints = typing.get_type_hints(JobStats)
    assert stats_hints['analysis'] == Optional[JobAnalysisStats]


def test_runtime_is_still_the_plain_wire_dict() -> None:
    rubric = {
        'criteria': [
            {'name': 'reward_hacking', 'description': 'd', 'guidance': 'g'},
        ],
    }
    analysis = {
        'id': 'an-1',
        'status': 'completed',
        'model_name': 'claude-haiku-4-5-20251001',
        'rubric': rubric,
        'summary': 'Legitimate solve.',
        'checks': {'reward_hacking': {'outcome': 'pass', 'explanation': 'ok'}},
        'estimated_cost_usd': 0.0173,
        'failure': None,
        'created_at': '2026-08-28T00:00:00Z',
        'finished_at': '2026-08-28T00:01:00Z',
    }
    job = _map_job(
        {
            'id': 'job-1',
            'analyze': {'model_name': 'claude-haiku-4-5-20251001', 'rubric': rubric},
            'stats': {
                'analysis': {
                    'n_completed': 1,
                    'n_failed': 0,
                    'n_pending': 0,
                    'cost_usd': 0.0173,
                    'checks': {'reward_hacking': {'n_pass': 1, 'n_fail': 0, 'n_not_applicable': 0}},
                },
            },
        }
    )
    assert isinstance(job.analyze, dict)
    assert job.analyze['rubric'] == rubric
    assert job.stats['analysis']['checks']['reward_hacking']['n_pass'] == 1

    trial = _map_trial({'id': 'run-1', 'analysis': analysis})
    assert trial.analysis == analysis
    assert trial.analysis['checks']['reward_hacking']['outcome'] == 'pass'

    # Absence is stated as None — never a fabricated empty object.
    bare = _map_job({'id': 'job-2'})
    assert bare.analyze is None
    assert bare.stats.get('analysis') is None
    assert _map_trial({'id': 'run-2'}).analysis is None
