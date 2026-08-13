"""The Python half of the contract drift gate — the mirror of the TypeScript
SDK's hosted-spec-gate.test.ts, against the same spec/openapi.yaml.

Three axes, same law as the TypeScript gate:

1. OPERATIONS. Every operationId in the spec appears in the explicit map
   below, and every wave-1 operation resolves to a real client method. The
   map is maintained by hand ON PURPOSE — it doubles as the documentation of
   which spec operation each SDK method serves, and a new operation fails
   the gate until someone states its SDK answer. Wave-aware: an operation
   marked ``x-wave: 2`` may map to None (declared "not in the SDK yet"), a
   wave-1 operation may not.

2. ERROR CODES. ``HOSTED_ERROR_CODES`` equals the spec's ErrorCode enum
   byte-exactly — same members, same order — sourced from the spec itself.

3. ARTIFACT SELECTORS. The ``artifact()`` stream Literal equals the trace
   route's ``?stream=`` enum byte-exactly. The SDK ships wave-2 selectors
   ahead of the server (the route refuses them until its wave lands), so
   equality against the full enum is exactly the law.

4. STATUS + PROVIDER VOCABULARIES. The ``JobStatus`` / ``TrialStatus`` /
   ``EvalSandboxProvider`` Literals equal the contract's own enums — the
   closed sets clients branch and filter on.

5. SPEND VOCABULARY. The ``SpendSource`` Literal equals the contract's own
   enum — the money-reading path, where a lane the platform stamps and the
   type does not offer is a caller reading a provisional floor as unknown.

The spec is parsed line-by-line against its own committed formatting; every
parse asserts non-vacuity so an empty parse fails loudly instead of passing.
"""

import re
import typing

from evolve import (
    EFFORT_SUPPORT_VALUES,
    HOSTED_ERROR_CODES,
    AgentsClient,
    AuthClient,
    DatasetsClient,
    EvalSandboxProvider,
    JobStatus,
    JobsClient,
    SkillsClient,
    SpendSource,
    TrialStatus,
    TrialsClient,
    meta,
)
from evolve.hosted import EffortSupport
from tests.unit.conftest import resolve_spec_path

SPEC_PATH = resolve_spec_path()


def _spec_lines() -> 'list[str]':
    return SPEC_PATH.read_text().split('\n')


def _parse_operations() -> 'tuple[dict[str, int], set[str]]':
    """(hosted operationId -> wave, runtime-plane operationIds).

    Operation-level keys sit at exactly 6 spaces; parameter-level x-wave
    markers sit deeper and are not the operation's. Operations marked
    ``x-plane: sdk-runtime`` are the managed-agents runtime doors — a
    different SDK surface with its own map below, never the hosted clients'.
    """
    operations: 'dict[str, int]' = {}
    runtime: 'set[str]' = set()
    current = None
    for line in _spec_lines():
        op = re.match(r'^ {6}operationId: (\w+)\s*$', line)
        if op:
            current = op.group(1)
            operations[current] = 1
            continue
        wave = re.match(r'^ {6}x-wave: (\d+)\s*$', line)
        if wave and current:
            operations[current] = int(wave.group(1))
        if re.match(r'^ {6}x-plane: sdk-runtime\s*$', line) and current:
            runtime.add(current)
            operations.pop(current, None)
    assert len(operations) >= 25, 'the operation parse found too few — spec moved?'
    return operations, runtime


def _spec_operations() -> 'dict[str, int]':
    return _parse_operations()[0]


def _enum_entries(start: str, end: str, entry: str) -> 'list[str]':
    out = []
    inside = False
    for line in _spec_lines():
        if not inside:
            inside = re.match(start, line) is not None
            continue
        if re.match(end, line):
            break
        matched = re.match(entry, line)
        if matched:
            out.append(matched.group(1))
    return out


def _spec_error_codes() -> 'list[str]':
    codes = _enum_entries(
        r'^ {4}ErrorCode:\s*$',
        r'^ {4}[A-Z]\w*:\s*$',
        r'^ {8}- ([a-z_]+)\s*(?:#.*)?$',
    )
    assert len(codes) > 10, 'the ErrorCode parse found too few — spec moved?'
    return codes


def _spec_stream_selectors() -> 'list[str]':
    selectors = _enum_entries(
        r'^ {8}- name: stream\s*$',
        r'^ {8}- name: ',
        r'^ {14}- ([a-z-]+)\s*(?:#.*)?$',
    )
    assert len(selectors) >= 4, 'the stream-enum parse found too few — spec moved?'
    return selectors


# The operationId -> (client class, method) map. This IS the documentation of
# which SDK method serves which contract operation; None means "wave-gated and
# not in the SDK yet", legal only past wave 1. `meta` is the module-level
# function — the one call that takes no client.
OPERATION_TO_METHOD = {
    # Jobs
    'createJob': (JobsClient, 'start'),
    'listJobs': (JobsClient, 'list'),
    'compareJobs': (JobsClient, 'compare'),
    'getJob': (JobsClient, 'get'),
    'cancelJob': (JobsClient, 'cancel'),
    'watchJob': (JobsClient, 'watch'),
    'downloadJob': (JobsClient, 'download'),
    'resumeJob': (JobsClient, 'resume'),
    'retryJob': (JobsClient, 'retry'),
    'regradeJob': (JobsClient, 'regrade'),
    'grepJob': (JobsClient, 'grep'),
    'listJobTrials': (JobsClient, 'trials'),
    'listJobTasks': (JobsClient, 'tasks'),
    # Trials (globally addressable)
    'getTrial': (TrialsClient, 'get'),
    'getTrialTrace': (TrialsClient, 'trace'),  # ?stream= raw selectors ride artifact()
    'listTrialFiles': (TrialsClient, 'files'),
    'getTrialFile': (TrialsClient, 'file'),
    'retryTrial': (TrialsClient, 'retry'),
    'regradeTrial': (TrialsClient, 'regrade'),
    'stopTrials': (TrialsClient, 'stop'),
    # Datasets
    'listDatasets': (DatasetsClient, 'list'),
    'getDataset': (DatasetsClient, 'get'),
    'updateDataset': (DatasetsClient, 'update'),
    'deleteDataset': (DatasetsClient, 'delete'),
    'downloadDataset': (DatasetsClient, 'download'),
    'activateDatasetVersion': (DatasetsClient, 'activate'),
    'publishDataset': (DatasetsClient, 'publish'),
    'listDatasetImports': (DatasetsClient, 'list_imports'),
    'getDatasetImport': (DatasetsClient, 'get_import'),
    # Agents (bring-your-own)
    'registerAgent': (AgentsClient, 'create'),
    'listAgents': (AgentsClient, 'list'),
    'getAgent': (AgentsClient, 'get'),
    'upsertAgent': (AgentsClient, 'upsert'),
    'deleteAgent': (AgentsClient, 'delete'),
    # Skills (platform uploads referenced as upload:<id> in agents[].skills)
    'uploadSkill': (SkillsClient, 'upload'),
    'listSkills': (SkillsClient, 'list'),
    'getSkill': (SkillsClient, 'get'),
    'deleteSkill': (SkillsClient, 'delete'),
    # Meta + auth
    'getMeta': meta,
    'getAuthStatus': (AuthClient, 'status'),
    'listApiKeys': None,   # wave 2 — no SDK method yet
    'revokeApiKey': None,  # wave 2 — no SDK method yet
}


def _resolve(entry):
    if isinstance(entry, tuple):
        cls, method = entry
        return getattr(cls, method, None)
    return entry


# The runtime plane's own map: operationId -> the evolve module that speaks
# that door. Documentary like the hosted map — a new runtime operation fails
# the gate until someone states its SDK answer. The TypeScript gate holds the
# same list against the same spec.
RUNTIME_OPERATION_TO_MODULE = {
    'listSessions': 'evolve/sessions_client.py',
    'deleteSessions': 'evolve/sessions_client.py',
    'getSession': 'evolve/sessions_client.py',
    'deleteSession': 'evolve/sessions_client.py',
    'ingestSessionEvents': 'evolve/agent.py (observability push)',
    'getSessionSpend': 'evolve/sessions_client.py (cost surface)',
    'listCheckpoints': 'evolve/storage_client.py',
    'createCheckpoint': 'evolve/storage_client.py',
    'getCheckpoint': 'evolve/storage_client.py',
    'presignCheckpointTransfer': 'evolve/storage_client.py',
    'listManagedSecrets': 'evolve/managed_secrets.py',
    'createManagedRuntimeToken': 'evolve/managed_secrets.py',
    'extendManagedRuntimeToken': 'evolve/managed_secrets.py',
    'revokeManagedRuntimeToken': 'evolve/managed_secrets.py',
    'createProviderRuntimeToken': 'evolve/agent.py (provider secrets)',
    'extendProviderRuntimeToken': 'evolve/agent.py (provider secrets)',
    'revokeProviderRuntimeToken': 'evolve/agent.py (provider secrets)',
    'listBrowserCredentials': 'evolve/browser_credentials.py',
    'storeBrowserCredential': 'evolve/browser_credentials.py',
    'deleteBrowserCredentials': 'evolve/browser_credentials.py',
    'deleteBrowserCredential': 'evolve/browser_credentials.py',
    'getBrowserCredentialsPublicKey': 'evolve/browser_credentials.py',
    'createBrowserLoginMcpConfig': 'evolve/agent.py (browser login)',
    'listBrowserProfiles': 'evolve/browser_profiles.py',
    'deleteBrowserProfile': 'evolve/browser_profiles.py',
    'createBrowserSession': 'evolve/agent.py (browser sessions)',
    'deleteBrowserSession': 'evolve/agent.py (browser sessions)',
    'createIntegrationSession': 'evolve/integrations.py',
    'updateIntegrationAccounts': 'evolve/integrations.py',
    'connectIntegration': 'evolve/integrations.py',
    'disconnectIntegration': 'evolve/integrations.py',
    'getIntegrationsStatus': 'evolve/integrations.py',
    'proxyDaytonaGet': 'evolve/agent.py (managed door)',
    'proxyDaytonaPost': 'evolve/agent.py (managed door)',
    'proxyDaytonaDelete': 'evolve/agent.py (managed door)',
    'proxyDaytonaToolboxGet': 'evolve/agent.py (managed door)',
    'proxyDaytonaToolboxPost': 'evolve/agent.py (managed door)',
    'proxyDaytonaToolboxDelete': 'evolve/agent.py (managed door)',
    'proxyE2bGet': 'evolve/agent.py (managed door)',
    'proxyE2bPost': 'evolve/agent.py (managed door)',
    'proxyE2bDelete': 'evolve/agent.py (managed door)',
    'proxyModalGet': 'evolve/agent.py (managed modal)',
    'proxyModalPost': 'evolve/agent.py (managed modal)',
    'proxyModalDelete': 'evolve/agent.py (managed modal)',
}


def test_every_spec_operation_is_mapped():
    operations = _spec_operations()
    unmapped = [op for op in operations if op not in OPERATION_TO_METHOD]
    assert not unmapped, f'spec operations missing from the map (state their SDK answer): {unmapped}'
    phantom = [op for op in OPERATION_TO_METHOD if op not in operations]
    assert not phantom, f'map entries with no spec operation: {phantom}'


def test_every_runtime_plane_operation_is_mapped():
    _, runtime = _parse_operations()
    assert len(runtime) >= 25, 'the runtime-plane parse found too few — spec moved?'
    unmapped = [op for op in runtime if op not in RUNTIME_OPERATION_TO_MODULE]
    assert not unmapped, f'runtime operations missing from the map (state their SDK answer): {unmapped}'
    phantom = [op for op in RUNTIME_OPERATION_TO_MODULE if op not in runtime]
    assert not phantom, f'runtime map entries with no spec operation: {phantom}'


def test_wave_1_operations_all_reach_a_method():
    operations = _spec_operations()
    null_wave1 = [
        op for op, wave in operations.items()
        if wave == 1 and OPERATION_TO_METHOD[op] is None
    ]
    assert not null_wave1, f'wave-1 operations mapped to None: {null_wave1}'
    unreachable = [
        op for op, entry in OPERATION_TO_METHOD.items()
        if entry is not None and not callable(_resolve(entry))
    ]
    assert not unreachable, f'mapped methods that do not resolve: {unreachable}'


def test_error_codes_match_the_spec_enum_byte_exactly():
    assert list(HOSTED_ERROR_CODES) == _spec_error_codes()


def test_artifact_selectors_match_the_spec_stream_enum():
    hints = typing.get_type_hints(TrialsClient.artifact)
    assert list(typing.get_args(hints['stream'])) == _spec_stream_selectors()


def _spec_inline_enum(schema: str) -> 'list[str]':
    """A schema's inline ``enum: [a, b, c]`` line, scoped to that schema's block."""
    inside = False
    for line in _spec_lines():
        if not inside:
            inside = re.match(rf'^ {{4}}{schema}:\s*$', line) is not None
            continue
        if re.match(r'^ {4}[A-Z]\w*:\s*$', line):
            break
        matched = re.match(r'^ {6}enum: \[([^\]]+)\]\s*$', line)
        if matched:
            return [member.strip() for member in matched.group(1).split(',')]
    return []


def test_status_and_provider_literals_match_the_spec_enums():
    job_statuses = _spec_inline_enum('JobStatus')
    assert len(job_statuses) >= 6, 'the JobStatus parse found too few — spec moved?'
    assert list(typing.get_args(JobStatus)) == job_statuses

    trial_statuses = _enum_entries(
        r'^ {4}TrialStatus:\s*$',
        r'^ {4}[A-Z]\w*:\s*$',
        r'^ {8}- ([A-Z_]+)\s*(?:#.*)?$',
    )
    assert len(trial_statuses) >= 8, 'the TrialStatus parse found too few — spec moved?'
    assert list(typing.get_args(TrialStatus)) == trial_statuses

    providers = _spec_inline_enum('SandboxProvider')
    assert len(providers) >= 3, 'the SandboxProvider parse found too few — spec moved?'
    assert list(typing.get_args(EvalSandboxProvider)) == providers


def test_spend_source_literal_matches_the_spec_enum():
    """The money-reading vocabulary, held to the contract like any other."""
    lanes = _spec_inline_enum('SpendSource')
    assert len(lanes) >= 3, 'the SpendSource parse found too few — spec moved?'
    assert list(typing.get_args(SpendSource)) == lanes


def _spec_property_enum(schema: str, prop: str) -> 'list[str]':
    """A property's inline ``enum: [a, b, c]``, scoped to one schema's block."""
    in_schema = False
    in_property = False
    for line in _spec_lines():
        if not in_schema:
            in_schema = re.match(rf'^ {{4}}{schema}:\s*$', line) is not None
            continue
        if re.match(r'^ {4}[A-Z]\w*:\s*$', line):
            break
        if re.match(rf'^ {{8}}{prop}:\s*$', line):
            in_property = True
            continue
        if in_property:
            if re.match(r'^ {8}\w', line):
                break  # the next property ends the scope
            matched = re.match(r'^ {10}enum: \[([^\]]+)\]\s*$', line)
            if matched:
                return [member.strip() for member in matched.group(1).split(',')]
    return []


def test_effort_support_vocabulary_matches_the_spec_enum():
    """The axis the effort_support CRITICAL proved missing: the spec typed the
    field as a boolean while the server served a three-value string, and this
    SDK's ``is True`` coercion read every agent as no-effort-support. Both the
    runtime tuple and the Literal are held to the contract's enum."""
    members = _spec_property_enum('AgentCapability', 'effort_support')
    assert len(members) >= 3, 'the effort_support enum parse found too few — spec moved?'
    assert list(EFFORT_SUPPORT_VALUES) == members
    assert list(typing.get_args(EffortSupport)) == members
