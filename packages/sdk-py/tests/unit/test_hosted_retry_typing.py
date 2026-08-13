"""Job.retry is a TYPED model, not ``Dict[str, Any]`` — the Python mirror of
the TypeScript SDK's ``RetryConfig`` / ``RetryConfigInput`` interfaces, under
their non-colliding Python names ``JobRetryConfig`` / ``JobRetryConfigInput``.

The law of the shape:

- ``JobRetryConfig`` is a ``TypedDict`` with EVERY key required, exactly the
  spec's own required list: the mapper resolves an absent or partial echo
  with Harbor's defaults, so every field is always present at runtime and the
  runtime object stays the plain wire dict — ``job.retry['max_retries']``
  keeps working unchanged, it just type-checks now.
- ``JobRetryConfigInput`` is ``TypedDict(total=False)``: every key optional,
  like the TypeScript interface's ``?`` fields and the spec schema, which
  requires nothing.
- Both key sets equal the spec's own ``RetryConfig`` / ``RetryConfigInput``
  schema properties byte-exactly, parsed from spec/openapi.yaml the same way
  the contract drift gate parses it — a new wire field fails this test until
  the TypedDict states it.
- THE NAMING LAW: the spec calls this pair RetryConfig / RetryConfigInput,
  but ``evolve.RetryConfig`` already names the (unrelated) Swarm client-side
  retry helper — so the hosted pair is exported under the ``Job`` prefix,
  BOTH names stay exported, and neither ever shadows the other.
"""

import importlib
import re
import typing
from typing import List, Optional

import evolve
from evolve import Job, JobRetryConfig, JobRetryConfigInput, JobsClient, RetryConfig
from tests.unit.conftest import resolve_spec_path

# `evolve.hosted` the ATTRIBUTE is a callable on the package surface, so the
# module itself is fetched by name — the tests below inspect module contents.
hosted_module = importlib.import_module('evolve.hosted')

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


def _spec_schema_required(schema_name: str) -> 'list[str]':
    """The ``required:`` list of one components schema, in spec order."""
    lines = SPEC_PATH.read_text().split('\n')
    try:
        start = lines.index(f'    {schema_name}:')
    except ValueError:
        raise AssertionError(f'spec schema {schema_name} not found') from None
    names: List[str] = []
    in_required = False
    for line in lines[start + 1:]:
        if re.match(r'^ {4}\S', line):
            break
        if line == '      required:':
            in_required = True
            continue
        if in_required:
            m = re.match(r'^ {8}- ([A-Za-z_][A-Za-z0-9_]*)\s*$', line)
            if m:
                names.append(m.group(1))
                continue
            in_required = False
    assert names, f'vacuous parse: no required list found for {schema_name}'
    return names


def test_job_retry_annotation_is_the_typed_model() -> None:
    hints = typing.get_type_hints(Job)
    assert hints['retry'] is JobRetryConfig, (
        f"Job.retry must be annotated JobRetryConfig, got {hints['retry']!r}"
    )


def test_start_retry_param_is_the_typed_input() -> None:
    hints = typing.get_type_hints(JobsClient.start)
    assert hints['retry'] == Optional[JobRetryConfigInput]


def test_job_retry_config_keys_equal_spec_schema() -> None:
    assert list(JobRetryConfig.__annotations__) == _spec_schema_properties('RetryConfig')


def test_job_retry_config_input_keys_equal_spec_schema() -> None:
    assert list(JobRetryConfigInput.__annotations__) == _spec_schema_properties(
        'RetryConfigInput'
    )


def test_resolved_keys_are_required_like_the_spec() -> None:
    # The spec's RetryConfig requires every property; the resolved TypedDict
    # mirrors that — the mapper guarantees every field is present.
    assert JobRetryConfig.__total__ is True
    assert set(JobRetryConfig.__required_keys__) == set(
        _spec_schema_required('RetryConfig')
    )
    assert not JobRetryConfig.__optional_keys__


def test_input_keys_are_all_optional_like_the_spec() -> None:
    # The spec's RetryConfigInput requires nothing; TS marks every field `?`.
    assert JobRetryConfigInput.__total__ is False
    assert not JobRetryConfigInput.__required_keys__


def test_field_types_match_the_ts_interfaces() -> None:
    resolved = typing.get_type_hints(JobRetryConfig)
    assert resolved['max_retries'] is int
    # TS: `string[] | null` — None means "no include filter".
    assert resolved['include_exceptions'] == Optional[List[str]]
    # TS: `string[]` — resolved exclusions are never null.
    assert resolved['exclude_exceptions'] == List[str]
    for seconds in ('wait_multiplier', 'min_wait_sec', 'max_wait_sec'):
        assert resolved[seconds] is float, seconds

    inputs = typing.get_type_hints(JobRetryConfigInput)
    assert inputs['max_retries'] is int
    # On the INPUT side an explicit null is meaningful for BOTH lists.
    assert inputs['include_exceptions'] == Optional[List[str]]
    assert inputs['exclude_exceptions'] == Optional[List[str]]
    for seconds in ('wait_multiplier', 'min_wait_sec', 'max_wait_sec'):
        assert inputs[seconds] is float, seconds


def test_hosted_names_never_shadow_the_swarm_helper() -> None:
    # Both names exported, and they are DIFFERENT things: the Swarm helper is
    # a dataclass whose vocabulary is max_attempts/backoff_ms; the hosted
    # policy is the wire dict whose vocabulary is Harbor's max_retries.
    assert JobRetryConfig is not RetryConfig
    assert JobRetryConfigInput is not RetryConfig
    assert 'RetryConfig' in evolve.__all__
    assert 'JobRetryConfig' in evolve.__all__
    assert 'JobRetryConfigInput' in evolve.__all__
    assert 'max_attempts' in {f.name for f in RetryConfig.__dataclass_fields__.values()}
    assert 'max_retries' in JobRetryConfig.__annotations__
    # And the hosted module never grows a bare RetryConfig of its own — the
    # one spelling that WOULD silently shadow on a star-import surface.
    assert not hasattr(hosted_module, 'RetryConfig')


def test_runtime_object_is_still_the_plain_wire_dict() -> None:
    # The mapper's output is a dict readable by key — the TypedDict only
    # teaches type checkers; nothing about runtime reads changed.
    resolved = hosted_module._map_retry_config(None)
    assert isinstance(resolved, dict)
    assert resolved == {
        'max_retries': 0,
        'include_exceptions': None,
        'exclude_exceptions': [],
        'wait_multiplier': 1.0,
        'min_wait_sec': 1.0,
        'max_wait_sec': 60.0,
    }
