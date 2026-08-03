"""Hosted evals clients: datasets(), agents(), jobs(), trials() and auth().

Direct-HTTP clients against the platform API (same pattern as
browser_credentials.py — no Node bridge). Mirrors the TypeScript SDK's hosted
module 1-1, and both SDKs speak the wire's own vocabulary: every field below is
spelled exactly as spec/openapi.yaml spells it (snake_case) — except the four
frozen camelCase spots the spec names (the page envelope's
``nextCursor``/``hasMore``, ``trials.byStatus``, the compare ``taskMatrix``,
and the error envelope's ``retryAfterSec``/``requestId``). That freeze is a
WIRE law: both SDKs send and receive those keys camelCase, and this SDK maps
them to snake_case attributes (``next_cursor``/``has_more``/``by_status``/
``task_matrix``, ``retry_after_sec``/``request_id``) so Python code reads one
casing throughout. ``watch()`` is dual-use — ``await`` it for
the final job, or ``async for`` its events (replay from the beginning,
Last-Event-ID resume on reconnect, terminal-event completion).

API failures raise :class:`EvolveAPIError` — the server's product sentence as
the message plus the stable machine-readable ``code``.
"""

import asyncio
import gzip
import hashlib
import json
import math
import os
import re
import secrets
import stat
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import (
    Any,
    AsyncIterator,
    Awaitable,
    Callable,
    Dict,
    Iterator,
    List,
    Literal,
    NoReturn,
    Optional,
    Union,
    get_args,
)

from . import _http
from .config import HostedClientConfig

DEFAULT_BASE_URL = 'https://dashboard.evolvingmachines.ai'

# Request budgets. A status poll and a 512 MB package are not the same wait, and
# sizing both by the smaller one made large downloads fail on the in-memory
# shape while succeeding on the to-disk shape. An upload is the download wait in
# the other direction — a corpus tarball rides the request body — so it shares
# the large budget. /api/meta gets a budget of its own: a small public document
# that should answer fast or be treated as down, not hold a caller for a minute.
# The SSE socket timeout is not a request budget at all — the server heartbeats
# every 15s, so 60s of silence only ever means a genuinely dead connection.
REQUEST_TIMEOUT_SEC = 60
DOWNLOAD_TIMEOUT_SEC = 600
UPLOAD_TIMEOUT_SEC = DOWNLOAD_TIMEOUT_SEC
META_TIMEOUT_SEC = 30
SSE_SOCKET_TIMEOUT_SEC = 60

#: The server states the verified digest of a download here. When it is present
#: the client re-checks it — a digest nobody verifies is decoration.
PACKAGE_DIGEST_HEADER = 'x-package-sha256'

_TERMINAL_JOB_STATUSES = {'COMPLETED', 'CANCELLED', 'FAILED'}

# Terminal import job statuses.
_TERMINAL_IMPORT_STATUSES = {'COMPLETED', 'FAILED'}

# Seeing one of these on the wire is the authoritative end-of-stream signal.
_TERMINAL_EVENT_TYPES = {'job.completed', 'job.cancelled', 'job.failed'}


#: One of the API's stable error codes. Use it in annotations to make a typo a
#: type error: ``def handle(code: HostedErrorCode) -> None: ...``
#:
#: This exists so a typo is catchable rather than silently never matching:
#: ``err.code == "insufficient_creidts"`` is a branch that looks handled and
#: never runs. Type-check against :data:`HostedErrorCode`, or guard at runtime
#: with :func:`is_hosted_error_code`.
#:
#: Mirrors the ErrorCode enum in spec/openapi.yaml and the TypeScript SDK's
#: HOSTED_ERROR_CODES, and is published verbatim at ``GET /api/meta`` as
#: ``error_codes``. A server newer than this SDK may send a code that is not
#: listed here, so ``EvolveAPIError.code`` stays a plain ``str``.
#:
#: Held to the spec by ``packages/sdk-ts/hosted-error-codes.json``, the
#: checked-in copy both SDKs assert against; the list drifted silently before
#: that file existed. Adding a code means editing the spec enum, that file,
#: the TypeScript list, and this Literal — the runtime tuple below is derived
#: from it, so the pair cannot disagree.
HostedErrorCode = Literal[
    'missing_authorization',
    'invalid_api_key',
    'credential_service_unavailable',
    'rate_limited',
    'insufficient_credits',
    'invalid_json',
    'invalid_input',
    'invalid_limit',
    'invalid_status',
    'invalid_cursor',
    'invalid_after',
    'invalid_format',
    'invalid_ids',
    'invalid_multipart',
    'idempotency_key_reused',
    'dataset_not_found',
    'dataset_version_not_found',
    'dataset_name_taken',
    'dataset_in_use',
    'dataset_not_owned',
    'upstream_not_watchable',
    'no_active_version',
    'version_not_ready',
    'version_not_activatable',
    'unknown_task_names',
    'no_tasks',
    'agent_not_found',
    'agent_name_taken',
    'agent_name_reserved',
    'agent_invalid_name',
    'agent_source_required',
    'agent_source_conflict',
    'agent_invalid_env',
    'agent_too_large',
    'agent_limit_reached',
    'agent_version_not_found',
    'job_too_large',
    'provider_unsupported',
    'job_not_found',
    'job_not_terminal',
    'no_failed_trials',
    'trial_not_found',
    'concurrent_update',
    'regrade_source_ineligible',
    'no_regradable_trials',
    'import_not_found',
    'import_too_large',
    'invalid_archive',
    'package_not_retained',
    'package_corrupt',
    'package_missing',
    'internal_error',
]

#: Every error code the hosted API can return, as a closed runtime list —
#: derived from the Literal above, in its order, so there is no second copy
#: to keep in step.
HOSTED_ERROR_CODES: 'tuple[str, ...]' = get_args(HostedErrorCode)


def is_hosted_error_code(value: Any) -> bool:
    """True when ``value`` is a code this SDK version knows about."""
    return isinstance(value, str) and value in HOSTED_ERROR_CODES


class EvolveDigestMismatchError(Exception):
    """Downloaded bytes did not match the digest the server stated for them.

    The server verifies a package against its recorded sha256 before sending,
    and echoes the verified value; this is the client half of that chain,
    covering the wire. It is NOT an API error — the request succeeded — so it is
    its own type rather than an EvolveAPIError with an invented code.
    """

    def __init__(self, expected: str, actual: str):
        super().__init__(
            f'downloaded bytes do not match the digest the server stated '
            f'(expected {expected}, got {actual})'
        )
        self.expected = expected
        self.actual = actual


class EvolveIncompleteDownloadError(Exception):
    """A download ended early: fewer bytes arrived than Content-Length promised.

    Its own type because a truncated body is not a wrong body — the distinction
    tells a caller whether to retry (yes) or to stop trusting the stored object
    (that is the digest error).
    """

    def __init__(self, expected_bytes: int, received_bytes: int):
        super().__init__(
            f'download ended early: the server declared {expected_bytes} bytes '
            f'and {received_bytes} arrived'
        )
        self.expected_bytes = expected_bytes
        self.received_bytes = received_bytes


class EvolveAPIError(Exception):
    """A typed failure from the hosted evals API.

    ``message`` (``str(error)``) is the server's own product sentence; ``code``
    is the stable machine-readable identifier (e.g. ``dataset_not_found``,
    ``version_not_ready``, ``provider_unsupported``, ``rate_limited``) so
    callers branch on codes, never on English. ``status`` is the HTTP status.

    ``param`` and ``details`` are the machine-readable half of the refusal::

        try:
            await jobs().start(...)
        except EvolveAPIError as err:
            if err.code == 'provider_unsupported':
                # every refused task WITH its reason — not a sentence to regex
                refused = (err.details or {}).get('refused_tasks', [])

    The server truncates the MESSAGE when a list is long and never truncates
    ``details``, so the data stays complete even when the sentence says
    "and 8 more".
    """

    def __init__(
        self,
        status: int,
        code: str,
        message: str,
        *,
        param: Optional[str] = None,
        details: Optional[Dict[str, Any]] = None,
        retry_after_sec: Optional[float] = None,
        request_id: Optional[str] = None,
    ):
        super().__init__(message)
        self.status = status
        self.code = code
        #: The input field this refusal is about — a body path
        #: ("agents[0].name"), a query parameter ("limit"), or a multipart
        #: part name ("run_command"). None when it is not about one field.
        self.param = param
        #: The complete machine-readable data behind the message. Never truncated.
        self.details = details
        #: Seconds to wait before retrying (429/503), from the body or the
        #: Retry-After header.
        self.retry_after_sec = retry_after_sec
        #: Server-side id for this failure — the string to quote in a support thread.
        self.request_id = request_id

    def is_known_code(self) -> bool:
        """True when this code is one this SDK version knows about."""
        return is_hosted_error_code(self.code)


class NoActiveVersionError(Exception):
    """Raised by ``datasets().get_active()`` when the dataset has no active version.

    The dataset exists but no version is active, so there is no runnable
    version to resolve. Use ``get()`` to inspect a dataset that may not have
    an active version yet.
    """

    def __init__(self, name: str):
        super().__init__(f'Dataset {name!r} has no active version')
        self.dataset = name


# =============================================================================
# PUBLIC TYPES
# =============================================================================

# The closed vocabularies, as Literal types like HostedErrorCode above — the
# same unions the TypeScript SDK publishes, so a type-checker catches a typo'd
# status the way the TS compiler does. Runtime stays permissive: the mappers
# assign whatever string the server sent, exactly as TS casts, so a server
# newer than this SDK still round-trips.
JobStatus = Literal[
    'QUEUED', 'RUNNING', 'CANCELLING', 'COMPLETED', 'CANCELLED', 'FAILED'
]
TrialStatus = Literal[
    'QUEUED', 'RUNNING', 'SCORING', 'SCORED',
    'SCORING_ERROR', 'INFRASTRUCTURE_ERROR', 'INDETERMINATE', 'CANCELLED',
]
EvalSandboxProvider = Literal['e2b', 'daytona', 'modal']
#: Which lane a settled trial's cost came from. Only ``'measured'`` is final.
#: ``'measured_provisional'`` is a real gateway reading taken inside its
#: asynchronous spend flush — an honest floor a deferred pass later confirms or
#: raises into ``'measured'``. ``'assumed_cap'`` means nobody measured this
#: trial: the figure it carries is zero, a placeholder and never the cap (the
#: platform under-bills rather than publish an invented number), replaced when
#: a real reading lands.
SpendSource = Literal['measured', 'measured_provisional', 'assumed_cap']
#: Where a trial's verifier executed: inside the agent's environment, or a
#: separate one.
VerifierEnvironmentMode = Literal['shared', 'separate']
#: Which step a RUNNING trial is in, so a polling caller can tell a slow build
#: from a slow agent — RUNNING alone cannot.
AttemptPhase = Literal[
    'prepare', 'build', 'boot', 'install', 'agent', 'verify', 'persist'
]


@dataclass
class DatasetVersionGate:
    """The activation gate's progress for one dataset version.

    ``status`` is the gate's own lifecycle (``PENDING`` → ``RUNNING`` →
    ``PASSED``/``FAILED`` as wire values). ``code`` and ``message`` are set on
    failure — one machine word and one human sentence — and are ``None`` while
    the gate is healthy. ``attempts`` counts gate runs so far.
    """
    status: str
    attempts: int
    code: Optional[str] = None
    message: Optional[str] = None


@dataclass
class DatasetVersion:
    """One immutable version of a dataset — one shape on every surface."""
    version: str
    state: str
    created_at: str
    task_count: int
    #: Activation-gate progress. ``None`` when no gate was scheduled for this
    #: version, and also ``None`` when the server predates the gate field — a
    #: missing gate never means "passed", only "nothing to report".
    gate: Optional[DatasetVersionGate] = None


@dataclass
class TaskProviderVerdict:
    """One provider's verdict for a task: runnable (ok), or refused with the limitation named."""
    ok: bool
    reason: Optional[str] = None


@dataclass
class Task:
    """Public task fields only — instructions/environments/tests never leave the server.

    ``providers`` maps each sandbox provider to a :class:`TaskProviderVerdict`.
    Advisory for choosing a job's provider — creating a job whose tasks include
    one refused on the chosen provider is rejected with the same reason, so
    nothing is ever spent on a trial that cannot execute.
    """
    task_name: str
    agent_timeout_sec: float
    verifier_timeout_sec: float
    providers: Dict[str, TaskProviderVerdict]


@dataclass
class TaskPage:
    """One page of a dataset version's tasks — paged like every collection,
    because a SWE-bench-scale dataset has thousands of them."""
    items: List[Task]
    next_cursor: Optional[str]
    has_more: bool


@dataclass
class UpstreamStatus:
    """Where a dataset's git source points now, versus what its active version
    was built from — the data behind a "new version available" badge.

    Nothing here imports anything by itself — a new version is always a row you
    create, or ``auto_import`` creates.
    """
    #: The ref the active version was imported from.
    ref: str
    #: The commit the active version was built from.
    current_commit: str
    #: Where the ref points upstream now; None when the last check failed.
    latest_commit: Optional[str]
    #: True when upstream has moved off the built-from commit. Branch on this.
    moved: bool
    #: Reserved; always None today.
    behind_by: Optional[int]
    #: When the cached answer was taken; None before the first check.
    checked_at: Optional[str]
    #: Why the last check failed. Show "could not check", not "up to date".
    error: Optional[str]
    #: Whether a moved upstream automatically imports a new version.
    auto_import: bool = False


@dataclass
class Dataset:
    """A dataset in the shared catalog.

    list() returns the summary fields; get() additionally populates versions,
    selected_version, tasks, created_at, and updated_at.
    """
    name: str
    title: Optional[str]
    description: Optional[str]
    active_version: Optional[DatasetVersion]
    #: Where this dataset's git source points now versus what its active
    #: version was built from. None when there is nothing to watch (an uploaded
    #: corpus, a seeded one, or one imported before provenance was recorded);
    #: None is never "up to date".
    upstream: Optional[UpstreamStatus] = None
    versions: Optional[List[DatasetVersion]] = None
    # The version whose tasks are listed (get() only)
    selected_version: Optional[DatasetVersion] = None
    # One page of the selected version's tasks (get() only); pass limit=/cursor=
    # to get() and follow next_cursor.
    tasks: Optional[TaskPage] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


@dataclass
class ActiveDataset:
    """A dataset's active version resolved to a runnable shape.

    Unlike :class:`Dataset`, ``version`` and ``tasks`` are non-optional:
    ``get_active()`` raises :class:`NoActiveVersionError` when there is no
    active version, so callers never branch on a missing active version.
    """
    name: str
    title: Optional[str]
    description: Optional[str]
    active_version: DatasetVersion
    version: str
    tasks: TaskPage
    versions: List[DatasetVersion]
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


@dataclass
class StatusVocabulary:
    """A closed vocabulary a client renders, with the members that end it."""
    values: List[str]
    #: Members after which nothing more happens — a watcher may stop here.
    terminal: List[str]


@dataclass
class AgentCapability:
    """One built-in agent's declared capabilities."""
    name: str
    #: Whether job ``agents[].reasoning_effort`` reaches this agent.
    effort_support: bool
    #: Whether job ``agents[].version`` may pin this agent.
    version_pinnable: bool
    #: Newest published version, for a "your pin is out of date" badge. None
    #: means "not known right now", never "up to date".
    latest_version: Optional[str] = None


@dataclass
class ProviderCapability:
    """One sandbox provider, its ceilings, and what it refuses."""
    name: str
    default: bool
    sizing: Dict[str, Any]
    refuses: List[Dict[str, str]]


@dataclass
class ManagedProviderCapability:
    """One managed sandbox door and whether this deployment serves it.

    A different question from :class:`ProviderCapability`, which is about the
    eval lane — a managed sandbox is one the caller drives directly holding
    nothing but an Evolve key.
    """
    name: str
    #: The operator config this door reads is present. NOT a health check: it
    #: says nothing about whether the pass-through behind the door is deployed
    #: or the credential behind it is valid.
    configured: bool
    #: Config this door reads, so an operator sees what to set.
    requires_config: List[str]
    #: The subset of ``requires_config`` missing right now — empty when configured.
    missing_config: List[str]
    #: A full SDK agent session can run on this door.
    agent_sessions: bool
    #: Why not, when ``agent_sessions`` is false. None otherwise.
    agent_sessions_reason: Optional[str] = None


@dataclass
class CapabilityDocument:
    """Everything a client would otherwise hardcode, in one public document.

    Fetch it with :func:`evolve.meta` (no API key required) and stop guessing
    at agent names, status enums, limits, and error codes.

    ``agent_registration`` and ``limits`` are handed through as plain dicts
    with the wire's own keys. They are nested configuration a client reads by
    key, not objects it constructs, and a dataclass per level would be five
    classes that must be edited every time the server adds a field — the exact
    coupling this document exists to remove.
    """
    schema_version: int
    #: Built-in agents and their declared capabilities.
    agents: List[AgentCapability]
    #: Rules a bring-your-own agent registration must satisfy.
    agent_registration: Dict[str, Any]
    sandbox_providers: List[ProviderCapability]
    #: The managed doors this deployment serves, and what each can carry.
    managed_providers: List[ManagedProviderCapability]
    #: Constraints that hold on EVERY provider.
    platform_constraints: List[Dict[str, str]]
    network_modes: List[str]
    statuses: Dict[str, StatusVocabulary]
    limits: Dict[str, Any]
    #: The ImportWarning codes the platform can attach to an import.
    import_warning_codes: List[str]
    error_codes: List[str]


@dataclass
class DatasetRef:
    """A resolved dataset reference as echoed on job bodies."""
    name: str
    version: str


@dataclass
class DatasetSelector:
    """One dataset a job runs, with per-dataset task filters.

    ``task_names`` and ``exclude_task_names`` are glob patterns; ``n_tasks``
    caps the task count AFTER filtering. A bare ``name`` resolves to the
    active version (``no_active_version`` when none).
    """
    name: str
    version: Optional[str] = None
    task_names: Optional[List[str]] = None
    exclude_task_names: Optional[List[str]] = None
    n_tasks: Optional[int] = None

    def _to_wire(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {'name': self.name}
        if self.version is not None:
            result['version'] = self.version
        if self.task_names is not None:
            result['task_names'] = self.task_names
        if self.exclude_task_names is not None:
            result['exclude_task_names'] = self.exclude_task_names
        if self.n_tasks is not None:
            result['n_tasks'] = self.n_tasks
        return result


@dataclass
class AgentArm:
    """One agent arm of a job: an agent (built-in or registered) plus a model.

    ``name`` is a built-in ("claude", "codex", ...) or a registered agent name.
    ``model_name`` is always required; the server applies no default.
    ``version`` pins an agent version; omitted (or None) resolves the latest at
    dispatch time — the version that actually RAN is recorded on every trial as
    ``agent_info.version``. A pin that cannot resolve is refused
    (``agent_version_not_found``); a non-exact pin is ``invalid_input``.

    ``reasoning_effort`` is how hard the model is asked to think. The accepted
    values are published at ``meta().limits['job']['reasoning_efforts']`` and
    an omitted one takes ``default_reasoning_effort`` beside them — read both
    from the capability document rather than hardcoding either. It is PART OF
    THE ARM'S IDENTITY, like the agent, the model and the version pin: the same
    agent and model at 'low' and at 'high' are two systems, they de-duplicate
    separately, and every trial echoes the effort back on
    ``trial.agent_info``. An effort an agent cannot apply is refused at
    creation rather than recorded and never sent — see
    :attr:`AgentCapability.effort_support`.
    """
    name: str
    model_name: str
    version: Optional[str] = None
    reasoning_effort: Optional[str] = None

    def _to_wire(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {'name': self.name, 'model_name': self.model_name}
        if self.version is not None:
            result['version'] = self.version
        if self.reasoning_effort is not None:
            result['reasoning_effort'] = self.reasoning_effort
        return result


@dataclass
class SourceJob:
    """Provenance of a derived job.

    ``action='regrade'`` = verifier-only re-run of the source;
    ``action='resume'`` = new job over the source's failed and stopped
    trials. ``type`` is always ``'hub'`` on this hosted surface.
    """
    action: str
    type: str
    job_id: str


@dataclass
class JobCounts:
    """Entity cardinality only — the parts of a job with no status of their own."""
    agents: int
    tasks: int


@dataclass
class TrialTally:
    """How many trials there are, and how they break down by status.

    ``by_status`` names EVERY trial status, zeros included, so a status bar can
    be drawn straight off the response without hardcoding the enum. (On the
    wire the key is the frozen ``byStatus``.)
    """
    total: int
    by_status: Dict[str, int] = field(default_factory=dict)


@dataclass
class JobFailure:
    """Why a job FAILED — the same {code, message} grammar as an API failure.

    Deliberately NOT called ``error``: on this surface ``error`` means "this
    request failed", so ``if body.error: raise`` has to stay correct on a
    healthy read of a failed job.
    """
    code: str
    message: str


@dataclass
class Job:
    """THE job body — the same shape from start, get, list rows, cancel,
    resume, and regrade responses; no field appears on some responses and not
    others. A regrade IS a job: ``source_jobs`` records the provenance and
    ``is_regrade`` derives from it.
    """
    id: str
    #: User-facing label.
    job_name: str
    status: JobStatus
    #: The resolved dataset references this job ran.
    datasets: List[DatasetRef]
    agents: List[AgentArm]
    n_attempts: int
    n_concurrent_trials: int
    #: The resolved per-trial cap every trial key was minted with.
    max_trial_spend_usd: float
    #: The most this job can cost: every trial spending its whole cap. There is
    #: no job-wide budget, so this product is the real ceiling.
    worst_case_spend_usd: float
    sandbox_provider: EvalSandboxProvider
    counts: JobCounts
    n_total_trials: int
    #: The zeros-included 8-status histogram, beside the coarser counters in
    #: ``stats``.
    trials: TrialTally
    #: Aggregate statistics (progress counters, token totals, ``cost_usd`` —
    #: measured spend, never a gate; ``evals`` keyed ``agent__model__dataset``).
    #: A plain dict with the wire's own keys, read by key, never constructed.
    stats: Dict[str, Any]
    #: Why the job FAILED, or None.
    failure: Optional[JobFailure]
    #: Provenance of a derived job; empty for an original one.
    source_jobs: List[SourceJob]
    #: Derived: any source_jobs entry with action "regrade".
    is_regrade: bool
    #: True when the server replayed an existing job for this Idempotency-Key.
    idempotent_replay: bool
    started_at: str
    updated_at: str
    #: None while the job is live.
    finished_at: Optional[str]


@dataclass
class TimingInfo:
    """A phase's wall-clock as a start/stop pair (never a duration).

    Either bound is None while the phase has not reached it."""
    started_at: Optional[str]
    finished_at: Optional[str]


@dataclass
class ModelInfo:
    name: str
    #: None means "not specified", never "unknown provider".
    provider: Optional[str] = None


@dataclass
class AgentInfo:
    """The agent that ran a trial.

    ``version`` is the version actually RESOLVED and used (None until
    resolved) — the requested pin lives on the job's ``agents[].version``.
    """
    name: str
    version: Optional[str]
    model_info: ModelInfo
    reasoning_effort: Optional[str] = None


@dataclass
class AgentResult:
    """What the agent phase produced and consumed.

    ``n_input_tokens`` includes cache tokens. ``cost_usd`` is the settled spend
    (see ``spend_source`` on the trial for which lane it came from);
    None until the trial has executed, and None never means $0. ``metadata``
    carries open per-run detail (bundle digest, network mode, harness-reported
    usage).
    """
    n_input_tokens: Optional[int] = None
    n_cache_tokens: Optional[int] = None
    n_output_tokens: Optional[int] = None
    cost_usd: Optional[float] = None
    rollout_details: Optional[List[Dict[str, Any]]] = None
    metadata: Optional[Dict[str, Any]] = None


@dataclass
class VerifierResult:
    """The verifier's rewards map.

    The primary-reward convention: the value under the key ``"reward"``; else,
    when exactly one key exists, that value; else no primary reward. Zero is a
    reward.
    """
    rewards: Optional[Dict[str, float]] = None


@dataclass
class ExceptionInfo:
    """Why a trial failed, when it did.

    ``exception_type`` is one of the platform's stable failure names
    (``ScoringError``, ``InfrastructureError``, ``CancelledError``,
    ``IncompleteTrialError``) — but filter with ``Trial.status``, which is the
    primary key for failure classes; this is the detail.
    """
    exception_type: str
    #: Truncated to 2000 chars on list rows; full on the detail route.
    exception_message: str
    exception_traceback: str = ''
    occurred_at: str = ''


@dataclass
class Trial:
    """The ONE public trial shape, shared verbatim by list rows and the detail
    route (detail returns ``exception_info.exception_message`` untruncated —
    the only documented difference). A trial id is globally addressable;
    ``job_id`` is the reverse pointer.

    Execution facts (``sandbox_provider``, ``verifier_environment_mode``,
    ``agent_result.cost_usd``, ``spend_source``) are None until the trial has
    actually executed: a QUEUED or CANCELLED trial never ran, so None means
    "did not run" and never zero.
    """
    id: str
    job_id: str
    task_name: str
    #: The dataset this trial's task came from.
    source: str
    agent_info: AgentInfo
    #: Attempt index within the arm (1..n_attempts).
    attempt: int
    status: TrialStatus
    #: Convenience primary reward derived from ``verifier_result.rewards``.
    #: Zero is a reward; None means the trial did not score.
    reward: Optional[float]
    verifier_result: Optional[VerifierResult]
    exception_info: Optional[ExceptionInfo]
    agent_result: Optional[AgentResult]
    environment_setup: Optional[TimingInfo]
    agent_setup: Optional[TimingInfo]
    agent_execution: Optional[TimingInfo]
    verifier: Optional[TimingInfo]
    #: Multi-step placeholder; None today.
    step_results: Optional[List[Dict[str, Any]]]
    #: Which lane ``agent_result.cost_usd`` came from — see SpendSource; only
    #: ``'measured'`` is final.
    spend_source: Optional[SpendSource]
    # A mid-run LOWER BOUND on spend, never the trial's cost. Only ever climbs
    # while the trial runs, and is CLEARED when the trial settles, on the same
    # statement as the terminal status — on a terminal trial read
    # agent_result.cost_usd and spend_source; those are the settled truth, and
    # the only one. None is "no reading yet", never $0.
    live_spent_usd: Optional[float]
    # When that reading was taken — show its age, never the figure alone
    live_spend_at: Optional[str]
    #: The cap THIS trial's gateway key carried — history, which can differ
    #: from the job's current cap for rows settled before a change.
    max_trial_spend_usd: Optional[float]
    # Sandbox provider the trial executed on; None until it has executed
    sandbox_provider: Optional[EvalSandboxProvider]
    # WHERE THIS TRIAL RAN: the provider id of the box the agent executed in.
    # None is honest and common — a QUEUED or CANCELLED trial never booted one.
    sandbox_id: Optional[str]
    # The separate box the verifier ran in. None when the verifier ran inside
    # the agent's box (shared mode) or when the trial never got that far.
    verifier_sandbox_id: Optional[str]
    #: Where the verifier ran; None until recorded.
    verifier_environment_mode: Optional[VerifierEnvironmentMode]
    #: Which step a RUNNING trial is in, so a polling caller can tell a slow
    #: build from a slow agent. None when not mid-phase.
    attempt_phase: Optional[AttemptPhase]
    session_ref: Optional[str]
    started_at: Optional[str]
    finished_at: Optional[str]


@dataclass
class StopResponse:
    """Per-trial outcome of ``trials().stop()``; every requested id appears in
    exactly one list."""
    #: Trials killed and settled by this request, with their settled rows.
    stopped: List[Trial]
    #: Ids that were already terminal; untouched.
    already_terminal: List[str]
    #: Ids that do not exist or are not the caller's.
    not_found: List[str]


@dataclass
class JobTaskRollup:
    """One task's rollup within a job: its trial tally, mean reward over
    SCORED trials, and measured cost. Sits between the job body and the trial
    list so a caller need not fetch every trial to see which tasks are
    dragging.
    """
    task_name: str
    #: The dataset the task came from.
    source: str
    trials: TrialTally
    #: Mean over SCORED trials only; None when none. Zero is a reward.
    mean_reward: Optional[float]
    #: Measured spend across the task's settled trials.
    cost_usd: Optional[float]


@dataclass
class JobEvent:
    """One server-sent event from jobs().watch().

    ``data`` stays a plain dict DELIBERATELY: the payload shapes are fixed by
    the contract (spec/openapi.yaml, JobEvent — keys like ``job_id``,
    ``trial_id``, ``task_name``, ``live_spent_usd``, ``attempt_phase``), and a
    dict passes them through verbatim where a per-type dataclass would have to
    chase every payload change. TypeScript narrows the same union statically;
    in Python, branch on ``type`` and read ``data`` by key.
    """
    # Monotonic sequence number (SSE id; the Last-Event-ID resume position)
    seq: int
    # Event type, e.g. "job.created", "trial.settled", "job.completed"
    type: str
    data: Dict[str, Any]


@dataclass
class TraceEvent:
    """One parsed trace event of a trial (seq-ordered timeline)."""
    seq: int
    type: str
    data: Dict[str, Any]


@dataclass
class TraceEventPage:
    """One page of a trial's trace — trials().trace().

    Same envelope as every other collection, and ``next_cursor`` means the same
    thing: pass it back as ``cursor=`` for the next page, and NONE MEANS CAUGHT
    UP. To resume a poll later, keep the last event's ``seq`` and pass it as
    ``cursor`` — a trace cursor IS a position in the seq timeline.
    """
    items: List[TraceEvent]
    next_cursor: Optional[str]
    has_more: bool


@dataclass
class CompareCoverage:
    """Scored-trial coverage behind an aggregate (means cover SCORED trials only)."""
    scored: int
    total: int


@dataclass
class CompareCell:
    """One (task, job) cell of the compare matrix.

    status is the shared trial status when the cell's trials agree, "MIXED"
    when they differ, and "MISSING" when the job has no trials for the task.
    """
    job_id: str
    status: str
    # Mean reward over the cell's SCORED trials; None when none. Zero is a reward.
    mean_reward: Optional[float]
    coverage: CompareCoverage


@dataclass
class CompareTaskRow:
    """One matrix row of jobs().compare(): a task across the compared jobs."""
    task_name: str
    # True when the jobs' cells differ in status or reward for this task
    disagreement: bool
    # Cells in the caller's job-id order
    cells: List[CompareCell]


@dataclass
class CompareJobAggregate:
    """Per-job aggregate of jobs().compare()."""
    id: str
    datasets: List[DatasetRef]
    status: str
    # Mean reward over SCORED trials only; None when none. Zero is a reward.
    mean_reward: Optional[float]
    coverage: CompareCoverage
    cost_usd: float
    agents: List[AgentArm]
    started_at: str


@dataclass
class CompareResponse:
    """Result of jobs().compare([ids]): aggregates + per-task matrix.

    (On the wire the matrix key is the frozen ``taskMatrix``.)"""
    # Aggregates in the caller's id order
    jobs: List[CompareJobAggregate]
    # Per-task matrix, disagreement rows first
    task_matrix: List[CompareTaskRow]


@dataclass
class ImportTaskFailure:
    """One task that failed to parse or validate during an import."""
    task_name: str
    error: str


@dataclass
class DatasetImportFailure:
    """Structured detail for a FAILED import."""
    # Stable machine-readable cause; "import_failed" when none was recorded.
    code: str
    # What went wrong, e.g. "2/113 task(s) failed to parse"
    message: str
    # Per-task parse/validation failures, when the corpus was reachable
    failures: List[ImportTaskFailure] = field(default_factory=list)


@dataclass
class ImportWarning:
    """Non-fatal but consequential import outcome.

    A version whose warnings include ``no_solutions_archived`` cannot be
    activated through this API (``version_not_activatable``) — an import that
    will never become runnable must not look identical to one that will.
    """
    code: str
    message: Optional[str] = None


@dataclass
class DatasetImport:
    """An asynchronous publish (a dataset import job).

    Statuses are the SAME four words a job uses — QUEUED, RUNNING, COMPLETED,
    FAILED. Terminal: "COMPLETED" (the corpus landed as a dataset version;
    runnable once activated) and "FAILED".

    Self-describing: every response names the dataset@version being imported,
    and every route that returns one — the 202 from ``publish()``,
    ``get_import()``, and ``list_imports()`` — returns this same shape.
    """
    id: str
    # Job status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED"
    status: str
    # Catalog dataset name the import creates or extends
    name: str
    # Version label of the imported version
    version: str
    # Why the import failed, when status is "FAILED"; None otherwise.
    #
    # Named `failure` and NOT `error`, deliberately: `error` is the key the
    # FAILURE envelope uses, so a client checking for it has to stay correct on
    # a perfectly healthy read of a failed import.
    failure: Optional[DatasetImportFailure] = None
    #: Non-fatal but consequential outcomes — see :class:`ImportWarning`.
    warnings: List[ImportWarning] = field(default_factory=list)
    # Number of tasks parsed, once counted
    task_count: Optional[int] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


@dataclass
class Agent:
    """A private agent registered by the caller.

    Once registered, ``name`` is usable in job ``agents[].name`` exactly like a
    built-in ("claude", "codex", ...). Private to its owner: another user's
    name reads as ``agent_not_found``, never as a permission error — existence
    is never leaked.
    """
    # The name to put in job agents[].name
    name: str
    # How the executables were produced: "install_script" | "tarball"
    source: str
    # The command run headless with `sh -c` at the task working directory
    run_command: str
    # Caller-declared env injected at RUN time only. It may not override the
    # run contract's own keys — the server rejects that at registration with
    # ``agent_invalid_env``.
    env: Dict[str, str] = field(default_factory=dict)
    created_at: str = ''
    updated_at: str = ''


@dataclass
class ApiKey:
    """A key descriptor. The secret is never returned."""
    id: str
    label: Optional[str]
    created_at: str
    last_used_at: Optional[str]


@dataclass
class AuthStatus:
    """Who the caller is and the key they used."""
    user_id: str
    email: Optional[str]
    key: ApiKey


# The ONE page envelope, on every collection this surface returns — top level
# or nested. ``next_cursor`` means one thing everywhere: pass it back as
# ``cursor=`` for the next page, and None means there is no next page. It never
# echoes where you already are, so a poller can always tell it has caught up.
# (On the wire the envelope keys are the frozen items/nextCursor/hasMore.)


@dataclass
class JobPage:
    items: List[Job]
    next_cursor: Optional[str]
    has_more: bool


@dataclass
class TrialPage:
    items: List[Trial]
    next_cursor: Optional[str]
    has_more: bool


@dataclass
class JobTaskRollupPage:
    items: List[JobTaskRollup]
    next_cursor: Optional[str]
    has_more: bool


@dataclass
class DatasetPage:
    items: List[Dataset]
    next_cursor: Optional[str]
    has_more: bool


@dataclass
class DatasetImportPage:
    items: List[DatasetImport]
    next_cursor: Optional[str]
    has_more: bool


@dataclass
class AgentPage:
    items: List[Agent]
    next_cursor: Optional[str]
    has_more: bool


# =============================================================================
# MAPPERS
# =============================================================================

def _map_dataset_ref(data: Dict[str, Any]) -> DatasetRef:
    return DatasetRef(name=data.get('name', ''), version=data.get('version', ''))


def _map_agent_arm(data: Dict[str, Any]) -> AgentArm:
    # Map only the public arm fields.
    return AgentArm(
        name=data.get('name', ''),
        model_name=data.get('model_name', ''),
        version=data.get('version'),
        reasoning_effort=data.get('reasoning_effort'),
    )


def _map_upstream(data: Any) -> Optional[UpstreamStatus]:
    """Map the ``upstream`` field, tolerating an older server that omits it.

    A missing field and an explicit null mean the same thing to a caller —
    nothing to watch — so both become None, and a client never has to
    distinguish "this server is old" from "this dataset has no git source".
    """
    if not isinstance(data, dict):
        return None
    behind_by = data.get('behind_by')
    return UpstreamStatus(
        ref=data['ref'],
        current_commit=data['current_commit'],
        latest_commit=data.get('latest_commit'),
        moved=data.get('moved') is True,
        behind_by=behind_by if isinstance(behind_by, int) else None,
        checked_at=data.get('checked_at'),
        error=data.get('error'),
        auto_import=data.get('auto_import') is True,
    )


def _map_capability_document(raw: Dict[str, Any]) -> CapabilityDocument:
    """Map GET /api/meta into the public dataclass."""
    return CapabilityDocument(
        schema_version=raw.get('schema_version', 0),
        agents=[
            AgentCapability(
                name=item['name'],
                effort_support=item.get('effort_support') is True,
                version_pinnable=item.get('version_pinnable') is True,
                latest_version=item.get('latest_version'),
            )
            for item in raw.get('agents', [])
        ],
        agent_registration=raw.get('agent_registration', {}),
        sandbox_providers=[
            ProviderCapability(
                name=item['name'],
                default=item.get('default', False),
                sizing=item.get('sizing', {}),
                refuses=item.get('refuses', []),
            )
            for item in raw.get('sandbox_providers', [])
        ],
        managed_providers=[
            ManagedProviderCapability(
                name=item['name'],
                configured=item.get('configured', False),
                requires_config=item.get('requires_config', []),
                missing_config=item.get('missing_config', []),
                agent_sessions=item.get('agent_sessions', False),
                agent_sessions_reason=item.get('agent_sessions_reason'),
            )
            for item in raw.get('managed_providers', [])
        ],
        platform_constraints=raw.get('platform_constraints', []),
        network_modes=raw.get('network_modes', []),
        statuses={
            key: StatusVocabulary(
                values=value.get('values', []),
                terminal=value.get('terminal', []),
            )
            for key, value in (raw.get('statuses') or {}).items()
        },
        limits=raw.get('limits', {}),
        import_warning_codes=raw.get('import_warning_codes', []),
        error_codes=raw.get('error_codes', []),
    )


def _map_version_gate(data: Any) -> Optional[DatasetVersionGate]:
    """Map a version's activation-gate field, tolerating every server generation.

    An older server has no ``gate`` field at all; the current server sends the
    nested form (``{status, attempts, failure: {code, message}}``); the flat
    form carries ``code``/``message`` directly. Anything unreadable becomes
    ``None`` — a missing gate is "nothing to report", never a crash and never
    "passed".
    """
    if not isinstance(data, dict) or not isinstance(data.get('status'), str):
        return None
    failure = data.get('failure')
    failure = failure if isinstance(failure, dict) else {}
    code = data.get('code') if isinstance(data.get('code'), str) else failure.get('code')
    message = (
        data.get('message') if isinstance(data.get('message'), str) else failure.get('message')
    )
    attempts = data.get('attempts')
    return DatasetVersionGate(
        status=data['status'],
        attempts=attempts if isinstance(attempts, int) and not isinstance(attempts, bool) else 0,
        code=code if isinstance(code, str) else None,
        message=message if isinstance(message, str) else None,
    )


def _map_dataset_version(data: Dict[str, Any]) -> DatasetVersion:
    return DatasetVersion(
        version=data['version'],
        state=data.get('state', ''),
        created_at=data.get('created_at', ''),
        task_count=int(data.get('task_count', 0)),
        gate=_map_version_gate(data.get('gate')),
    )


def _map_dataset_summary(data: Dict[str, Any]) -> Dataset:
    """The summary Dataset shape: list rows and the update() echo share it."""
    return Dataset(
        name=data['name'],
        title=data.get('title'),
        description=data.get('description'),
        active_version=(
            _map_dataset_version(data['active_version'])
            if data.get('active_version')
            else None
        ),
        upstream=_map_upstream(data.get('upstream')),
    )


def _map_task(data: Dict[str, Any]) -> Task:
    providers_raw = data.get('providers') or {}
    return Task(
        task_name=data['task_name'],
        agent_timeout_sec=data.get('agent_timeout_sec', 0),
        verifier_timeout_sec=data.get('verifier_timeout_sec', 0),
        providers={
            provider: TaskProviderVerdict(
                ok=bool(verdict.get('ok')),
                reason=verdict.get('reason'),
            )
            for provider, verdict in providers_raw.items()
            if isinstance(verdict, dict)
        },
    )


def _map_dataset_detail(raw: Dict[str, Any]) -> Dataset:
    """The full detail Dataset shape: get() and activate() echo it."""
    active = raw.get('active_version')
    selected = raw.get('selected_version')
    task_items, task_cursor, task_more = _page_parts(raw.get('tasks'))
    return Dataset(
        name=raw['name'],
        title=raw.get('title'),
        description=raw.get('description'),
        active_version=_map_dataset_version(active) if active else None,
        upstream=_map_upstream(raw.get('upstream')),
        versions=[_map_dataset_version(item) for item in raw.get('versions', [])],
        selected_version=_map_dataset_version(selected) if selected else None,
        tasks=TaskPage(
            items=[_map_task(item) for item in task_items],
            next_cursor=task_cursor,
            has_more=task_more,
        ),
        created_at=raw.get('created_at'),
        updated_at=raw.get('updated_at'),
    )


def _map_counts(data: Any) -> JobCounts:
    counts = data if isinstance(data, dict) else {}
    return JobCounts(
        agents=int(counts.get('agents', 0)),
        tasks=int(counts.get('tasks', 0)),
    )


def _map_trial_tally(data: Any) -> TrialTally:
    tally = data if isinstance(data, dict) else {}
    return TrialTally(
        total=int(tally.get('total', 0)),
        # byStatus is one of the four frozen camelCase wire keys.
        by_status=tally.get('byStatus') or {},
    )


def _map_job_failure(data: Any) -> Optional[JobFailure]:
    if not isinstance(data, dict):
        return None
    return JobFailure(code=data.get('code', ''), message=data.get('message', ''))


def _map_source_job(data: Dict[str, Any]) -> SourceJob:
    return SourceJob(
        action=data.get('action', ''),
        type=data.get('type', ''),
        job_id=data.get('job_id', ''),
    )


def _map_job(data: Dict[str, Any]) -> Job:
    """The ONE job mapper — nothing conditional, because nothing is optional."""
    agents = data.get('agents')
    datasets = data.get('datasets')
    source_jobs = data.get('source_jobs')
    return Job(
        id=data['id'],
        job_name=data.get('job_name', ''),
        status=data.get('status', ''),
        datasets=(
            [_map_dataset_ref(item) for item in datasets]
            if isinstance(datasets, list)
            else []
        ),
        agents=[_map_agent_arm(item) for item in agents] if isinstance(agents, list) else [],
        n_attempts=int(data.get('n_attempts', 0)),
        n_concurrent_trials=int(data.get('n_concurrent_trials', 0)),
        max_trial_spend_usd=float(data.get('max_trial_spend_usd', 0)),
        worst_case_spend_usd=float(data.get('worst_case_spend_usd', 0)),
        sandbox_provider=data.get('sandbox_provider', ''),
        counts=_map_counts(data.get('counts')),
        n_total_trials=int(data.get('n_total_trials', 0)),
        trials=_map_trial_tally(data.get('trials')),
        stats=data.get('stats') or {},
        failure=_map_job_failure(data.get('failure')),
        source_jobs=(
            [_map_source_job(item) for item in source_jobs]
            if isinstance(source_jobs, list)
            else []
        ),
        is_regrade=data.get('is_regrade') is True,
        idempotent_replay=bool(data.get('idempotent_replay', False)),
        started_at=data.get('started_at', ''),
        updated_at=data.get('updated_at', ''),
        finished_at=data.get('finished_at'),
    )


def _map_job_task_rollup(data: Dict[str, Any]) -> JobTaskRollup:
    mean_reward = data.get('mean_reward')
    cost_usd = data.get('cost_usd')
    return JobTaskRollup(
        task_name=data.get('task_name', ''),
        source=data.get('source', ''),
        trials=_map_trial_tally(data.get('trials')),
        mean_reward=float(mean_reward) if isinstance(mean_reward, (int, float)) else None,
        cost_usd=float(cost_usd) if isinstance(cost_usd, (int, float)) else None,
    )


def _map_auth_status(data: Dict[str, Any]) -> AuthStatus:
    key = data.get('key') if isinstance(data.get('key'), dict) else {}
    return AuthStatus(
        user_id=data.get('user_id', ''),
        email=data.get('email'),
        key=ApiKey(
            id=key.get('id', ''),
            label=key.get('label'),
            created_at=key.get('created_at', ''),
            last_used_at=key.get('last_used_at'),
        ),
    )


def _page_parts(data: Any) -> 'tuple[List[Any], Optional[str], bool]':
    """The one page envelope, unpacked: (items, next_cursor, has_more)."""
    page = data if isinstance(data, dict) else {}
    items = page.get('items')
    return (
        items if isinstance(items, list) else [],
        page.get('nextCursor'),
        bool(page.get('hasMore', False)),
    )


def _page_query(
    limit: Optional[int] = None,
    cursor: Optional[str] = None,
    **extra: Optional[str],
) -> str:
    """Serialize limit/cursor (plus anything else) into a query string."""
    params: Dict[str, str] = {}
    if limit is not None:
        params['limit'] = str(limit)
    if cursor is not None:
        params['cursor'] = cursor
    for key, value in extra.items():
        if value is not None:
            params[key] = value
    query = urllib.parse.urlencode(params)
    return f'?{query}' if query else ''


def _map_timing(data: Any) -> Optional[TimingInfo]:
    if not isinstance(data, dict):
        return None
    return TimingInfo(
        started_at=data.get('started_at'),
        finished_at=data.get('finished_at'),
    )


def _map_agent_info(data: Any) -> AgentInfo:
    info = data if isinstance(data, dict) else {}
    model = info.get('model_info') if isinstance(info.get('model_info'), dict) else {}
    return AgentInfo(
        name=info.get('name', ''),
        version=info.get('version'),
        model_info=ModelInfo(
            name=model.get('name', ''),
            provider=model.get('provider'),
        ),
        reasoning_effort=info.get('reasoning_effort'),
    )


def _map_agent_result(data: Any) -> Optional[AgentResult]:
    if not isinstance(data, dict):
        return None
    return AgentResult(
        n_input_tokens=data.get('n_input_tokens'),
        n_cache_tokens=data.get('n_cache_tokens'),
        n_output_tokens=data.get('n_output_tokens'),
        cost_usd=data.get('cost_usd'),
        rollout_details=data.get('rollout_details'),
        metadata=data.get('metadata'),
    )


def _map_verifier_result(data: Any) -> Optional[VerifierResult]:
    if not isinstance(data, dict):
        return None
    return VerifierResult(rewards=data.get('rewards'))


def _map_exception_info(data: Any) -> Optional[ExceptionInfo]:
    if not isinstance(data, dict):
        return None
    return ExceptionInfo(
        exception_type=data.get('exception_type', ''),
        exception_message=data.get('exception_message', ''),
        exception_traceback=data.get('exception_traceback', ''),
        occurred_at=data.get('occurred_at', ''),
    )


def _map_trial(data: Dict[str, Any]) -> Trial:
    return Trial(
        id=data['id'],
        job_id=data.get('job_id', ''),
        task_name=data.get('task_name', ''),
        source=data.get('source', ''),
        agent_info=_map_agent_info(data.get('agent_info')),
        attempt=int(data.get('attempt', 0)),
        status=data.get('status', ''),
        reward=data.get('reward'),
        verifier_result=_map_verifier_result(data.get('verifier_result')),
        exception_info=_map_exception_info(data.get('exception_info')),
        agent_result=_map_agent_result(data.get('agent_result')),
        environment_setup=_map_timing(data.get('environment_setup')),
        agent_setup=_map_timing(data.get('agent_setup')),
        agent_execution=_map_timing(data.get('agent_execution')),
        verifier=_map_timing(data.get('verifier')),
        step_results=data.get('step_results'),
        spend_source=data.get('spend_source'),
        # Mid-run lower bound, kept beside the settled pair and never folded
        # into it: it lags the gateway and is CLEARED when the trial settles.
        live_spent_usd=data.get('live_spent_usd'),
        live_spend_at=data.get('live_spend_at'),
        max_trial_spend_usd=data.get('max_trial_spend_usd'),
        sandbox_provider=data.get('sandbox_provider'),
        # Where the trial ran. Absent reads the same as "never booted a box".
        sandbox_id=data.get('sandbox_id'),
        verifier_sandbox_id=data.get('verifier_sandbox_id'),
        verifier_environment_mode=data.get('verifier_environment_mode'),
        attempt_phase=data.get('attempt_phase'),
        session_ref=data.get('session_ref'),
        started_at=data.get('started_at'),
        finished_at=data.get('finished_at'),
    )


def _map_trace_event(data: Dict[str, Any]) -> TraceEvent:
    return TraceEvent(
        seq=int(data.get('seq', -1)),
        type=data.get('type', ''),
        data=data.get('data') or {},
    )


def _map_coverage(data: Any) -> CompareCoverage:
    data = data if isinstance(data, dict) else {}
    return CompareCoverage(
        scored=int(data.get('scored', 0)),
        total=int(data.get('total', 0)),
    )


def _map_compare_aggregate(data: Dict[str, Any]) -> CompareJobAggregate:
    agents = data.get('agents')
    datasets = data.get('datasets')
    return CompareJobAggregate(
        id=data.get('id', ''),
        datasets=(
            [_map_dataset_ref(item) for item in datasets]
            if isinstance(datasets, list)
            else []
        ),
        status=data.get('status', ''),
        mean_reward=data.get('mean_reward'),
        coverage=_map_coverage(data.get('coverage')),
        cost_usd=float(data.get('cost_usd', 0)),
        agents=(
            [_map_agent_arm(item) for item in agents]
            if isinstance(agents, list)
            else []
        ),
        started_at=data.get('started_at', ''),
    )


def _map_compare_cell(data: Dict[str, Any]) -> CompareCell:
    return CompareCell(
        job_id=data.get('job_id', ''),
        status=data.get('status', ''),
        mean_reward=data.get('mean_reward'),
        coverage=_map_coverage(data.get('coverage')),
    )


def _map_compare_task_row(data: Dict[str, Any]) -> CompareTaskRow:
    return CompareTaskRow(
        task_name=data.get('task_name', ''),
        disagreement=bool(data.get('disagreement', False)),
        cells=[_map_compare_cell(item) for item in data.get('cells', [])],
    )


def _map_import_failure(data: Any) -> Optional[DatasetImportFailure]:
    if not isinstance(data, dict):
        return None
    return DatasetImportFailure(
        code=data.get('code', 'import_failed'),
        message=data.get('message', ''),
        failures=[
            ImportTaskFailure(
                task_name=item.get('task_name', ''),
                error=item.get('error', ''),
            )
            for item in data.get('failures', [])
            if isinstance(item, dict)
        ],
    )


def _map_agent(data: Dict[str, Any]) -> Agent:
    return Agent(
        name=data.get('name', ''),
        source=data.get('source', ''),
        run_command=data.get('run_command', ''),
        env=data.get('env') or {},
        created_at=data.get('created_at', ''),
        updated_at=data.get('updated_at', ''),
    )


def _map_dataset_import(data: Dict[str, Any]) -> DatasetImport:
    dataset_import = DatasetImport(
        id=data.get('id', ''),
        status=data.get('status', ''),
        name=data.get('name', ''),
        version=data.get('version', ''),
    )
    dataset_import.failure = _map_import_failure(data.get('failure'))
    # Consequential, not cosmetic: an import whose warnings include
    # no_solutions_archived can never be activated, and dropping the field made
    # it look identical to one that can.
    dataset_import.warnings = [
        ImportWarning(code=item.get('code', ''), message=item.get('message'))
        for item in data.get('warnings', [])
        if isinstance(item, dict)
    ]
    if isinstance(data.get('task_count'), int):
        dataset_import.task_count = data.get('task_count')
    if isinstance(data.get('created_at'), str):
        dataset_import.created_at = data['created_at']
    if isinstance(data.get('updated_at'), str):
        dataset_import.updated_at = data['updated_at']
    return dataset_import


# =============================================================================
# HTTP CORE
# =============================================================================

def _parse_error_body(text: str, fallback: str) -> Dict[str, Any]:
    """Extract the hosted error envelope {error: {code, message, param, details, ...}}."""
    unparsed = {'code': 'unknown_error', 'message': text or fallback}
    try:
        body = json.loads(text)
    except ValueError:
        return unparsed
    error = body.get('error') if isinstance(body, dict) else None
    if not isinstance(error, dict):
        return unparsed
    retry_after = error.get('retryAfterSec')
    return {
        'code': error['code'] if isinstance(error.get('code'), str) else 'unknown_error',
        'message': error['message'] if isinstance(error.get('message'), str) else fallback,
        'param': error['param'] if isinstance(error.get('param'), str) else None,
        'details': error['details'] if isinstance(error.get('details'), dict) else None,
        'retry_after_sec': _finite_delay(retry_after),
        'request_id': error['requestId'] if isinstance(error.get('requestId'), str) else None,
    }


def _finite_delay(value: Any) -> Optional[float]:
    """A delay is a reading only when it is a FINITE number; else it is absent.

    An infinite or NaN delay is not a long wait, it is a hang: every caller of
    this value sleeps it (``max(delay, poll_interval)``), so ``inf`` parks the
    watch loop forever with no bound and no output. TypeScript refuses the same
    reading through ``Number.isFinite``, and one law stated two ways is two
    laws — Python must refuse it in both mirrors, header and envelope alike
    (``json.loads`` accepts the bare ``Infinity``/``NaN`` literals that
    ``JSON.parse`` throws on, so the body path admits what TypeScript cannot).
    """
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def _header_retry_after_sec(headers: Any) -> Optional[float]:
    """The ``Retry-After`` header as seconds, or None when absent/unreadable.

    The header is the SECOND reading everywhere: the envelope's
    ``retryAfterSec`` wins, because a body always survives a proxy that eats
    headers. Both the request path and the event stream read it through here.
    ``float()`` accepts ``"Infinity"`` and ``"nan"``, so the finite check is
    what makes an unreadable header absent rather than an unbounded sleep.
    """
    raw = headers.get('Retry-After') if headers else None
    try:
        return _finite_delay(float(raw)) if raw else None
    except ValueError:
        return None


def _raise_api_error(exc: urllib.error.HTTPError) -> NoReturn:
    detail = exc.read().decode('utf-8', errors='replace')
    parsed = _parse_error_body(detail, str(exc.reason))
    # Header fallbacks, so an unparseable body still yields a usable request id
    # and retry delay.
    headers = getattr(exc, 'headers', None)
    header_request_id = headers.get('X-Request-Id') if headers else None
    header_retry_sec = _header_retry_after_sec(headers)
    # Body-first means the body WINS, including a 0: `or` falls through every
    # falsy reading, so an envelope stating 0 silently became the header's
    # delay and the two SDKs stopped describing one law (TypeScript's
    # readRetryAfterSec keeps the 0). Absent is the only fallback trigger.
    body_retry_sec = parsed.get('retry_after_sec')
    raise EvolveAPIError(
        exc.code,
        parsed['code'],
        parsed['message'],
        param=parsed.get('param'),
        details=parsed.get('details'),
        retry_after_sec=body_retry_sec if body_retry_sec is not None else header_retry_sec,
        request_id=parsed.get('request_id') or header_request_id,
    ) from exc


class _HostedHttp:
    def __init__(self, factory: str, config: Optional[HostedClientConfig]):
        self._factory = factory
        self._config = config or HostedClientConfig()

    def base_url(self) -> str:
        return (
            self._config.base_url
            or os.environ.get('EVOLVE_DASHBOARD_URL')
            or DEFAULT_BASE_URL
        ).rstrip('/')

    def api_key(self) -> str:
        api_key = self._config.api_key or os.environ.get('EVOLVE_API_KEY')
        if not api_key:
            raise ValueError(
                f'{self._factory}() requires an API key. Set EVOLVE_API_KEY or '
                'pass HostedClientConfig(api_key=...).'
            )
        return api_key

    async def request_json(
        self,
        path: str,
        method: str = 'GET',
        body: Optional[Dict[str, Any]] = None,
        headers: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        return await asyncio.to_thread(self._request_sync, path, method, body, headers, False)

    async def request_bytes(
        self, path: str, *, timeout: int = DOWNLOAD_TIMEOUT_SEC
    ) -> 'tuple[bytes, Dict[str, str]]':
        """GET raw bytes plus response headers.

        The timeout defaults to the DOWNLOAD budget, not the JSON one: every
        caller of this is fetching an archive or a package, and a 512 MB body
        does not arrive inside a request timeout sized for a status poll. The
        to-disk path has always used the larger budget, and the two shapes
        failing at different sizes is the kind of difference nobody debugs.
        """
        return await asyncio.to_thread(
            self._request_sync, path, 'GET', None, None, True, timeout
        )

    async def request_upload(
        self, path: str, data: bytes, headers: Dict[str, str], method: str = 'POST'
    ) -> Dict[str, Any]:
        """Send raw bytes (e.g. a gzipped tarball) and parse the JSON reply.

        ``method`` exists for the agent upsert, which is the same body grammar
        at the same content type under PUT.
        """
        return await asyncio.to_thread(self._upload_sync, path, data, headers, method)

    def _upload_sync(
        self, path: str, data: bytes, headers: Dict[str, str], method: str = 'POST'
    ) -> Dict[str, Any]:
        request_headers = {
            'Authorization': f'Bearer {self.api_key()}',
            'Accept': 'application/json',
        }
        request_headers.update(headers)
        request = urllib.request.Request(
            f'{self.base_url()}{path}',
            data=data,
            headers=request_headers,
            method=method,
        )
        try:
            with _http.urlopen(request, timeout=UPLOAD_TIMEOUT_SEC) as response:
                payload = response.read()
        except urllib.error.HTTPError as exc:
            _raise_api_error(exc)
        if not payload:
            return {}
        return json.loads(payload.decode('utf-8'))

    async def download(self, path: str, to_dir: str, default_filename: str) -> str:
        return await asyncio.to_thread(self._download_sync, path, to_dir, default_filename)

    def _request_sync(
        self,
        path: str,
        method: str,
        body: Optional[Dict[str, Any]],
        headers: Optional[Dict[str, str]],
        raw: bool,
        timeout: int = REQUEST_TIMEOUT_SEC,
    ):
        data = json.dumps(body).encode('utf-8') if body is not None else None
        request_headers = {
            'Authorization': f'Bearer {self.api_key()}',
            'Accept': 'application/json',
        }
        if data is not None:
            request_headers['Content-Type'] = 'application/json'
        if headers:
            request_headers.update(headers)
        request = urllib.request.Request(
            f'{self.base_url()}{path}',
            data=data,
            headers=request_headers,
            method=method,
        )
        try:
            with _http.urlopen(request, timeout=timeout) as response:
                payload = response.read()
                if raw:
                    return payload, dict(response.headers.items())
        except urllib.error.HTTPError as exc:
            _raise_api_error(exc)
        if not payload:
            return {}
        return json.loads(payload.decode('utf-8'))

    def _download_sync(self, path: str, to_dir: str, default_filename: str) -> str:
        """Stream a download straight to disk — never buffers the archive in memory."""
        request = urllib.request.Request(
            f'{self.base_url()}{path}',
            headers={'Authorization': f'Bearer {self.api_key()}'},
        )
        try:
            with _http.urlopen(request, timeout=DOWNLOAD_TIMEOUT_SEC) as response:
                os.makedirs(to_dir, exist_ok=True)
                disposition = response.headers.get('Content-Disposition', '') or ''
                match = re.search(r'filename="([^"]+)"', disposition)
                filename = _safe_download_filename(
                    match.group(1) if match else None, default_filename
                )
                target = os.path.join(to_dir, filename)
                # TEMP-THEN-RENAME: bytes never appear at the final path until
                # they are complete AND verified, so a transfer that dies partway
                # leaves nothing a later run could mistake for the corpus.
                #
                # THE SUFFIX IS PER CALL, and it is not decoration. Two
                # concurrent downloads of one package into one directory shared
                # ``<file>.part`` verbatim: they interleaved writes into the same
                # file, then the first replace won and the second died on a bare
                # ENOENT with no hint of why. Worse quietly: each call hashed ITS
                # OWN stream, so the digest check proved something about bytes
                # that were never the ones on disk. With a random name per call,
                # each stream owns its file end to end, the verification covers
                # exactly what gets promoted, and both callers get the package.
                part = f'{target}.{secrets.token_hex(8)}.part'
                declared = response.headers.get('Content-Length')
                expected = response.headers.get(PACKAGE_DIGEST_HEADER)
                digest = hashlib.sha256()
                received = 0
                try:
                    with open(part, 'wb') as f:
                        while True:
                            chunk = response.read(1024 * 1024)
                            if not chunk:
                                break
                            digest.update(chunk)
                            received += len(chunk)
                            f.write(chunk)
                    # TRUNCATION. copyfileobj over urllib treats a socket cut
                    # mid-body as a normal end of stream, so a short read used to
                    # return a partial file as SUCCESS. Content-Length is the
                    # server's own count; disagreeing with it means the body did
                    # not all arrive.
                    if declared is not None and received != int(declared):
                        raise EvolveIncompleteDownloadError(int(declared), received)
                    if expected and digest.hexdigest() != expected:
                        raise EvolveDigestMismatchError(expected, digest.hexdigest())
                    os.replace(part, target)
                except BaseException:
                    # The partial is never promoted and never survives: a file
                    # that looks like the corpus and is not is worse than none.
                    try:
                        os.unlink(part)
                    except OSError:
                        pass
                    raise
                return target
        except urllib.error.HTTPError as exc:
            _raise_api_error(exc)


def _safe_download_filename(candidate: Optional[str], fallback: str) -> str:
    """The filename to save a download under, taken from Content-Disposition.

    THE SERVER DOES NOT GET TO CHOOSE A PATH. This value is joined onto a
    directory the user picked, so a filename carrying a separator or ".." would
    write outside it — and the dataset download's filename interpolates a
    user-supplied version label, which makes it attacker-influenced rather than
    merely server-supplied. basename() strips any directory part, and anything
    that still looks like a path component, is empty, or is a dot-entry falls
    back to the caller's own name.

    A BACKSLASH IS REFUSED, NOT REPAIRED, which is where this used to disagree
    with the TypeScript SDK: ``a\\b.tar.gz`` was rewritten here to ``b.tar.gz``
    while TypeScript fell back to its own name, so the same response produced
    two different files. Refusing is the half worth keeping. On POSIX that
    string is one legal filename, so treating the backslash as a separator
    silently renames the user's file on a guess about which platform wrote the
    header — the same "two parsers, one string" ambiguity the git URL rules
    refuse rather than resolve. The fallback is a name we chose and can explain.
    """
    if not candidate:
        return fallback
    name = os.path.basename(candidate)
    if (
        name in ('', '.', '..')
        or '/' in name
        or '\\' in name
        or any(ord(c) < 32 for c in name)
    ):
        return fallback
    return name


def _multipart_body(
    fields: Dict[str, Optional[str]],
    archive: Optional['tuple[str, bytes]'] = None,
) -> 'tuple[bytes, str]':
    """Build the multipart/form-data body both upload routes take.

    Metadata goes in named parts FIRST, then the bytes as the ``archive`` part —
    order matters, because the server refuses a name it will never accept
    before receiving the upload, and it can only do that if the metadata
    arrives first. Nothing rides the query string: a run command and a set of
    environment values in a URL land in every access log and proxy buffer
    between the caller and the server.
    """
    boundary = f'----evolve{uuid.uuid4().hex}'
    parts: List[bytes] = []
    for name, value in fields.items():
        if value is None:
            continue
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n'.encode('utf-8')
            + value.encode('utf-8')
            + b'\r\n'
        )
    if archive is not None:
        filename, data = archive
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="archive"; '
            f'filename="{filename}"\r\nContent-Type: application/gzip\r\n\r\n'.encode('utf-8')
        )
        parts.append(data)
        parts.append(b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode('utf-8'))
    return b''.join(parts), f'multipart/form-data; boundary={boundary}'


def _agent_upload_body(
    caller: str,
    *,
    name: str,
    run_command: str,
    install_script: Optional[str],
    directory: Optional[str],
    env: Optional[Dict[str, str]],
) -> 'tuple[bytes, str]':
    """The multipart body both ``create()`` and ``upsert()`` send.

    Shared because the two differ only in method and URL: one grammar means an
    agent registered by either route is byte-identical on the wire.
    """
    if install_script is not None and directory is not None:
        raise ValueError(
            f'{caller} takes EITHER an install script (install_script=...) '
            'or a local directory (directory=...), not both'
        )
    if install_script is None and directory is None:
        raise ValueError(
            f'{caller} requires either an install script (install_script=...) '
            'or a local directory (directory=...), plus run_command=...'
        )
    fields: Dict[str, Optional[str]] = {'name': name, 'run_command': run_command}
    if env is not None:
        fields['env'] = json.dumps(env)
    if install_script is not None:
        fields['install_script'] = install_script
    archive: Optional['tuple[str, bytes]'] = None
    if directory is not None:
        archive = ('source.tar.gz', _tar_gzip_directory(directory))
    return _multipart_body(fields, archive)


#: Names never packed, matched at any depth: version-control metadata, a macOS
#: Finder artifact, and the conventional Python virtualenv. All three are
#: machine state rather than corpus, and ".git" alone would blow the server's
#: entry cap. Nothing else is filtered — kept identical to the TypeScript
#: packer's SKIP set (packages/sdk-ts/src/hosted/tar.ts) so both SDKs publish
#: the same corpus from the same directory.
_TAR_SKIP_NAMES = frozenset({'.git', '.DS_Store', '.venv'})


class _ChunkSink:
    """A write-only file object that keeps the gzip output as a list of chunks.

    Standing in for ``io.BytesIO`` so the archive is never held twice: BytesIO
    grows by reallocating and ``getvalue()`` copies the whole thing again,
    while a chunk list is joined exactly once at the end.
    """

    def __init__(self) -> None:
        self.chunks: List[bytes] = []

    def write(self, data: bytes) -> int:
        self.chunks.append(bytes(data))
        return len(data)

    def flush(self) -> None:
        return None


def _list_corpus_files(root: str) -> 'List[tuple[str, str, int]]':
    """Regular files under ``root`` as (posix relative path, absolute path, mode), sorted.

    Dotfiles are corpus content and are PACKED — ``.gitignore``,
    ``.dockerignore``, ``.env.example`` and ``.config/`` belong to the task, and
    dropping them published a corpus that did not match the directory on disk.
    Only the three names in ``_TAR_SKIP_NAMES`` are filtered. Symlinks are never
    followed or emitted: the server rejects every non-file entry.
    """
    out: 'List[tuple[str, str, int]]' = []

    def walk(rel_dir: str) -> None:
        abs_dir = root if rel_dir == '' else os.path.join(root, rel_dir)
        with os.scandir(abs_dir) as entries:
            names = sorted(entry.name for entry in entries)
        for name in names:
            if name in _TAR_SKIP_NAMES:
                continue
            rel = name if rel_dir == '' else f'{rel_dir}/{name}'
            abs_path = os.path.join(abs_dir, name)
            st = os.lstat(abs_path)
            if stat.S_ISLNK(st.st_mode):
                continue
            if stat.S_ISDIR(st.st_mode):
                walk(rel)
            elif stat.S_ISREG(st.st_mode):
                # Two modes only: executable-by-anyone becomes 0o755,
                # everything else 0o644, so the developer's umask never
                # reaches the archive while a verifier script still arrives
                # runnable.
                out.append((rel, abs_path, 0o755 if st.st_mode & 0o111 else 0o644))

    walk('')
    out.sort(key=lambda entry: entry[0])
    return out


def _tar_gzip_directory(directory: str) -> bytes:
    """Deterministically tar + gzip a corpus directory for the directory publish.

    Same content -> same bytes (so the tarball sha256 the server records as the
    import's source identity is reproducible): entries sorted by path, headers
    normalized (mtime 0, uid/gid 0, empty uname/gname), and gzip carrying no
    timestamp. The one field NOT flattened is the executable bit, normalized to
    0o755 / 0o644 — a verifier or solution script that arrives without +x
    cannot run.

    Contents match the TypeScript packer: every dotfile except ".git",
    ".DS_Store" and ".venv" is packed, and symlinks are skipped. The bytes do
    not match it, because the two languages' gzip implementations differ; the
    contract is that each SDK is reproducible on its own.

    Files stream off disk through the tar writer a read buffer at a time, and
    only the compressed output is collected, since the upload takes one body.
    """
    root = os.path.abspath(directory)
    if not os.path.isdir(root):
        raise ValueError(f'directory not found: {directory}')
    files = _list_corpus_files(root)

    sink = _ChunkSink()
    with gzip.GzipFile(fileobj=sink, mode='wb', mtime=0, compresslevel=9) as gz:
        # PAX rather than USTAR: a corpus path longer than the 100-byte USTAR
        # name field is a hard error there, and the TypeScript packer accepts
        # it. PAX emits an extended header only for the entries that need one,
        # so ordinary names keep the same layout.
        with tarfile.open(fileobj=gz, mode='w', format=tarfile.PAX_FORMAT) as tar:
            for rel, abs_path, mode in files:
                info = tarfile.TarInfo(name=rel)
                info.size = os.path.getsize(abs_path)
                info.mtime = 0
                info.mode = mode
                info.uid = 0
                info.gid = 0
                info.uname = ''
                info.gname = ''
                info.type = tarfile.REGTYPE
                with open(abs_path, 'rb') as handle:
                    tar.addfile(info, handle)
    return b''.join(sink.chunks)


# =============================================================================
# PAGINATION (awaitable + async-iterable)
# =============================================================================

class _PaginatedList:
    """A cursor-paged result that is both awaitable and async-iterable.

    ``await`` resolves the first page, honoring the caller's ``limit``/``cursor``
    (the original page form). ``async for`` walks every row across pages,
    following ``next_cursor`` from the caller's starting cursor.
    """

    def __init__(
        self,
        fetch_page: Callable[[Optional[int], Optional[str]], Awaitable[Any]],
        rows_of: Callable[[Any], List[Any]],
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ):
        self._fetch_page = fetch_page
        self._rows_of = rows_of
        self._limit = limit
        self._cursor = cursor

    def __await__(self):
        return self._fetch_page(self._limit, self._cursor).__await__()

    def __aiter__(self):
        return self._iterate()

    async def _iterate(self):
        cursor = self._cursor
        while True:
            page = await self._fetch_page(self._limit, cursor)
            for row in self._rows_of(page):
                yield row
            if not page.next_cursor:
                return
            cursor = page.next_cursor


class _JobWatch:
    """A job watch that is both awaitable and async-iterable.

    ``await j.watch(id)`` resolves the final :class:`Job` once the terminal
    event arrives; ``async for event in j.watch(id)`` yields each
    :class:`JobEvent`. The same dual-use shape :class:`_PaginatedList` uses for
    ``list()``, and the same shape the TypeScript SDK's ``jobs().watch()``
    returns — TS/Python parity is a law here.

    Pick one form per handle: both drive the same underlying SSE stream.
    """

    def __init__(
        self,
        events: Callable[[], AsyncIterator['JobEvent']],
        final: Callable[[], Awaitable['Job']],
    ):
        self._events = events
        self._final = final

    def __await__(self):
        return self._final().__await__()

    def __aiter__(self):
        return self._events()


# =============================================================================
# DATASETS CLIENT
# =============================================================================

class DatasetsClient:
    """Client for the shared dataset catalog.

    Created via the standalone ``datasets()`` factory. Requires
    ``EVOLVE_API_KEY`` unless ``HostedClientConfig(api_key=...)`` is given.

    Example::

        from evolve import datasets

        async with datasets() as d:
            catalog = await d.list()
            deep_swe = await d.get('deep-swe@1.1')
    """

    def __init__(self, config: Optional[HostedClientConfig] = None):
        self._http = _HostedHttp('datasets', config)

    async def __aenter__(self) -> 'DatasetsClient':
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        return None

    def list(
        self,
        *,
        search: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> _PaginatedList:
        """List datasets with their active versions (cursor-paged).

        ``await`` the result for one page (honoring ``limit``/``cursor``), or
        ``async for`` it to walk the whole catalog across cursor pages.
        ``search`` is a server-side free-text filter over name and
        description, sent on every page fetch.
        """
        async def fetch_page(page_limit, page_cursor) -> DatasetPage:
            raw = await self._http.request_json(
                f'/api/datasets{_page_query(page_limit, page_cursor, search=search)}'
            )
            items, next_cursor, has_more = _page_parts(raw)
            return DatasetPage(
                items=[_map_dataset_summary(item) for item in items],
                next_cursor=next_cursor,
                has_more=has_more,
            )

        return _PaginatedList(
            fetch_page, lambda page: page.items, limit=limit, cursor=cursor
        )

    async def get(
        self,
        ref: str,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> Dataset:
        """Get one dataset: all versions + one page of the selected version's tasks.

        ``ref`` is ``"name"`` (active version's tasks) or ``"name@version"``;
        ``limit``/``cursor`` page the TASK list.
        """
        name, ref_version = _parse_dataset_ref(ref)
        query = _page_query(limit, cursor, version=ref_version)
        raw = await self._http.request_json(
            f'/api/datasets/{urllib.parse.quote(name)}{query}'
        )
        return _map_dataset_detail(raw)

    async def get_active(
        self,
        name: str,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> ActiveDataset:
        """Get a dataset's active version resolved to a runnable shape.

        Unlike :meth:`get`, ``version`` and ``tasks`` are guaranteed present.
        Raises :class:`NoActiveVersionError` when the dataset has no active
        version. Use :meth:`get` for the full multi-version detail.
        """
        dataset = await self.get(name, limit=limit, cursor=cursor)
        if dataset.active_version is None:
            raise NoActiveVersionError(name)
        return ActiveDataset(
            name=dataset.name,
            title=dataset.title,
            description=dataset.description,
            active_version=dataset.active_version,
            version=dataset.active_version.version,
            tasks=dataset.tasks or TaskPage(items=[], next_cursor=None, has_more=False),
            versions=dataset.versions or [],
            created_at=dataset.created_at,
            updated_at=dataset.updated_at,
        )

    async def publish(
        self,
        *,
        git_url: Optional[str] = None,
        git_ref: Optional[str] = None,
        directory: Optional[str] = None,
        name: str,
        version: str,
    ) -> DatasetImport:
        """Publish a dataset version (asynchronous server-side import).

        Provide EITHER a git source (``git_url`` + pinned ``git_ref``) OR a
        local corpus ``directory`` (tarred + gzipped deterministically on the
        client and uploaded). Returns immediately; poll with
        :meth:`get_import` / :meth:`watch_import`. ``version`` labels the new
        immutable version.

        ``git_url`` must be https — the import runs on a worker with no ssh
        client, so ssh:// and git@ remotes are refused at validation. For a
        private repository, put a token in the https url.
        """
        # ONE body grammar: multipart/form-data, metadata in named parts. The
        # corpus is the ``archive`` part; a git source is git_url + git_ref.
        if directory is not None:
            gzipped = await asyncio.to_thread(_tar_gzip_directory, directory)
            body, content_type = _multipart_body(
                {'name': name, 'version': version},
                ('corpus.tar.gz', gzipped),
            )
        elif git_url and git_ref:
            body, content_type = _multipart_body({
                'name': name,
                'version': version,
                'git_url': git_url,
                'git_ref': git_ref,
            })
        else:
            raise ValueError(
                'publish() requires either a git source (git_url=..., git_ref=...) '
                'or a local corpus directory (directory=...), plus name=... '
                'and version=...'
            )
        raw = await self._http.request_upload(
            '/api/datasets/publish', body, {'Content-Type': content_type}
        )
        return _map_dataset_import(raw)

    async def get_import(self, id: str) -> DatasetImport:
        """Get an import job's status (failure, warnings, and task_count when available)."""
        raw = await self._http.request_json(
            f'/api/datasets/imports/{urllib.parse.quote(id)}'
        )
        return _map_dataset_import(raw)

    async def watch_import(
        self,
        id: str,
        *,
        on_status: Optional[Callable[[DatasetImport], None]] = None,
        poll_interval_s: float = 2.0,
        timeout_s: Optional[float] = None,
    ) -> DatasetImport:
        """Poll ``get_import()`` until the import reaches a terminal status.

        Terminal statuses: "COMPLETED" or "FAILED" (``failure`` populated).
        ``on_status`` fires on every observed status change, including the
        first status seen.

        A rate limit or transient outage mid-watch is a delay, not an outcome:
        a 429/503 sleeps the server's ``retry_after_sec`` and keeps watching
        rather than dying while the import is still running.
        """
        if poll_interval_s <= 0:
            raise ValueError('poll_interval_s must be positive')
        deadline = time.monotonic() + timeout_s if timeout_s is not None else None
        last_status: Optional[str] = None
        while True:
            try:
                dataset_import = await self.get_import(id)
            except EvolveAPIError as error:
                if error.status not in (429, 503):
                    raise
                if deadline is not None and time.monotonic() >= deadline:
                    raise TimeoutError(
                        f'watch_import({id!r}) timed out after {timeout_s}s'
                    ) from error
                await asyncio.sleep(
                    max(error.retry_after_sec or 0.0, poll_interval_s)
                )
                continue
            if dataset_import.status != last_status:
                last_status = dataset_import.status
                if on_status is not None:
                    on_status(dataset_import)
            if dataset_import.status in _TERMINAL_IMPORT_STATUSES:
                return dataset_import
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f'watch_import({id!r}) timed out after {timeout_s}s')
            await asyncio.sleep(poll_interval_s)

    async def download(
        self,
        ref: str,
        *,
        to: Optional[str] = None,
    ):
        """Download the ORIGINAL corpus package a version was published from.

        The gzipped tarball you uploaded, or — for a git publish — the
        checked-out tree packed at import time. ``ref`` is ``"name"`` (the
        active version's package) or ``"name@version"``.

        OWNER ONLY. This is the one call that returns task files, and it
        returns them only to the account that owns the dataset; a
        platform-curated dataset has no owner, so nobody can download it.
        Someone else's dataset answers not-found, never a 403.

        The server verifies the stored bytes against their recorded sha256
        before sending anything, so a successful call is byte-identical to
        what was published. A version published before packages were retained
        has none, and it cannot be reconstructed: that is
        ``package_not_retained``, distinct from "not found" so you can say so.

        Returns the package bytes, or — when ``to`` (a directory) is given —
        streams straight to disk and returns the saved file path. Same ruling
        as ``jobs().download()``: no stream shape here where the TypeScript
        SDK has one — urllib in a worker thread makes an async chunk iterator
        a thread hop per chunk of unverified bytes, and ``to=`` already
        streams in constant memory with the digest checked before the file is
        promoted.
        """
        name, version = _parse_dataset_ref(ref)
        query = f'?version={urllib.parse.quote(version)}' if version else ''
        path = f'/api/datasets/{urllib.parse.quote(name)}/download{query}'
        if to is not None:
            return await self._http.download(path, to, f'{name}-corpus.tar.gz')
        payload, headers = await self._http.request_bytes(path)
        declared = headers.get('Content-Length')
        if declared is not None and len(payload) != int(declared):
            raise EvolveIncompleteDownloadError(int(declared), len(payload))
        expected = headers.get(PACKAGE_DIGEST_HEADER)
        if expected:
            actual = hashlib.sha256(payload).hexdigest()
            if actual != expected:
                raise EvolveDigestMismatchError(expected, actual)
        return payload

    def list_imports(
        self,
        *,
        status: Optional[str] = None,
        dataset: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> _PaginatedList:
        """List your own imports, newest first (cursor-paged).

        This is how you find an import again after losing the id ``publish()``
        returned — without it, closing a tab made a running import permanently
        unwatchable.

        ``await`` for one page, or ``async for`` to walk them all. ``status``
        filters on the import vocabulary ("QUEUED" | "RUNNING" | "COMPLETED" |
        "FAILED"); ``dataset`` narrows to one dataset name.
        """
        async def fetch_page(page_limit, page_cursor) -> DatasetImportPage:
            query = _page_query(page_limit, page_cursor)
            extra = []
            if status is not None:
                extra.append(f'status={urllib.parse.quote(status)}')
            if dataset is not None:
                extra.append(f'dataset={urllib.parse.quote(dataset)}')
            if extra:
                query = f'{query}&{"&".join(extra)}' if query else f'?{"&".join(extra)}'
            raw = await self._http.request_json(f'/api/datasets/imports{query}')
            items, next_cursor, has_more = _page_parts(raw)
            return DatasetImportPage(
                items=[_map_dataset_import(item) for item in items],
                next_cursor=next_cursor,
                has_more=has_more,
            )

        return _PaginatedList(
            fetch_page, lambda page: page.items, limit=limit, cursor=cursor
        )

    async def activate(self, name: str, version: str) -> Dataset:
        """Make a READY version the dataset's active version.

        Returns the full detail shape, exactly like :meth:`get`.
        """
        raw = await self._http.request_json(
            f'/api/datasets/{urllib.parse.quote(name)}'
            f'/versions/{urllib.parse.quote(version)}/activate',
            method='POST',
        )
        return _map_dataset_detail(raw)

    async def update(self, name: str, *, upstream_auto_import: bool) -> Dataset:
        """Update dataset settings; returns the updated dataset.

        The only settable field is ``upstream_auto_import``: automatically
        import a new version when the dataset's upstream git ref moves.
        Refused with ``upstream_not_watchable`` (409) when the dataset has no
        moving git ref to follow, and ``dataset_not_owned`` (403) on a
        platform-curated dataset — both typed errors, not silent no-ops.
        """
        raw = await self._http.request_json(
            f'/api/datasets/{urllib.parse.quote(name)}',
            method='PATCH',
            body={'upstream_auto_import': upstream_auto_import},
        )
        return _map_dataset_summary(raw)

    async def delete(self, name: str) -> None:
        """Delete a dataset you own, with every version, task, and archived solution.

        Refused (``dataset_in_use``) while any job still references it — a
        dataset is never deleted out from under a job that measured against
        it, and ``err.details['sampleJobIds']`` names the jobs blocking it. A
        platform dataset is refused with ``dataset_not_owned``; a name you
        cannot see is a plain not-found.
        """
        await self._http.request_json(
            f'/api/datasets/{urllib.parse.quote(name)}', method='DELETE'
        )


# =============================================================================
# AGENTS CLIENT (bring-your-own)
# =============================================================================

class AgentsClient:
    """Client for the caller's own private registered agents.

    Created via the standalone ``agents()`` factory. Register an agent once,
    then name it in job ``agents[].name`` exactly like a built-in. Requires
    ``EVOLVE_API_KEY`` unless ``HostedClientConfig(api_key=...)`` is given.

    Example::

        from evolve import agents, jobs, AgentArm

        async with agents() as registered:
            await registered.create(
                name='acme-cli',
                install_script='curl -fsSL https://acme.dev/install.sh | sh',
                run_command='acme-cli --headless',
            )

        async with jobs() as jobs_client:
            await jobs_client.start(
                datasets=[{'name': 'deep-swe'}],
                agents=[AgentArm(name='acme-cli', model_name='gpt-5.5')],
                max_trial_spend_usd=25,
            )
    """

    def __init__(self, config: Optional[HostedClientConfig] = None):
        self._http = _HostedHttp('agents', config)

    async def __aenter__(self) -> 'AgentsClient':
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        return None

    async def create(
        self,
        *,
        name: str,
        install_script: Optional[str] = None,
        directory: Optional[str] = None,
        run_command: str,
        env: Optional[Dict[str, str]] = None,
    ) -> Agent:
        """Register a private agent.

        Provide EITHER an ``install_script`` (the script itself, not a path) OR
        a local ``directory`` (tarred + gzipped deterministically on the client
        and uploaded), never both. Either one is built in a throwaway builder
        sandbox that has internet and ZERO secrets, so everything it fetches
        must be publicly fetchable, and it must leave executables in
        ``$PREFIX/bin``.

        ``run_command`` is run headless with ``sh -c`` at the task working
        directory. ``env`` is injected at RUN time only and may not override
        the run contract's own keys.
        """
        # ONE body grammar: multipart/form-data. The run command and the
        # declared env are named PARTS — they used to ride the query string of
        # an upload, which put a shell command and a set of environment values
        # into every access log and proxy buffer on the way here.
        body, content_type = _agent_upload_body(
            'create()',
            name=name,
            run_command=run_command,
            install_script=install_script,
            directory=directory,
            env=env,
        )
        raw = await self._http.request_upload(
            '/api/agents', body, {'Content-Type': content_type}
        )
        return _map_agent(raw)

    def list(
        self,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> _PaginatedList:
        """List the caller's registered agents (cursor-paged).

        ``await`` the result for one page, or ``async for`` it to walk them all.
        """
        async def fetch_page(page_limit, page_cursor) -> AgentPage:
            raw = await self._http.request_json(
                f'/api/agents{_page_query(page_limit, page_cursor)}'
            )
            items, next_cursor, has_more = _page_parts(raw)
            return AgentPage(
                items=[_map_agent(item) for item in items],
                next_cursor=next_cursor,
                has_more=has_more,
            )

        return _PaginatedList(
            fetch_page, lambda page: page.items, limit=limit, cursor=cursor
        )

    async def get(self, name: str) -> Agent:
        """Get one registered agent by name."""
        raw = await self._http.request_json(
            f'/api/agents/{urllib.parse.quote(name)}'
        )
        return _map_agent(raw)

    async def upsert(
        self,
        name: str,
        *,
        run_command: str,
        install_script: Optional[str] = None,
        directory: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> Agent:
        """Register or replace an agent in ONE call, under ``name``.

        Use this instead of ``delete()`` + ``create()`` to change an existing
        registration: the pair leaves a window where the agent does not exist,
        and anything naming it in that window fails for a change that was only
        ever meant to be an edit.

        This is a full REPLACEMENT, not a patch — every field comes from this
        call, and an omitted ``env`` becomes empty.
        """
        body, content_type = _agent_upload_body(
            'upsert()',
            name=name,
            run_command=run_command,
            install_script=install_script,
            directory=directory,
            env=env,
        )
        raw = await self._http.request_upload(
            f'/api/agents/{urllib.parse.quote(name)}',
            body,
            {'Content-Type': content_type},
            method='PUT',
        )
        return _map_agent(raw)

    async def delete(self, name: str) -> None:
        """Delete a registered agent. Past jobs keep their recorded agent."""
        # 204 No Content — nothing to map.
        await self._http.request_json(
            f'/api/agents/{urllib.parse.quote(name)}', method='DELETE'
        )


# =============================================================================
# SSE WATCH SUPPORT
# =============================================================================

class _SseConnection:
    """Holder for one open SSE response so the async side can close it."""

    def __init__(self):
        self.response = None

    def close(self) -> None:
        response = self.response
        if response is not None:
            try:
                response.close()
            except Exception:
                pass


def _parse_sse_data(text: str) -> Dict[str, Any]:
    if not text:
        return {}
    try:
        parsed = json.loads(text)
    except ValueError:
        return {'raw': text}
    return parsed if isinstance(parsed, dict) else {'value': parsed}


def _iter_sse_lines(response: Any) -> 'Iterator[str]':
    """Yield SSE lines honoring all three terminators the grammar names.

    The grammar ends a line on CRLF, LF, or a LONE CR. Iterating the response
    directly splits on LF only, so a CR-terminated stream arrived as one
    endless "line" and no event ever surfaced. Each LF-delimited read is
    therefore re-split on the CRs inside it: the trailing LF — and the CR
    paired with it, because CRLF is ONE terminator — is stripped first, so a
    plain blank line stays one blank line, then every interior CR ends a line
    of its own. A CR can never be orphaned across reads: the response yields
    up to and including each LF, so a CRLF pair always arrives together.
    """
    for raw_line in response:
        text = raw_line.decode('utf-8', errors='replace')
        if text.endswith('\n'):
            text = text[:-1]
            if text.endswith('\r'):
                text = text[:-1]
        yield from text.split('\r')


# =============================================================================
# JOBS CLIENT
# =============================================================================

class JobsClient:
    """Client for hosted jobs.

    Created via the standalone ``jobs()`` factory. Requires
    ``EVOLVE_API_KEY`` unless ``HostedClientConfig(api_key=...)`` is given.

    ``watch()`` is dual-use: ``await`` it for the final job (consuming the
    server-sent event stream — replay + live, Last-Event-ID resume on
    reconnect), or ``async for`` it to yield each :class:`JobEvent`.

    Example::

        from evolve import jobs, AgentArm

        async with jobs() as j:
            job = await j.start(
                datasets=[{'name': 'deep-swe', 'version': '1.1'}],
                agents=[AgentArm(name='codex', model_name='gpt-5.5')],
                max_trial_spend_usd=25,
            )
            final = await j.watch(job.id)
    """

    def __init__(self, config: Optional[HostedClientConfig] = None):
        self._http = _HostedHttp('jobs', config)

    async def __aenter__(self) -> 'JobsClient':
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        return None

    async def start(
        self,
        *,
        datasets: List[Union[DatasetSelector, Dict[str, Any]]],
        agents: List[Union[AgentArm, Dict[str, Any]]],
        job_name: Optional[str] = None,
        n_attempts: Optional[int] = None,
        n_concurrent_trials: Optional[int] = None,
        max_trial_spend_usd: Optional[float] = None,
        sandbox_provider: Optional[str] = None,
        agent_env: Optional[Dict[str, str]] = None,
        verifier_env: Optional[Dict[str, str]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Job:
        """Start a job over one or more catalog datasets.

        ``datasets`` is a LIST of selectors — :class:`DatasetSelector`
        instances or plain dicts with the same fields (``name``, optional
        ``version``, glob ``task_names`` / ``exclude_task_names``,
        ``n_tasks``); a bare name resolves server-side to the active version.
        ``agents`` accepts :class:`AgentArm` instances or plain dicts
        (``name``, ``model_name``, optional ``version`` and
        ``reasoning_effort``); every arm must name a model.
        ``max_trial_spend_usd`` caps EACH trial and is the platform's only
        spend enforcement; omitted, the server applies its own default ($200,
        operator-tunable). The response echoes the RESOLVED cap either way, so
        an omitted one is never invisible, and reports the resulting worst
        case for the whole job. ``agent_env`` / ``verifier_env`` are
        pass-through slots injected into every agent / verifier run — sent
        verbatim; the server owns acceptance (refused where unsupported,
        never silently dropped). Supports Idempotency-Key.
        """
        body: Dict[str, Any] = {}
        if job_name is not None:
            body['job_name'] = job_name
        body['datasets'] = [
            (item if isinstance(item, DatasetSelector) else DatasetSelector(**item))._to_wire()
            for item in datasets
        ]
        body['agents'] = [
            (agent if isinstance(agent, AgentArm) else AgentArm(**agent))._to_wire()
            for agent in agents
        ]
        if n_attempts is not None:
            body['n_attempts'] = n_attempts
        if n_concurrent_trials is not None:
            body['n_concurrent_trials'] = n_concurrent_trials
        if max_trial_spend_usd is not None:
            body['max_trial_spend_usd'] = max_trial_spend_usd
        if sandbox_provider is not None:
            body['sandbox_provider'] = sandbox_provider
        if agent_env is not None:
            body['agent_env'] = agent_env
        if verifier_env is not None:
            body['verifier_env'] = verifier_env
        headers = {'Idempotency-Key': idempotency_key} if idempotency_key else None
        raw = await self._http.request_json('/api/jobs', method='POST', body=body, headers=headers)
        return _map_job(raw)

    async def get(self, id: str) -> Job:
        """Get one job with agents + trial status counts."""
        raw = await self._http.request_json(f'/api/jobs/{urllib.parse.quote(id)}')
        return _map_job(raw)

    def list(
        self,
        *,
        search: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> _PaginatedList:
        """List the caller's jobs, newest first (cursor-paged).

        ``await`` the result for one page (honoring ``limit``/``cursor``), or
        ``async for`` it to walk every job across cursor pages. ``search`` is
        a server-side free-text filter over job name and dataset names, sent
        on every page fetch.
        """
        async def fetch_page(page_limit, page_cursor) -> JobPage:
            raw = await self._http.request_json(
                f'/api/jobs{_page_query(page_limit, page_cursor, search=search)}'
            )
            items, next_cursor, has_more = _page_parts(raw)
            return JobPage(
                items=[_map_job(item) for item in items],
                next_cursor=next_cursor,
                has_more=has_more,
            )

        return _PaginatedList(
            fetch_page, lambda page: page.items, limit=limit, cursor=cursor
        )

    def trials(
        self,
        id: str,
        *,
        status: Optional[List[str]] = None,
        dataset: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> _PaginatedList:
        """List a job's trials (cursor-paged).

        ``status`` filters to the given statuses (e.g. the failures behind a
        resume decision); ``dataset`` narrows to one dataset's trials (exact
        match on the trial's ``source``). ``await`` the result for one page
        (honoring ``limit``/``cursor``), or ``async for`` it to walk every
        trial across cursor pages.
        """
        async def fetch_page(page_limit, page_cursor) -> TrialPage:
            query = _page_query(
                page_limit,
                page_cursor,
                status=','.join(status) if status else None,
                dataset=dataset,
            )
            raw = await self._http.request_json(
                f'/api/jobs/{urllib.parse.quote(id)}/trials{query}'
            )
            items, next_cursor, has_more = _page_parts(raw)
            return TrialPage(
                items=[_map_trial(item) for item in items],
                next_cursor=next_cursor,
                has_more=has_more,
            )

        return _PaginatedList(
            fetch_page, lambda page: page.items, limit=limit, cursor=cursor
        )

    def tasks(
        self,
        id: str,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> _PaginatedList:
        """Per-task rollup of a job (cursor-paged).

        One row per distinct task: its trial-status histogram, mean reward
        over SCORED trials, and measured cost — the layer between the job
        body and the trial list, so a caller need not fetch every trial to
        see which tasks are dragging. ``await`` the result for one page, or
        ``async for`` it to walk every rollup across cursor pages.
        """
        async def fetch_page(page_limit, page_cursor) -> JobTaskRollupPage:
            raw = await self._http.request_json(
                f'/api/jobs/{urllib.parse.quote(id)}/tasks'
                f'{_page_query(page_limit, page_cursor)}'
            )
            items, next_cursor, has_more = _page_parts(raw)
            return JobTaskRollupPage(
                items=[_map_job_task_rollup(item) for item in items],
                next_cursor=next_cursor,
                has_more=has_more,
            )

        return _PaginatedList(
            fetch_page, lambda page: page.items, limit=limit, cursor=cursor
        )

    # ------------------------------------------------------------------ watch

    def _read_sse_sync(
        self,
        id: str,
        last_seq: Optional[int],
        loop: asyncio.AbstractEventLoop,
        queue: 'asyncio.Queue',
        connection: _SseConnection,
    ) -> None:
        """Blocking SSE reader (runs in a worker thread): pushes parsed events
        onto the asyncio queue. The server heartbeats every 15s, so
        SSE_SOCKET_TIMEOUT_SEC only trips on a genuinely dead connection."""

        def put(item: Any) -> None:
            loop.call_soon_threadsafe(queue.put_nowait, item)

        headers = {
            'Authorization': f'Bearer {self._http.api_key()}',
            'Accept': 'text/event-stream',
        }
        if last_seq is not None:
            headers['Last-Event-ID'] = str(last_seq)
        request = urllib.request.Request(
            f'{self._http.base_url()}/api/jobs/{urllib.parse.quote(id)}/events',
            headers=headers,
        )
        try:
            with _http.urlopen(request, timeout=SSE_SOCKET_TIMEOUT_SEC) as response:
                connection.response = response
                event_id: Optional[str] = None
                event_type: Optional[str] = None
                data_lines: List[str] = []
                # The SSE grammar names three line terminators: CRLF, LF, and a
                # LONE CR. Iterating the response splits on LF only, so a
                # CR-terminated stream arrived as one endless "line" and no
                # event ever surfaced. Each LF-delimited read is therefore
                # re-split on the CRs inside it: the trailing LF (and the CR
                # paired with it — CRLF is ONE terminator) is stripped first, so
                # a plain blank line stays one blank line, then every interior
                # CR ends a line of its own.
                for line in _iter_sse_lines(response):
                    if line == '':
                        if event_id is not None or event_type is not None or data_lines:
                            try:
                                seq = int(event_id) if event_id is not None else -1
                            except ValueError:
                                seq = -1
                            put(('event', JobEvent(
                                seq=seq,
                                type=event_type or 'message',
                                data=_parse_sse_data('\n'.join(data_lines)),
                            )))
                        event_id = None
                        event_type = None
                        data_lines = []
                        continue
                    if line.startswith(':'):
                        continue
                    fieldname, _, value = line.partition(':')
                    if value.startswith(' '):
                        value = value[1:]
                    if fieldname == 'id':
                        event_id = value
                    elif fieldname == 'event':
                        event_type = value
                    elif fieldname == 'data':
                        data_lines.append(value)
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode('utf-8', errors='replace')
            # The whole parsed envelope, not just (code, message): an error that
            # arrives over the event stream should be exactly as actionable as
            # one that arrives from a request, param and details included —
            # header-carried Retry-After included, on the same body-first law.
            parsed = _parse_error_body(detail, str(exc.reason))
            if parsed.get('retry_after_sec') is None:
                parsed['retry_after_sec'] = _header_retry_after_sec(
                    getattr(exc, 'headers', None)
                )
            put(('http_error', exc.code, parsed))
            return
        except Exception as exc:
            put(('error', exc))
            return
        put(('eof', None))

    async def _iter_events(
        self,
        id: str,
        *,
        timeout_s: Optional[float] = None,
        reconnect_delay_s: float = 1.0,
        max_reconnect_delay_s: float = 30.0,
    ) -> AsyncIterator[JobEvent]:
        """The one SSE loop both watch() forms drive.

        Replays from the beginning, resumes with Last-Event-ID on reconnect
        (exponential backoff), and completes on the terminal event
        (``job.completed`` / ``job.cancelled`` / ``job.failed``).
        """
        deadline = time.monotonic() + timeout_s if timeout_s is not None else None

        def remaining() -> Optional[float]:
            if deadline is None:
                return None
            left = deadline - time.monotonic()
            if left <= 0:
                raise TimeoutError(f'watch({id!r}) timed out after {timeout_s}s')
            return left

        last_seq: Optional[int] = None
        delay = reconnect_delay_s
        terminal = False
        final_drain_done = False

        while not terminal:
            remaining()
            loop = asyncio.get_running_loop()
            queue: 'asyncio.Queue' = asyncio.Queue()
            connection = _SseConnection()
            reader = asyncio.ensure_future(
                asyncio.to_thread(self._read_sse_sync, id, last_seq, loop, queue, connection)
            )
            received_event = False
            reconnect = False
            retry_after: Optional[float] = None
            try:
                while True:
                    left = remaining()
                    item = (
                        await asyncio.wait_for(queue.get(), timeout=left)
                        if left is not None
                        else await queue.get()
                    )
                    kind = item[0]
                    if kind == 'event':
                        event: JobEvent = item[1]
                        if event.seq >= 0:
                            last_seq = event.seq
                        received_event = True
                        if event.type in _TERMINAL_EVENT_TYPES:
                            terminal = True
                        yield event
                        if terminal:
                            break
                    elif kind == 'http_error':
                        status, parsed = item[1], item[2]
                        if status == 429 or status >= 500:
                            # The server's own delay outranks the local backoff
                            # guess — discarding it retried a rate limit far
                            # sooner than the door asked for.
                            retry_after = parsed.get('retry_after_sec')
                            reconnect = True
                            break
                        raise EvolveAPIError(
                            status,
                            parsed['code'],
                            parsed['message'],
                            param=parsed.get('param'),
                            details=parsed.get('details'),
                            retry_after_sec=parsed.get('retry_after_sec'),
                            request_id=parsed.get('request_id'),
                        )
                    elif kind == 'error':
                        reconnect = True
                        break
                    else:  # eof
                        break
            finally:
                connection.close()
                try:
                    await reader
                except Exception:
                    pass

            if terminal:
                return

            if not reconnect:
                # The stream closed cleanly without a terminal event (server
                # drain fallback). Events may still be in flight just after
                # the status turns terminal, so drain once more from last_seq
                # before finishing on status alone.
                current = await self.get(id)
                if current.status in _TERMINAL_JOB_STATUSES:
                    if final_drain_done:
                        return
                    final_drain_done = True
                    continue

            if received_event:
                delay = reconnect_delay_s
            wait = max(retry_after, delay) if retry_after else delay
            await asyncio.sleep(min(wait, remaining() or wait))
            delay = min(delay * 2, max_reconnect_delay_s)

    def watch(
        self,
        id: str,
        *,
        on_event: Optional[Callable[[JobEvent], None]] = None,
        timeout_s: Optional[float] = None,
        reconnect_delay_s: float = 1.0,
        max_reconnect_delay_s: float = 30.0,
    ) -> _JobWatch:
        """Watch the job's event stream. Dual-use: await it, or iterate it.

        ``await`` resolves the final :class:`Job` once the terminal event
        arrives, firing ``on_event`` for each event on the way. ``async for``
        yields each :class:`JobEvent` instead. One method covers both,
        matching the TypeScript SDK's ``jobs().watch()``.

        Either form consumes the same stream (replay + live, Last-Event-ID
        resume with exponential backoff), so use one form per handle.

        Example::

            job = await j.watch(job_id)                  # final job
            async for event in j.watch(job_id):          # each event
                print(event.seq, event.type)
        """
        def events() -> AsyncIterator[JobEvent]:
            return self._watch_events(
                id,
                on_event=on_event,
                timeout_s=timeout_s,
                reconnect_delay_s=reconnect_delay_s,
                max_reconnect_delay_s=max_reconnect_delay_s,
            )

        async def final() -> Job:
            async for _ in events():
                pass
            return await self.get(id)

        return _JobWatch(events, final)

    async def _watch_events(
        self,
        id: str,
        *,
        on_event: Optional[Callable[[JobEvent], None]] = None,
        timeout_s: Optional[float] = None,
        reconnect_delay_s: float = 1.0,
        max_reconnect_delay_s: float = 30.0,
    ) -> AsyncIterator[JobEvent]:
        """The one stream both watch() forms drive; fires on_event as it goes."""
        async for event in self._iter_events(
            id,
            timeout_s=timeout_s,
            reconnect_delay_s=reconnect_delay_s,
            max_reconnect_delay_s=max_reconnect_delay_s,
        ):
            if on_event is not None:
                on_event(event)
            yield event

    # ---------------------------------------------------------------- actions

    async def cancel(self, id: str) -> Job:
        """Request cancellation. Idempotent; a terminal job is a no-op."""
        raw = await self._http.request_json(
            f'/api/jobs/{urllib.parse.quote(id)}/cancel', method='POST', body={}
        )
        return _map_job(raw)

    async def resume(
        self,
        id: str,
        *,
        filter_error_types: Optional[List[str]] = None,
        idempotency_key: Optional[str] = None,
    ) -> Job:
        """Resume a terminal job: a NEW linked job over its failed and
        stopped trials.

        ``source_jobs`` on the new job records ``action="resume"``; the source
        is never mutated. ``filter_error_types`` selects which failures to
        resume by their ``exception_info.exception_type``; omitted, the server
        default set applies (ScoringError, InfrastructureError,
        IncompleteTrialError, plus stopped trials — settled CANCELLED,
        exception type CancelledError — and still-QUEUED trials of a
        cancelled source). Supports Idempotency-Key.
        """
        body: Dict[str, Any] = {}
        if filter_error_types is not None:
            body['filter_error_types'] = filter_error_types
        headers = {'Idempotency-Key': idempotency_key} if idempotency_key else None
        raw = await self._http.request_json(
            f'/api/jobs/{urllib.parse.quote(id)}/resume',
            method='POST',
            body=body,
            headers=headers,
        )
        return _map_job(raw)

    async def regrade(
        self,
        id: str,
        *,
        statuses: Optional[List[str]] = None,
        task_name: Optional[str] = None,
    ) -> Job:
        """Regrade a terminal job: re-run the verifier of every REGRADABLE
        trial against its recorded inputs, in fresh separate verifier boxes.

        The agent phase is never re-run and the source trials are never
        modified. THE RESPONSE IS A JOB — a regrade is an ordinary job whose
        ``source_jobs`` records ``action="regrade"`` and whose ``is_regrade``
        is true; view it with :meth:`get`. ``statuses`` / ``task_name`` narrow
        the set of source trials.
        """
        body: Dict[str, Any] = {}
        if statuses is not None:
            body['statuses'] = statuses
        if task_name is not None:
            body['task_name'] = task_name
        raw = await self._http.request_json(
            f'/api/jobs/{urllib.parse.quote(id)}/regrade', method='POST', body=body
        )
        return _map_job(raw)

    async def download(
        self,
        id: str,
        *,
        to: Optional[str] = None,
    ):
        """Download a terminal job's results archive (gzipped, standard
        results layout, deterministic bytes).

        Returns the archive bytes — verified against the response's
        Content-Length and, when the server states one, its digest — or, when
        ``to`` (a directory) is given, streams straight to disk
        (temp-then-rename, same verification) and returns the saved file path.

        Two delivery shapes where the TypeScript SDK has three: no stream
        shape, deliberately. The HTTP layer is urllib inside a worker thread,
        so an async chunk iterator would be a thread hop per chunk handing out
        bytes no one has verified — while ``to=`` already streams in constant
        memory and promotes the file only after the digest check. Pipe from
        the file.
        """
        path = f'/api/jobs/{urllib.parse.quote(id)}/download'
        if to is not None:
            return await self._http.download(path, to, f'job-{id}-results.tar.gz')
        payload, headers = await self._http.request_bytes(path)
        declared = headers.get('Content-Length')
        if declared is not None and len(payload) != int(declared):
            raise EvolveIncompleteDownloadError(int(declared), len(payload))
        expected = headers.get(PACKAGE_DIGEST_HEADER)
        if expected:
            actual = hashlib.sha256(payload).hexdigest()
            if actual != expected:
                raise EvolveDigestMismatchError(expected, actual)
        return payload

    async def compare(self, ids: List[str]) -> CompareResponse:
        """Side-by-side comparison of 2-10 owned jobs.

        Per-job aggregates plus a per-task matrix with disagreement
        rows first. Means cover SCORED trials only; coverage is always reported.
        """
        query = ','.join(urllib.parse.quote(item) for item in ids)
        raw = await self._http.request_json(f'/api/jobs/compare?ids={query}')
        return CompareResponse(
            jobs=[
                _map_compare_aggregate(item) for item in raw.get('jobs', [])
            ],
            task_matrix=[
                _map_compare_task_row(item) for item in raw.get('taskMatrix', [])
            ],
        )


# =============================================================================
# TRIALS CLIENT (globally addressable)
# =============================================================================

class TrialsClient:
    """Client for globally addressable trials — no method here takes a job id;
    the trial body carries ``job_id`` as the reverse pointer.

    Created via the standalone ``trials()`` factory. Requires
    ``EVOLVE_API_KEY`` unless ``HostedClientConfig(api_key=...)`` is given.
    """

    def __init__(self, config: Optional[HostedClientConfig] = None):
        self._http = _HostedHttp('trials', config)

    async def __aenter__(self) -> 'TrialsClient':
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        return None

    async def get(self, trial_id: str) -> Trial:
        """Get one trial by its globally addressable id.

        Same shape as a list row; unlike list rows,
        ``exception_info.exception_message`` is untruncated here.
        """
        raw = await self._http.request_json(
            f'/api/trials/{urllib.parse.quote(trial_id)}'
        )
        return _map_trial(raw)

    async def trace(
        self,
        trial_id: str,
        *,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> TraceEventPage:
        """Get one page of a trial's trace.

        ``cursor`` returns events with seq strictly greater than it (omit =
        from the beginning); resume with ``cursor=page.next_cursor``. A None
        ``next_cursor`` means CAUGHT UP — to resume a poll later, keep the last
        event's ``seq`` and pass it as ``cursor``.
        """
        raw = await self._http.request_json(
            f'/api/trials/{urllib.parse.quote(trial_id)}/trace'
            f'{_page_query(limit, cursor)}'
        )
        items, next_cursor, has_more = _page_parts(raw)
        return TraceEventPage(
            items=[_map_trace_event(item) for item in items],
            next_cursor=next_cursor,
            has_more=has_more,
        )

    async def trace_events(
        self,
        trial_id: str,
        *,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ):
        """Iterate a trial's trace events, fetching pages under the hood.

        Drains the currently available trace, then stops: ``next_cursor`` is
        None when there is no next page, which says "caught up" rather than
        echoing the position back. Resume later by passing the last seen seq as
        ``cursor``.
        """
        position = cursor
        while True:
            page = await self.trace(trial_id, cursor=position, limit=limit)
            for event in page.items:
                yield event
            if not page.next_cursor:
                return
            position = page.next_cursor

    async def artifact(
        self,
        trial_id: str,
        stream: Literal['trace-parsed', 'verifier', 'trace-stdout', 'trace-stderr', 'trajectory', 'agent-home'],
    ) -> Optional[Union[str, Dict[str, str]]]:
        """One raw trace artifact for a trial, by the trace route's ``?stream=``
        selector.

        ``"verifier"`` / ``"trace-stdout"`` / ``"trace-stderr"`` answer the log
        text; ``"agent-home"`` (the CLI's whole home folder, subagent
        transcripts included by construction) answers a dict of sandbox path to
        text. None = never stored (normal answer, not an error): a
        QUEUED/CANCELLED trial, a harness that wrote nothing, or a purged
        trace. ``"trajectory"`` is in the vocabulary ahead of its server wave —
        until that wave lands the route answers not-found, reported honestly as
        the API error it is. ``"trace-parsed"`` is in the vocabulary but is not
        a raw artifact — the parsed event trace rides ``trace()`` /
        ``trace_events()``, and passing it here is refused with that guidance.
        """
        if stream == 'trace-parsed':
            raise ValueError(
                "'trace-parsed' is the parsed event trace — use trace() / trace_events(), "
                'not artifact()'
            )
        raw = await self._http.request_json(
            f'/api/trials/{urllib.parse.quote(trial_id)}/trace?stream={stream}'
        )
        return raw.get('files') if stream == 'agent-home' else raw.get('log')

    async def regrade(self, trial_id: str) -> Job:
        """Regrade one settled trial: re-run its verifier against its recorded
        inputs in a fresh separate verifier box.

        Refused (``regrade_source_ineligible``) for shared-mode or
        pre-persistence trials. THE RESPONSE IS A JOB — a one-trial regrade job
        with ``source_jobs`` recording the provenance.
        """
        raw = await self._http.request_json(
            f'/api/trials/{urllib.parse.quote(trial_id)}/regrade',
            method='POST',
            body={},
        )
        return _map_job(raw)

    async def stop(self, trial_ids: List[str]) -> StopResponse:
        """Stop selected in-flight trials without cancelling their job.

        Each trial's sandbox is killed and the trial is settled with its spend
        read from the gateway. Only the caller's own trials; ids belonging to
        someone else are reported in ``not_found`` (existence is never leaked).
        Idempotent — already-terminal trials are reported as such and left
        untouched.
        """
        raw = await self._http.request_json(
            '/api/trials/stop', method='POST', body={'trial_ids': trial_ids}
        )
        stopped = raw.get('stopped')
        return StopResponse(
            stopped=(
                [_map_trial(item) for item in stopped]
                if isinstance(stopped, list)
                else []
            ),
            already_terminal=raw.get('already_terminal') or [],
            not_found=raw.get('not_found') or [],
        )


# =============================================================================
# AUTH CLIENT
# =============================================================================

class AuthClient:
    """Client for caller identity.

    Created via the standalone ``auth()`` factory. Requires
    ``EVOLVE_API_KEY`` unless ``HostedClientConfig(api_key=...)`` is given.
    """

    def __init__(self, config: Optional[HostedClientConfig] = None):
        self._http = _HostedHttp('auth', config)

    async def __aenter__(self) -> 'AuthClient':
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        return None

    async def status(self) -> AuthStatus:
        """Identify the caller and the API key in use."""
        raw = await self._http.request_json('/api/auth/status')
        return _map_auth_status(raw)


def _parse_dataset_ref(ref: str) -> 'tuple[str, Optional[str]]':
    at = ref.find('@')
    if at == -1:
        return ref.strip(), None
    name = ref[:at].strip()
    version = ref[at + 1:].strip()
    if not name or not version:
        raise ValueError(f'Invalid dataset ref "{ref}": expected "name" or "name@version"')
    return name, version


# =============================================================================
# FRONT DOOR
# =============================================================================

class HostedEvolve:
    """The hosted surface, configured once.

    The four clients are the right decomposition — a dataset catalog, your own
    agent registrations, jobs, and globally addressable trials are genuinely
    different lifetimes — but they made you say the same thing four times::

        d = datasets(config)
        a = agents(config)     # again
        j = jobs(config)       # and again

    and any one of those drifting out of sync with the others is a bug that
    looks like a permissions problem. One door, one config::

        from evolve import hosted

        client = hosted()
        catalog = await client.datasets.list()
        job = await client.jobs.start(datasets=[...], agents=[...])

    The clients are built LAZILY, on first access. That matters because they
    raise when no API key is present, and :meth:`meta` needs no key at all —
    so ``await hosted().meta()`` works with no credentials configured, while
    ``hosted().jobs`` still fails loudly the moment you reach for something
    that does need them.
    """

    def __init__(self, config: Optional[HostedClientConfig] = None):
        self._config = config
        self._datasets: Optional[DatasetsClient] = None
        self._agents: Optional[AgentsClient] = None
        self._jobs: Optional[JobsClient] = None
        self._trials: Optional[TrialsClient] = None

    @property
    def datasets(self) -> DatasetsClient:
        """The dataset catalog: list, get, publish, download, delete."""
        if self._datasets is None:
            self._datasets = DatasetsClient(self._config)
        return self._datasets

    @property
    def agents(self) -> AgentsClient:
        """Your own bring-your-own agent registrations."""
        if self._agents is None:
            self._agents = AgentsClient(self._config)
        return self._agents

    @property
    def jobs(self) -> JobsClient:
        """Jobs: start, watch, compare, resume, regrade, download."""
        if self._jobs is None:
            self._jobs = JobsClient(self._config)
        return self._jobs

    @property
    def trials(self) -> TrialsClient:
        """Globally addressable trials: get, trace, artifact, regrade, stop."""
        if self._trials is None:
            self._trials = TrialsClient(self._config)
        return self._trials

    async def meta(self) -> CapabilityDocument:
        """The capability document. Public: no API key required.

        Fetch it once and stop hardcoding. It is what tells you the legal
        agent names without having to send a bad one and read the 400.
        """
        return await meta(self._config)

    async def __aenter__(self) -> 'HostedEvolve':
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        for client in (self._datasets, self._agents, self._jobs, self._trials):
            if client is not None:
                await client.close()


async def meta(config: Optional[HostedClientConfig] = None) -> CapabilityDocument:
    """Fetch the capability document.

    NO API KEY. The document is the same information the docs publish, and
    requiring credentials would mean a signed-out page could not populate its
    own agent picker — so this is the one hosted call that takes only a base
    URL.
    """
    resolved = config or HostedClientConfig()
    base_url = (
        resolved.base_url
        or os.environ.get('EVOLVE_DASHBOARD_URL')
        or DEFAULT_BASE_URL
    ).rstrip('/')

    def fetch() -> Dict[str, Any]:
        request = urllib.request.Request(
            f'{base_url}/api/meta', headers={'Accept': 'application/json'}
        )
        try:
            with _http.urlopen(request, timeout=META_TIMEOUT_SEC) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as exc:
            _raise_api_error(exc)

    return _map_capability_document(await asyncio.to_thread(fetch))
