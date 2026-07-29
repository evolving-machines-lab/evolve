"""The Python SDK's harness/effort vocabulary has not drifted from the registry's.

OWNER RULING: managed evals and managed agents must advertise and support the
same models and efforts. The referee is ``packages/sdk-ts/harness-capabilities.json``,
generated from the TypeScript AGENT_REGISTRY (the single source of truth for
per-harness models, efforts, and defaults) and proven byte-fresh by the
TypeScript SDK's own test. This file proves the PYTHON half of that chain.

What Python actually exposes about models and efforts — and is therefore what
gets guarded here:

- ``AgentType`` (config.py): the Literal of harness names an ``AgentConfig``
  accepts. A harness in the registry that this Literal does not name is a
  harness Python users cannot drive; one it names that the registry dropped is
  a typo the type-checker would bless.
- ``ReasoningEffort`` (config.py): the Literal of effort spellings an
  ``AgentConfig`` accepts. Every effort the artifact advertises must be
  expressible here, or evals could run at an effort the local SDK refuses.
  (The Literal may carry MORE: the legacy spelling ``no-thinking`` is accepted
  for compatibility but deliberately advertised nowhere.)

Python has no model table of its own — models ride through to the TypeScript
bridge verbatim — so there is no model list on this side to hold to the
artifact; ``hosted.py`` only MAPS the server's capability document, and the
dashboard's parity test holds that document to this same artifact.
"""

import json
from pathlib import Path
from typing import get_args

from evolve.config import AgentType, ReasoningEffort

ARTIFACT_PATH = (
    Path(__file__).resolve().parents[3] / 'sdk-ts' / 'harness-capabilities.json'
)


def _artifact() -> dict:
    artifact = json.loads(ARTIFACT_PATH.read_text())
    # A referee that failed to parse into the expected shape would make every
    # assertion below vacuously true, which is the one way this file could rot
    # into a no-op.
    assert isinstance(artifact['harnesses'], dict) and len(artifact['harnesses']) >= 5
    assert isinstance(artifact['reasoningEfforts'], list) and artifact['reasoningEfforts']
    return artifact


def test_agent_type_literal_names_exactly_the_registry_harnesses():
    artifact_names = sorted(_artifact()['harnesses'].keys())
    literal_names = sorted(get_args(AgentType))
    assert literal_names == artifact_names, (
        f'AgentType Literal ({literal_names}) != registry harnesses ({artifact_names}) — '
        'update AgentType in evolve/config.py to match the TypeScript registry'
    )


def test_reasoning_effort_literal_covers_every_advertised_effort():
    artifact = _artifact()
    literal_values = set(get_args(ReasoningEffort))
    advertised = set(artifact['reasoningEfforts'])
    advertised.update(artifact['binaryEffortValues'])
    advertised.add(artifact['defaultReasoningEffort'])
    for harness in artifact['harnesses'].values():
        advertised.update(harness['efforts'])
        if harness['defaultEffort'] is not None:
            advertised.add(harness['defaultEffort'])
    missing = sorted(advertised - literal_values)
    assert not missing, (
        f'ReasoningEffort Literal is missing advertised efforts: {missing} — '
        'update ReasoningEffort in evolve/config.py to match the TypeScript registry'
    )


def test_default_effort_is_advertised_for_every_harness_that_takes_one():
    # The Python user story behind defaultEffort: an AgentConfig that names no
    # reasoning_effort must land on a value the harness advertises, never on a
    # value the create door would refuse.
    for name, harness in _artifact()['harnesses'].items():
        if harness['effortSupport'] == 'none':
            assert harness['efforts'] == [] and harness['defaultEffort'] is None, name
        else:
            assert harness['defaultEffort'] in harness['efforts'], name
