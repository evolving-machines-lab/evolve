"""The job-upload wire shapes are TYPED models pinned to the contract — the
upload lane's mirror of test_hosted_analysis_typing.py.

The law of the shapes:

- ``UploadProvenance`` and ``TrialUploadProvenance`` are dataclasses whose
  fields equal their spec schemas' properties byte-exactly, in spec order,
  parsed from spec/openapi.yaml the same way the drift gate parses it — a new
  wire field fails here until the dataclass states it; the nested
  ``reported_agent_result`` object is pinned the same way.
- ``Job.upload`` is annotated ``Optional[UploadProvenance]`` and
  ``Trial.upload`` ``Optional[TrialUploadProvenance]`` — the None reading is
  "not an uploaded job/trial", stated, never a fabricated empty object.
- ``Job.sandbox_provider`` is nullable: None exactly on an uploaded job — an
  ingested record executed on no platform sandbox, and the closed provider
  vocabulary gains no fake member for it.
- The mappers are defensive: absent, malformed, and half-stated echoes all
  read None; the archive's own nulls pass through as None, never invented
  values, and the REPORTED figures never leak into the platform-metered
  fields beside them.
"""

import re
import typing
from typing import List, Optional

from evolve import (
    Job,
    ReportedAgentResult,
    ReportedTotals,
    Trial,
    TrialUploadProvenance,
    UploadProvenance,
)
from evolve.hosted import EvalSandboxProvider, _map_job, _map_trial
from tests.unit.conftest import resolve_spec_path

SPEC_PATH = resolve_spec_path()


def _spec_schema_properties(schema_name: str) -> 'list[str]':
    """The top-level property names of one components schema, in spec order —
    the same line-based parse the drift gate uses, against the spec's own
    committed formatting; non-vacuous so a renamed schema fails loudly."""
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


def _wire_job(**overrides) -> dict:
    return {'id': 'job-1', **overrides}


def test_upload_provenance_equals_its_spec_schema() -> None:
    assert list(UploadProvenance.__annotations__) == _spec_schema_properties(
        'UploadProvenance'
    ), 'UploadProvenance fields drifted from the spec schema'


def test_job_upload_is_optional_provenance() -> None:
    hints = typing.get_type_hints(Job)
    assert hints['upload'] == Optional[UploadProvenance]


def test_mapper_reads_a_full_echo_verbatim() -> None:
    job = _map_job(_wire_job(upload={
        'original_job_id': 'orig-123',
        'original_job_name': 'nightly',
        'uploaded_at': '2026-08-28T10:00:00.000Z',
        'reported_totals': {
            'cost_usd': 2.5,
            'n_input_tokens': 2400,
            'n_cache_tokens': 600,
            'n_output_tokens': 1600,
            'n_trials_reporting': 2,
        },
    }))
    assert job.upload == UploadProvenance(
        original_job_id='orig-123',
        original_job_name='nightly',
        uploaded_at='2026-08-28T10:00:00.000Z',
        reported_totals=ReportedTotals(
            cost_usd=2.5,
            n_input_tokens=2400,
            n_cache_tokens=600,
            n_output_tokens=1600,
            n_trials_reporting=2,
        ),
    )


def test_mapper_defends_the_reported_totals() -> None:
    base = {
        'original_job_id': 'orig-123',
        'original_job_name': 'nightly',
        'uploaded_at': '2026-08-28T10:00:00.000Z',
    }
    # Absent (a pre-field ingest) and malformed both read None whole.
    assert _map_job(_wire_job(upload=dict(base))).upload.reported_totals is None
    assert _map_job(
        _wire_job(upload={**base, 'reported_totals': 'lots'})
    ).upload.reported_totals is None
    # A totals object without its n_trials_reporting count is malformed — the
    # figures mean nothing without how many trials claimed them.
    assert _map_job(
        _wire_job(upload={**base, 'reported_totals': {'cost_usd': 2.5}})
    ).upload.reported_totals is None
    # Unstated figures are None (a zero would be a claim); the count carries.
    sparse = _map_job(_wire_job(upload={
        **base,
        'reported_totals': {'cost_usd': None, 'n_trials_reporting': 0},
    }))
    assert sparse.upload.reported_totals == ReportedTotals(
        cost_usd=None,
        n_input_tokens=None,
        n_cache_tokens=None,
        n_output_tokens=None,
        n_trials_reporting=0,
    )


def test_mapper_defends_every_dishonest_shape() -> None:
    # Absent (every job this platform executed, and an older server): None.
    assert _map_job(_wire_job()).upload is None
    # An explicit null is the same statement.
    assert _map_job(_wire_job(upload=None)).upload is None
    # Malformed — a string, a list — reads None, never a crash.
    assert _map_job(_wire_job(upload='yesterday')).upload is None
    assert _map_job(_wire_job(upload=['orig-123'])).upload is None
    # Missing uploaded_at — the one required timestamp — voids the whole echo
    # rather than fabricating a half-provenance.
    assert _map_job(_wire_job(upload={'original_job_id': 'x'})).upload is None
    assert _map_job(_wire_job(upload={'uploaded_at': 123})).upload is None


def test_mapper_carries_the_archives_own_nulls() -> None:
    # Null originals are the archive stating nothing — carried, never invented,
    # and a non-string original reads as the same honest None.
    job = _map_job(_wire_job(upload={
        'original_job_id': None,
        'original_job_name': 7,
        'uploaded_at': '2026-08-28T10:00:00.000Z',
    }))
    assert job.upload == UploadProvenance(
        original_job_id=None,
        original_job_name=None,
        uploaded_at='2026-08-28T10:00:00.000Z',
        reported_totals=None,
    )


def _spec_nested_object_properties(schema_name: str, property_name: str) -> 'list[str]':
    """A nested object property's own property names inside one components
    schema, in spec order — the nested pin the top-level parse cannot see;
    non-vacuous like every parse here."""
    lines = SPEC_PATH.read_text().split('\n')
    start = lines.index(f'    {schema_name}:')
    names: List[str] = []
    in_nested = False
    in_properties = False
    for line in lines[start + 1:]:
        if re.match(r'^ {4}\S', line):
            break
        if re.match(rf'^ {{8}}{property_name}:', line):
            in_nested = True
            continue
        if in_nested:
            if re.match(r'^ {8}\S', line):
                break  # the next top-level property ends the scope
            if line == '          properties:':
                in_properties = True
                continue
            if in_properties:
                m = re.match(r'^ {12}([A-Za-z_][A-Za-z0-9_]*):', line)
                if m:
                    names.append(m.group(1))
    assert names, f'vacuous parse: no {schema_name}.{property_name} properties found'
    return names


def test_reported_totals_equals_its_nested_spec_object() -> None:
    assert list(ReportedTotals.__annotations__) == _spec_nested_object_properties(
        'UploadProvenance', 'reported_totals'
    ), 'ReportedTotals fields drifted from the nested spec object'


def test_trial_upload_provenance_equals_its_spec_schema() -> None:
    assert list(TrialUploadProvenance.__annotations__) == _spec_schema_properties(
        'TrialUploadProvenance'
    ), 'TrialUploadProvenance fields drifted from the spec schema'
    assert list(ReportedAgentResult.__annotations__) == _spec_nested_object_properties(
        'TrialUploadProvenance', 'reported_agent_result'
    ), 'ReportedAgentResult fields drifted from the nested spec object'


def test_trial_upload_is_optional_provenance() -> None:
    hints = typing.get_type_hints(Trial)
    assert hints['upload'] == Optional[TrialUploadProvenance]


def test_job_sandbox_provider_is_nullable_exactly_for_uploads() -> None:
    # A native job maps its provider; an uploaded job's null maps to None —
    # the closed provider vocabulary gains no fake member, and absence (never
    # a legal wire state on a served job) reads the same honest None.
    assert typing.get_type_hints(Job)['sandbox_provider'] == Optional[EvalSandboxProvider]
    assert _map_job(_wire_job(sandbox_provider='e2b')).sandbox_provider == 'e2b'
    assert _map_job(_wire_job(sandbox_provider=None)).sandbox_provider is None
    assert _map_job(_wire_job()).sandbox_provider is None


def _wire_trial(**overrides) -> dict:
    return {'id': 'run-1', **overrides}


def test_trial_mapper_reads_a_full_echo_verbatim() -> None:
    run = _map_trial(_wire_trial(upload={
        'original_trial_id': 'orig-t1',
        'original_trial_name': 'trial-1',
        'original_task_name': 'laude/hello-world',
        'reported_agent_result': {
            'n_input_tokens': 1200,
            'n_cache_tokens': 300,
            'n_output_tokens': 800,
            'cost_usd': 1.25,
        },
    }))
    assert run.upload == TrialUploadProvenance(
        original_trial_id='orig-t1',
        original_trial_name='trial-1',
        original_task_name='laude/hello-world',
        reported_agent_result=ReportedAgentResult(
            n_input_tokens=1200,
            n_cache_tokens=300,
            n_output_tokens=800,
            cost_usd=1.25,
        ),
    )


def test_trial_mapper_defends_every_dishonest_shape() -> None:
    # Absent (every trial this platform executed) and malformed both read None.
    assert _map_trial(_wire_trial()).upload is None
    assert _map_trial(_wire_trial(upload=None)).upload is None
    assert _map_trial(_wire_trial(upload='yesterday')).upload is None
    # An echo missing either required name voids the whole provenance rather
    # than fabricating a half-identity.
    assert _map_trial(_wire_trial(upload={'original_trial_name': 'trial-1'})).upload is None
    assert _map_trial(_wire_trial(upload={'original_task_name': 't'})).upload is None
    # Reported figures: absent or malformed reads None whole; present maps
    # each figure, a non-number (bools included) reading the honest None.
    bare = _map_trial(_wire_trial(upload={
        'original_trial_id': None,
        'original_trial_name': 'trial-1',
        'original_task_name': 'hello-world',
        'reported_agent_result': None,
    }))
    assert bare.upload is not None
    assert bare.upload.reported_agent_result is None
    odd = _map_trial(_wire_trial(upload={
        'original_trial_id': None,
        'original_trial_name': 'trial-1',
        'original_task_name': 'hello-world',
        'reported_agent_result': {'n_input_tokens': True, 'cost_usd': '9.99'},
    }))
    assert odd.upload is not None
    assert odd.upload.reported_agent_result == ReportedAgentResult(
        n_input_tokens=None, n_cache_tokens=None, n_output_tokens=None, cost_usd=None,
    )
    # The claim never leaks into the platform-metered fields beside it.
    assert odd.agent_result is None
    assert odd.usage is None
    assert odd.spend_source is None
