"""The job-upload wire shape is a TYPED model pinned to the contract — the
upload lane's mirror of test_hosted_analysis_typing.py.

The law of the shape:

- ``UploadProvenance`` is a dataclass whose fields equal the spec schema's
  properties byte-exactly, in spec order, parsed from spec/openapi.yaml the
  same way the drift gate parses it — a new wire field fails here until the
  dataclass states it.
- ``Job.upload`` is annotated ``Optional[UploadProvenance]`` — the None
  reading is "not an uploaded job", stated, never a fabricated empty object.
- The mapper is defensive: absent, malformed, and half-stated echoes all read
  None; the archive's own nulls pass through as None, never invented values.
"""

import re
import typing
from typing import List, Optional

from evolve import Job, UploadProvenance
from evolve.hosted import _map_job
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
    }))
    assert job.upload == UploadProvenance(
        original_job_id='orig-123',
        original_job_name='nightly',
        uploaded_at='2026-08-28T10:00:00.000Z',
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
    )
