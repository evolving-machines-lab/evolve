"""The job-delete receipt is a TYPED model pinned to the contract — the
delete lane's mirror of test_hosted_upload_typing.py.

The law of the shape:

- ``JobDeleteResult`` is a dataclass whose fields equal the spec schema's
  properties byte-exactly, in spec order, parsed from spec/openapi.yaml the
  same way the drift gate parses it — a new wire field fails here until the
  dataclass states it.
- The mapper carries the receipt verbatim. All three fields are REQUIRED by
  the contract, and a zero count is the server's own claim about an empty
  job — carried as 0, never re-read as absence.
"""

import re
from typing import List

from evolve import JobDeleteResult
from evolve.hosted import _map_job_delete_result
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


def test_job_delete_result_equals_its_spec_schema() -> None:
    assert list(JobDeleteResult.__annotations__) == _spec_schema_properties(
        'JobDeleteResult'
    ), 'JobDeleteResult fields drifted from the spec schema'


def test_mapper_reads_the_receipt_verbatim() -> None:
    receipt = _map_job_delete_result(
        {'job_id': 'job-1', 'trials_deleted': 12, 'analyses_deleted': 3}
    )
    assert receipt == JobDeleteResult(
        job_id='job-1', trials_deleted=12, analyses_deleted=3
    )


def test_mapper_carries_zero_counts_verbatim() -> None:
    # 0 here is the server's claim ("the job had no trials"), not a default
    # this SDK invented — it rides through unchanged.
    receipt = _map_job_delete_result(
        {'job_id': 'job-1', 'trials_deleted': 0, 'analyses_deleted': 0}
    )
    assert receipt == JobDeleteResult(
        job_id='job-1', trials_deleted=0, analyses_deleted=0
    )
