"""The task-quality-check wire shapes are TYPED models pinned to the contract —
the check lane's mirror of test_hosted_analysis_typing.py.

- ``CheckConfigInput`` / ``CheckSource`` / ``TaskCheck`` / ``Check`` are
  TypedDicts: the runtime object stays the plain wire dict, the class only
  teaches type checkers the keys.
- Each key set equals its spec schema's properties byte-exactly, in spec
  order, parsed from spec/openapi.yaml the same way the drift gate parses
  it — a new wire field fails here until the TypedDict states it.
- ``CheckPage`` carries the frozen page envelope; ``CheckConfigInput`` is
  all-optional ({} = the defaults) while the served shapes state every key.
"""

import dataclasses
import re
import typing
from typing import List

from evolve import Check, CheckConfigInput, CheckPage, CheckSource, CheckStatus, TaskCheck
from tests.unit.conftest import resolve_spec_path

SPEC_PATH = resolve_spec_path()


def _spec_schema_properties(schema_name: str) -> 'list[str]':
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


def test_every_check_shape_equals_its_spec_schema() -> None:
    for typed_dict, schema_name in (
        (CheckConfigInput, 'CheckConfigInput'),
        (CheckSource, 'CheckSource'),
        (TaskCheck, 'TaskCheck'),
        (Check, 'Check'),
    ):
        assert list(typed_dict.__annotations__) == _spec_schema_properties(schema_name), (
            f'{schema_name} keys drifted from the spec schema'
        )


def test_input_is_optional_and_served_shapes_are_required() -> None:
    assert CheckConfigInput.__total__ is False
    assert Check.__total__ is True
    assert TaskCheck.__total__ is True
    assert CheckSource.__total__ is True


def test_check_page_is_the_frozen_envelope() -> None:
    assert [f.name for f in dataclasses.fields(CheckPage)] == ['items', 'next_cursor', 'has_more']


def test_check_status_literal_is_the_derived_ladder() -> None:
    # A check never fails as a whole (each task carries its own failure), so
    # the ladder has three words, not the analysis lane's four.
    assert list(typing.get_args(CheckStatus)) == ['queued', 'running', 'completed']
