"""Hosted evals clients: standalone benchmarks() and jobs().

Direct-HTTP clients against the dashboard API (same pattern as
browser_credentials.py — no Node bridge). Mirrors the TypeScript SDK's hosted
module 1-1: ``watch()`` consumes the server-sent event stream (replay from the
beginning, Last-Event-ID resume on reconnect, terminal-event completion), and
``watch_iter()`` is its async-iterator sibling yielding each
:class:`JobEvent`.

API failures raise :class:`EvolveAPIError` — the server's product sentence as
the message plus the stable machine-readable ``code``.
"""

import asyncio
import gzip
import io
import json
import os
import re
import shutil
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Callable, Dict, List, Literal, Optional, Union

from .config import HostedClientConfig

DEFAULT_BASE_URL = 'https://dashboard.evolvingmachines.ai'

_TERMINAL_JOB_STATUSES = {'COMPLETED', 'CANCELLED', 'FAILED'}

# Terminal import job statuses.
_TERMINAL_IMPORT_STATUSES = {'COMPLETED', 'FAILED'}

# Seeing one of these on the wire is the authoritative end-of-stream signal.
_TERMINAL_EVENT_TYPES = {'job.completed', 'job.cancelled', 'job.failed'}

# camelCase -> snake_case boundary (only between a lower/digit and an upper,
# so all-caps status keys are never mangled).
_CAMEL_BOUNDARY = re.compile(r'(?<=[a-z0-9])(?=[A-Z])')


def _snake_key(key: str) -> str:
    return _CAMEL_BOUNDARY.sub('_', key).lower()


def _snake_keys(data: Any) -> Optional[Dict[str, Any]]:
    """Map a wire dict's camelCase keys to snake_case (None passes through)."""
    if not isinstance(data, dict):
        return None
    return {_snake_key(key): value for key, value in data.items()}


#: Every error code the hosted API can return, as a closed list.
#:
#: This exists so a typo is catchable rather than silently never matching:
#: ``err.code == "insufficient_creidts"`` is a branch that looks handled and
#: never runs. Type-check against :data:`HostedErrorCode`, or guard at runtime
#: with :func:`is_hosted_error_code`.
#:
#: Mirrors HOSTED_API_ERROR_CODES on the server and the TypeScript SDK's
#: HOSTED_ERROR_CODES, and is published verbatim at ``GET /api/meta`` as
#: ``errorCodes``. A server newer than this SDK may send a code that is not
#: listed here, so ``EvolveAPIError.code`` stays a plain ``str``.
HOSTED_ERROR_CODES: 'tuple[str, ...]' = (
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
    'benchmark_not_found',
    'benchmark_version_not_found',
    'benchmark_name_taken',
    'benchmark_in_use',
    'benchmark_not_owned',
    'no_active_version',
    'version_not_ready',
    'unknown_task_keys',
    'no_tasks',
    'custom_harness_not_found',
    'custom_harness_name_taken',
    'custom_harness_name_reserved',
    'custom_harness_invalid_name',
    'custom_harness_source_required',
    'custom_harness_source_conflict',
    'custom_harness_invalid_env',
    'custom_harness_too_large',
    'custom_harness_limit_reached',
    'harness_version_not_found',
    'job_too_large',
    'provider_unsupported',
    'job_not_found',
    'job_not_terminal',
    'no_failed_runs',
    'trial_not_found',
    'concurrent_update',
    'regrade_source_ineligible',
    'no_regradable_runs',
    'regrade_not_found',
    'import_not_found',
    'import_too_large',
    'invalid_archive',
    'internal_error',
)

#: One of the API's stable error codes. Use it in annotations to make a typo a
#: type error: ``def handle(code: HostedErrorCode) -> None: ...``
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
    'benchmark_not_found',
    'benchmark_version_not_found',
    'benchmark_name_taken',
    'benchmark_in_use',
    'benchmark_not_owned',
    'no_active_version',
    'version_not_ready',
    'unknown_task_keys',
    'no_tasks',
    'custom_harness_not_found',
    'custom_harness_name_taken',
    'custom_harness_name_reserved',
    'custom_harness_invalid_name',
    'custom_harness_source_required',
    'custom_harness_source_conflict',
    'custom_harness_invalid_env',
    'custom_harness_too_large',
    'custom_harness_limit_reached',
    'harness_version_not_found',
    'job_too_large',
    'provider_unsupported',
    'job_not_found',
    'job_not_terminal',
    'no_failed_runs',
    'trial_not_found',
    'concurrent_update',
    'regrade_source_ineligible',
    'no_regradable_runs',
    'regrade_not_found',
    'import_not_found',
    'import_too_large',
    'invalid_archive',
    'internal_error',
]


def is_hosted_error_code(value: Any) -> bool:
    """True when ``value`` is a code this SDK version knows about."""
    return isinstance(value, str) and value in HOSTED_ERROR_CODES


class EvolveAPIError(Exception):
    """A typed failure from the hosted evals API.

    ``message`` (``str(error)``) is the server's own product sentence; ``code``
    is the stable machine-readable identifier (e.g. ``benchmark_not_found``,
    ``version_not_ready``, ``provider_unsupported``, ``rate_limited``) so
    callers branch on codes, never on English. ``status`` is the HTTP status.

    ``param`` and ``details`` are the machine-readable half of the refusal::

        try:
            await jobs().run(...)
        except EvolveAPIError as err:
            if err.code == 'provider_unsupported':
                # every refused task WITH its reason — not a sentence to regex
                refused = (err.details or {}).get('refusedTasks', [])

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
        #: ("agents[0].harness"), a query parameter ("limit"), or a multipart
        #: part name ("runCommand"). None when it is not about one field.
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
    """Raised by ``benchmarks().get_active()`` when the benchmark has no active version.

    The benchmark exists but no version is active, so there is no runnable
    version to resolve. Use ``get()`` to inspect a benchmark that may not have
    an active version yet.
    """

    def __init__(self, name: str):
        super().__init__(f'Benchmark {name!r} has no active version')
        self.benchmark = name


# =============================================================================
# PUBLIC TYPES
# =============================================================================

@dataclass
class BenchmarkVersion:
    """One immutable version of a benchmark — one shape on every surface."""
    version: str
    state: str
    created_at: str
    task_count: int


@dataclass
class TaskProviderVerdict:
    """One provider's verdict for a task: runnable (ok), or refused with the limitation named."""
    ok: bool
    reason: Optional[str] = None


@dataclass
class Task:
    """Public task fields only — instructions/environments/tests never leave the server.

    ``providers`` maps each sandbox provider to a :class:`TaskProviderVerdict`.
    Advisory for choosing a job's provider — creating a job
    whose tasks include one refused on the chosen provider is rejected with
    the same reason, so nothing is ever spent on a trial that cannot execute.
    """
    task_key: str
    agent_timeout_sec: int
    verifier_timeout_sec: int
    providers: Dict[str, TaskProviderVerdict]


@dataclass
class TaskPage:
    """One page of a benchmark version's tasks — paged like every collection,
    because a SWE-bench-scale benchmark has thousands of them."""
    items: List[Task]
    next_cursor: Optional[str]
    has_more: bool


@dataclass
class UpstreamStatus:
    """Where a benchmark's git source points now, versus what its active
    version was built from — the data behind a "new version available" badge.

    Nothing here imports anything. A new version is always a row you create.
    """
    #: The ref the active version was imported from.
    ref: str
    #: The commit the active version was built from.
    current_commit: str
    #: Where the ref points upstream now; None when the last check failed.
    latest_commit: Optional[str]
    #: True when upstream has moved off the built-from commit. Branch on this.
    moved: bool
    #: Always None today. Counting commits between two SHAs needs the commit
    #: graph, i.e. a real fetch per benchmark per check; the watcher deliberately
    #: only does a reference advertisement. Reserved so a host comparison API
    #: could fill it later without a wire change.
    behind_by: Optional[int]
    #: When the cached answer was taken; None before the first check.
    checked_at: Optional[str]
    #: Why the last check failed. Show "could not check", not "up to date".
    error: Optional[str]


@dataclass
class Benchmark:
    """A benchmark in the shared catalog.

    list() returns the summary fields; get() additionally populates versions,
    selected_version, tasks, created_at, and updated_at.
    """
    name: str
    title: Optional[str]
    description: Optional[str]
    active_version: Optional[BenchmarkVersion]
    #: Where this benchmark's git source points now versus what its active
    #: version was built from. None when there is nothing to watch (an uploaded
    #: corpus, a seeded one, or one imported before provenance was recorded);
    #: None is never "up to date".
    upstream: Optional[UpstreamStatus] = None
    versions: Optional[List[BenchmarkVersion]] = None
    # The version whose tasks are listed (get() only)
    selected_version: Optional[BenchmarkVersion] = None
    # One page of the selected version's tasks (get() only); pass limit=/cursor=
    # to get() and follow next_cursor.
    tasks: Optional[TaskPage] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


@dataclass
class StatusVocabulary:
    """A closed vocabulary a client renders, with the members that end it."""
    values: List[str]
    #: Members after which nothing more happens — a watcher may stop here.
    terminal: List[str]
    description: str


@dataclass
class HarnessModel:
    """One model a harness can drive."""
    alias: str
    model_id: str
    description: Optional[str]


@dataclass
class HarnessCapability:
    """One harness the platform can run."""
    name: str
    #: False = registered but not runnable; ``reason`` says why.
    runnable: bool
    reason: Optional[str]
    #: What the local SDK would run if no model were named. The hosted API
    #: always requires an explicit model, so this is a picker's pre-selection,
    #: not a server-side default.
    default_model: Optional[str]
    models: List[HarnessModel]
    #: Whether ``agents[].harness_version`` may pin this harness.
    version_pinnable: bool
    #: Newest published version, for a "your pin is out of date" badge. None
    #: means "not known right now", never "up to date".
    latest_version: Optional[str]


@dataclass
class ProviderCapability:
    """One sandbox provider, its ceilings, and what it refuses."""
    name: str
    default: bool
    sizing: Dict[str, Any]
    refuses: List[Dict[str, str]]


@dataclass
class CapabilityDocument:
    """Everything a client would otherwise hardcode, in one public document.

    Fetch it with :func:`evolve.meta` (no API key required) and stop guessing
    at harness names, status enums, limits, and error codes.

    ``custom_harnesses``, ``limits`` and ``statuses`` are handed through as
    plain dicts with the wire's own camelCase keys. They are nested
    configuration a client reads by key, not objects it constructs, and a
    dataclass per level would be five classes that must be edited every time
    the server adds a field — the exact coupling this document exists to remove.
    """
    schema_version: int
    harnesses: List[HarnessCapability]
    custom_harnesses: Dict[str, Any]
    sandbox_providers: List[ProviderCapability]
    #: Constraints that hold on EVERY provider.
    platform_constraints: List[Dict[str, str]]
    network_modes: List[str]
    statuses: Dict[str, StatusVocabulary]
    limits: Dict[str, Any]
    error_codes: List[str]


@dataclass
class ActiveBenchmark:
    """A benchmark's active version resolved to a runnable shape.

    Unlike :class:`Benchmark`, ``version`` and ``tasks`` are non-optional:
    ``get_active()`` raises :class:`NoActiveVersionError` when there is no
    active version, so callers never branch on a missing active version.
    """
    name: str
    title: Optional[str]
    description: Optional[str]
    active_version: BenchmarkVersion
    version: str
    tasks: TaskPage
    versions: List[BenchmarkVersion]
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


@dataclass
class JobAgent:
    """One agent: harness + model (+ optional pinned harness version).

    ``harness`` is a built-in ("claude", "codex", ...) or a registered custom
    harness name. ``harness_version`` omitted (or None) resolves the latest at
    dispatch time; the version that actually ran is recorded on every trial
    as ``resolved_harness_version``. Rejected at creation when the pin is not an
    exact version (``invalid_input``), when the version is not published
    (``harness_version_not_found``), or when the harness is a custom one — those
    are versioned by the content of their own source (``invalid_input``).
    """
    harness: str
    model: str
    harness_version: Optional[str] = None

    def _to_wire(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {'harness': self.harness, 'model': self.model}
        if self.harness_version is not None:
            result['harnessVersion'] = self.harness_version
        return result


@dataclass
class JobCounts:
    """Entity cardinality only — the parts of a job with no status of their own."""
    agents: int
    tasks: int


@dataclass
class TrialTally:
    """How many trials there are, and how they break down by status.

    ``by_status`` names EVERY trial status, zeros included, so a status bar can
    be drawn straight off the response without hardcoding the enum.
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
    """A job = tasks x agents x runs_per_task.

    ONE shape from every call — run, get, cancel, rerun_failed and each list
    row are the same fields, so a job card renders from any of them without
    knowing where it came from. Nothing here is optional.
    """
    id: str
    status: str
    # "name@version"
    benchmark: str
    agents: List[JobAgent]
    runs_per_task: int
    concurrency: int
    #: The resolved per-trial cap every trial of this job runs under.
    max_trial_spend_usd: float
    #: The most this job can cost: trials x the per-trial cap. There is no
    #: job-wide budget, so this product is the real ceiling.
    worst_case_spend_usd: float
    #: Sandbox provider this job runs on ("e2b" | "daytona" | "modal").
    sandbox_provider: str
    #: What the trials have actually spent so far (reporting, not a limit).
    spent_usd: float
    counts: JobCounts
    #: How many trials, and the status histogram (all statuses, zeros included).
    trials: TrialTally
    #: Mean reward over SCORED trials only; None when none. Zero is a reward.
    mean_reward: Optional[float]
    #: Why the job FAILED, or None.
    failure: Optional[JobFailure]
    #: The job whose failed trials this one reruns; None for an original job.
    source_job_id: Optional[str]
    #: True when the server replayed an existing job for this Idempotency-Key.
    idempotent_replay: bool
    created_at: str
    updated_at: str


@dataclass
class ModelUsage:
    """Model usage/spend recorded for a trial — purely spend/usage, in the
    one money vocabulary (the cap is max_trial_spend_usd, actuals are
    spent_usd).

    ``spend_source`` is "measured" (measured model spend reported by the
    platform) or "assumed_cap" (spend could not be measured for this trial, so
    the per-trial cap is reported). Harness-specific keys land in ``extra``
    with snake_case keys.
    """
    spent_usd: Optional[float] = None
    spend_source: Optional[str] = None
    # The per-trial model-spend cap that applied to this trial
    max_trial_spend_usd: Optional[float] = None
    extra: Dict[str, Any] = field(default_factory=dict)


@dataclass
class Trial:
    """One task x one agent x one run_number (1-based)."""
    id: str
    task_key: str
    agent: JobAgent
    run_number: int
    status: str
    reward: Optional[float]
    metrics: Optional[Dict[str, float]]
    failure_phase: Optional[str]
    failure_detail: Optional[str]
    # Wall-clock per phase with snake_case keys, e.g. {"agent_ms", "verify_ms"}
    phase_timings_ms: Optional[Dict[str, float]]
    model_usage: Optional[ModelUsage]
    # Sandbox provider the trial executed on; None until it has executed
    sandbox_provider: Optional[str]
    # Where the verifier ran ("separate" pristine box | "shared" inside the
    # agent box); None until recorded
    verifier_mode: Optional[str]
    # Harness version actually resolved and used for the trial; None until resolved
    resolved_harness_version: Optional[str]
    session_ref: Optional[str]
    created_at: str
    updated_at: str


@dataclass
class TrialDetail(Trial):
    """Full detail of one trial — jobs().trial(id, trial_id).

    Same shape as a list row, plus the owning job; unlike list rows,
    failure_detail is untruncated here.
    """
    job_id: str


@dataclass
class JobEvent:
    """One server-sent event from jobs().watch()/watch_iter()."""
    # Monotonic sequence number (SSE id; the Last-Event-ID resume position)
    seq: int
    # Event type, e.g. "job.created", "trial.settled", "job.completed"
    type: str
    data: Dict[str, Any]


@dataclass
class TrialTraceEvent:
    """One trace event of a trial (seq-ordered timeline)."""
    seq: int
    type: str
    data: Dict[str, Any]


@dataclass
class TrialTracePage:
    """One page of a trial's trace — jobs().trial_trace().

    Same envelope as every other collection, and ``next_cursor`` means the same
    thing: pass it back as ``cursor=`` for the next page, and NONE MEANS CAUGHT
    UP. To resume a poll later, keep the last event's ``seq`` and pass it as
    ``cursor`` — a trace cursor IS a position in the seq timeline.
    """
    items: List[TrialTraceEvent]
    next_cursor: Optional[str]
    has_more: bool


@dataclass
class ComparisonCoverage:
    """Scored-trial coverage behind an aggregate (means cover SCORED trials only)."""
    scored: int
    total: int


@dataclass
class ComparisonCell:
    """One (task_key x job) cell of the compare matrix.

    status is the shared Trial status when the cell's trials agree, "MIXED"
    when they differ, and "MISSING" when the job has no trials for the task.
    """
    job_id: str
    status: str
    # Mean reward over the cell's SCORED trials; None when none. Zero is a reward.
    mean_reward: Optional[float]
    coverage: ComparisonCoverage


@dataclass
class ComparisonTaskRow:
    """One matrix row of jobs().compare(): a task across the compared jobs."""
    task_key: str
    # True when the jobs' cells differ in status or reward for this task
    disagreement: bool
    # Cells in the caller's job-id order
    cells: List[ComparisonCell]


@dataclass
class ComparisonAggregate:
    """Per-job aggregate of jobs().compare()."""
    id: str
    benchmark: str
    status: str
    # Mean reward over SCORED trials only; None when none. Zero is a reward.
    mean_reward: Optional[float]
    coverage: ComparisonCoverage
    spent_usd: float
    agents: List[JobAgent]
    created_at: str


@dataclass
class JobComparison:
    """Result of jobs().compare([ids]): aggregates + per-task matrix."""
    # Aggregates in the caller's id order
    jobs: List[ComparisonAggregate]
    # Per-task matrix, disagreement rows first
    task_matrix: List[ComparisonTaskRow]


@dataclass
class RegradeResult:
    """One regrade of one source trial: the verifier re-run against that trial's
    RECORDED inputs, in a fresh separate verifier box. The agent phase is never
    re-run and the source trial is never modified — ``source_reward``/
    ``source_status`` are immutable snapshots taken when the regrade was created.
    """
    id: str
    source_trial_id: str
    task_key: str
    status: str
    reward: Optional[float]
    metrics: Optional[Dict[str, float]]
    source_reward: Optional[float]
    source_status: str
    # reward − source_reward when both are real numbers, else None (Harbor delta)
    reward_delta: Optional[float]
    # Where the verifier ran — always "separate" (regrade only re-runs separate)
    verifier_mode: str
    # Content digest of the resolved target verifier spec = the "verifier
    # version"; equal to the source trial's own verifier means a reproduce.
    verifier_digest: Optional[str]
    verifier_sandbox_id: Optional[str]
    failure_phase: Optional[str]
    failure_detail: Optional[str]
    phase_timings_ms: Optional[Dict[str, float]]
    created_at: str
    settled_at: Optional[str]


@dataclass
class RegradeFilter:
    """The filter applied when selecting source trials for a per-job regrade."""
    status: Optional[List[str]] = None
    task_key: Optional[str] = None


@dataclass
class RegradeResultsPage:
    """A regrade job's results: how many there are in the WHOLE job, how they
    break down by status (every status, zeros included), and one page of them.

    One object named for the collection rather than a ``counts`` sitting beside
    a separately-named list — and paged, because a regrade of a 10,000-trial
    job holds 10,000 results.
    """
    total: int
    by_status: Dict[str, int]
    items: List[RegradeResult]
    next_cursor: Optional[str]
    has_more: bool


@dataclass
class RegradeJob:
    """A regrade job = a collection of regrade results.

    A per-trial regrade holds one result; a per-job regrade holds one
    per eligible source trial. ``status`` is derived from the WHOLE result set
    ("QUEUED"|"RUNNING"|"COMPLETED"), never from one page.
    """
    id: str
    source_job_id: str
    status: str
    sandbox_provider: str
    results: RegradeResultsPage
    created_at: str
    updated_at: str
    filter: Optional[RegradeFilter] = None


@dataclass
class BenchmarkImportFailure:
    """One task that failed to parse or validate during an import."""
    task_key: str
    error: str


@dataclass
class ImportFailure:
    """Structured detail for a FAILED import."""
    # Stable machine-readable cause; "import_failed" when none was recorded.
    code: str
    # What went wrong, e.g. "2/113 task(s) failed to parse"
    message: str
    # Per-task parse/validation failures, when the corpus was reachable
    failures: List[BenchmarkImportFailure] = field(default_factory=list)


@dataclass
class BenchmarkImport:
    """A benchmark import job.

    Statuses are the SAME four words a job and a regrade use — QUEUED, RUNNING,
    COMPLETED, FAILED — because an import IS an asynchronous job. It used to
    speak a private IMPORTING/IMPORTED/FAILED vocabulary, so a status chip
    rendering all three had to carry a translation table for three spellings of
    the same four ideas.

    Terminal: "COMPLETED" (the corpus landed as a benchmark version; it becomes
    runnable once the platform activates it) and "FAILED".

    Self-describing: every response names the benchmark@version being imported,
    and every route that returns one — the 202 from ``import_benchmark()``,
    ``get_import()``, and ``list_imports()`` — returns this same shape.
    """
    id: str
    # Job status: "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED"
    status: str
    # Catalog benchmark name the import creates or extends
    benchmark_name: str
    # Version label of the imported version
    version: str
    # Why the import failed, when status is "FAILED"; None otherwise.
    #
    # Named `failure` and NOT `error`, deliberately: `error` is the key the
    # FAILURE envelope uses, so a client checking for it has to stay correct on
    # a perfectly healthy read of a failed import.
    failure: Optional[ImportFailure] = None
    # Number of tasks parsed, once counted
    task_count: Optional[int] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


@dataclass
class CustomHarness:
    """A private harness registered by the caller.

    Once registered, ``name`` is usable in ``agents[].harness`` exactly
    like a built-in ("claude", "codex", ...). Private to its owner: another
    user's name reads as ``custom_harness_not_found``, never as a permission
    error — existence is never leaked.
    """
    # The harness name to put in agents[].harness
    name: str
    # How the executables were produced: "install_script" | "tarball"
    source: str
    # The command run headless with `sh -c` at the task working directory
    run_command: str
    # Caller-declared env injected at RUN time only. It may not override the
    # run contract's own keys — the server rejects that at registration with
    # ``custom_harness_invalid_env``.
    env: Dict[str, str] = field(default_factory=dict)
    created_at: str = ''
    updated_at: str = ''


# The ONE page envelope, on every collection this surface returns — top level
# or nested. ``next_cursor`` means one thing everywhere: pass it back as
# ``cursor=`` for the next page, and None means there is no next page. It never
# echoes where you already are, so a poller can always tell it has caught up.


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
class BenchmarkPage:
    items: List[Benchmark]
    next_cursor: Optional[str]
    has_more: bool


@dataclass
class BenchmarkImportPage:
    items: List[BenchmarkImport]
    next_cursor: Optional[str]
    has_more: bool


@dataclass
class CustomHarnessPage:
    items: List[CustomHarness]
    next_cursor: Optional[str]
    has_more: bool




# =============================================================================
# MAPPERS
# =============================================================================

def _map_job_agent(data: Dict[str, Any]) -> JobAgent:
    # Map only the public JobAgent fields.
    return JobAgent(
        harness=data.get('harness', ''),
        model=data.get('model', ''),
        harness_version=data.get('harnessVersion'),
    )


def _map_upstream(data: Any) -> Optional[UpstreamStatus]:
    """Map the ``upstream`` field, tolerating an older server that omits it.

    A missing field and an explicit null mean the same thing to a caller —
    nothing to watch — so both become None, and a client never has to
    distinguish "this server is old" from "this benchmark has no git source".
    """
    if not isinstance(data, dict):
        return None
    behind_by = data.get('behindBy')
    return UpstreamStatus(
        ref=data['ref'],
        current_commit=data['currentCommit'],
        latest_commit=data.get('latestCommit'),
        moved=data.get('moved') is True,
        behind_by=behind_by if isinstance(behind_by, int) else None,
        checked_at=data.get('checkedAt'),
        error=data.get('error'),
    )


def _map_capability_document(raw: Dict[str, Any]) -> CapabilityDocument:
    """Map GET /api/meta into the public dataclass."""
    return CapabilityDocument(
        schema_version=raw.get('schemaVersion', 0),
        harnesses=[
            HarnessCapability(
                name=item['name'],
                runnable=item.get('runnable', False),
                reason=item.get('reason'),
                default_model=item.get('defaultModel'),
                models=[
                    HarnessModel(
                        alias=model['alias'],
                        model_id=model['modelId'],
                        description=model.get('description'),
                    )
                    for model in item.get('models', [])
                ],
                version_pinnable=item.get('versionPinnable', False),
                latest_version=item.get('latestVersion'),
            )
            for item in raw.get('harnesses', [])
        ],
        custom_harnesses=raw.get('customHarnesses', {}),
        sandbox_providers=[
            ProviderCapability(
                name=item['name'],
                default=item.get('default', False),
                sizing=item.get('sizing', {}),
                refuses=item.get('refuses', []),
            )
            for item in raw.get('sandboxProviders', [])
        ],
        platform_constraints=raw.get('platformConstraints', []),
        network_modes=raw.get('networkModes', []),
        statuses={
            key: StatusVocabulary(
                values=value.get('values', []),
                terminal=value.get('terminal', []),
                description=value.get('description', ''),
            )
            for key, value in (raw.get('statuses') or {}).items()
        },
        limits=raw.get('limits', {}),
        error_codes=raw.get('errorCodes', []),
    )


def _map_benchmark_version(data: Dict[str, Any]) -> BenchmarkVersion:
    return BenchmarkVersion(
        version=data['version'],
        state=data.get('state', ''),
        created_at=data.get('createdAt', ''),
        task_count=int(data.get('taskCount', 0)),
    )


def _map_task(data: Dict[str, Any]) -> Task:
    providers_raw = data.get('providers') or {}
    return Task(
        task_key=data['taskKey'],
        agent_timeout_sec=int(data.get('agentTimeoutSec', 0)),
        verifier_timeout_sec=int(data.get('verifierTimeoutSec', 0)),
        providers={
            provider: TaskProviderVerdict(
                ok=bool(verdict.get('ok')),
                reason=verdict.get('reason'),
            )
            for provider, verdict in providers_raw.items()
            if isinstance(verdict, dict)
        },
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
        by_status=tally.get('byStatus') or {},
    )


def _map_job_failure(data: Any) -> Optional[JobFailure]:
    if not isinstance(data, dict):
        return None
    return JobFailure(code=data.get('code', ''), message=data.get('message', ''))


def _map_job(data: Dict[str, Any]) -> Job:
    """The ONE job mapper — nothing conditional, because nothing is optional."""
    agents = data.get('agents')
    return Job(
        id=data['id'],
        status=data.get('status', ''),
        benchmark=data.get('benchmark', ''),
        agents=[_map_job_agent(item) for item in agents] if isinstance(agents, list) else [],
        runs_per_task=int(data.get('runsPerTask', 0)),
        concurrency=int(data.get('concurrency', 0)),
        max_trial_spend_usd=float(data.get('maxTrialSpendUsd', 0)),
        worst_case_spend_usd=float(data.get('worstCaseSpendUsd', 0)),
        sandbox_provider=data.get('sandboxProvider', ''),
        spent_usd=float(data.get('spentUsd', 0)),
        counts=_map_counts(data.get('counts')),
        trials=_map_trial_tally(data.get('trials')),
        mean_reward=data.get('meanReward'),
        failure=_map_job_failure(data.get('failure')),
        source_job_id=data.get('sourceJobId'),
        idempotent_replay=bool(data.get('idempotentReplay', False)),
        created_at=data.get('createdAt', ''),
        updated_at=data.get('updatedAt', ''),
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


_MODEL_USAGE_WIRE_KEYS = {'spentUsd', 'spendSource', 'maxTrialSpendUsd'}


def _map_model_usage(data: Any) -> Optional[ModelUsage]:
    if not isinstance(data, dict):
        return None
    return ModelUsage(
        spent_usd=data.get('spentUsd'),
        spend_source=data.get('spendSource'),
        max_trial_spend_usd=data.get('maxTrialSpendUsd'),
        extra={
            _snake_key(key): value
            for key, value in data.items()
            if key not in _MODEL_USAGE_WIRE_KEYS
        },
    )


def _map_trial(data: Dict[str, Any]) -> Trial:
    return Trial(
        id=data['id'],
        task_key=data.get('taskKey', ''),
        agent=_map_job_agent(data.get('agent') or {}),
        run_number=int(data.get('runNumber', 0)),
        status=data.get('status', ''),
        reward=data.get('reward'),
        metrics=data.get('metrics'),
        failure_phase=data.get('failurePhase'),
        failure_detail=data.get('failureDetail'),
        phase_timings_ms=_snake_keys(data.get('phaseTimingsMs')),
        model_usage=_map_model_usage(data.get('modelUsage')),
        sandbox_provider=data.get('sandboxProvider'),
        verifier_mode=data.get('verifierMode'),
        resolved_harness_version=data.get('resolvedHarnessVersion'),
        session_ref=data.get('sessionRef'),
        created_at=data.get('createdAt', ''),
        updated_at=data.get('updatedAt', ''),
    )


def _map_trial_detail(data: Dict[str, Any]) -> TrialDetail:
    base = _map_trial(data)
    return TrialDetail(
        **base.__dict__,
        job_id=data.get('jobId', ''),
    )


def _map_trace_event(data: Dict[str, Any]) -> TrialTraceEvent:
    return TrialTraceEvent(
        seq=int(data.get('seq', -1)),
        type=data.get('type', ''),
        data=data.get('data') or {},
    )


def _map_coverage(data: Any) -> ComparisonCoverage:
    data = data if isinstance(data, dict) else {}
    return ComparisonCoverage(
        scored=int(data.get('scored', 0)),
        total=int(data.get('total', 0)),
    )


def _map_comparison_aggregate(data: Dict[str, Any]) -> ComparisonAggregate:
    agents = data.get('agents')
    return ComparisonAggregate(
        id=data.get('id', ''),
        benchmark=data.get('benchmark', ''),
        status=data.get('status', ''),
        mean_reward=data.get('meanReward'),
        coverage=_map_coverage(data.get('coverage')),
        spent_usd=float(data.get('spentUsd', 0)),
        agents=(
            [_map_job_agent(item) for item in agents]
            if isinstance(agents, list)
            else []
        ),
        created_at=data.get('createdAt', ''),
    )


def _map_comparison_cell(data: Dict[str, Any]) -> ComparisonCell:
    return ComparisonCell(
        job_id=data.get('jobId', ''),
        status=data.get('status', ''),
        mean_reward=data.get('meanReward'),
        coverage=_map_coverage(data.get('coverage')),
    )


def _map_comparison_task_row(data: Dict[str, Any]) -> ComparisonTaskRow:
    return ComparisonTaskRow(
        task_key=data.get('taskKey', ''),
        disagreement=bool(data.get('disagreement', False)),
        cells=[_map_comparison_cell(item) for item in data.get('cells', [])],
    )


def _map_import_failure(data: Any) -> Optional[ImportFailure]:
    if not isinstance(data, dict):
        return None
    return ImportFailure(
        code=data.get('code', 'import_failed'),
        message=data.get('message', ''),
        failures=[
            BenchmarkImportFailure(
                task_key=item.get('taskKey', ''),
                error=item.get('error', ''),
            )
            for item in data.get('failures', [])
            if isinstance(item, dict)
        ],
    )


def _map_regrade_result(data: Dict[str, Any]) -> RegradeResult:
    return RegradeResult(
        id=data['id'],
        source_trial_id=data.get('sourceTrialId', ''),
        task_key=data.get('taskKey', ''),
        status=data.get('status', ''),
        reward=data.get('reward'),
        metrics=data.get('metrics'),
        source_reward=data.get('sourceReward'),
        source_status=data.get('sourceStatus', ''),
        reward_delta=data.get('rewardDelta'),
        verifier_mode=data.get('verifierMode', 'separate'),
        verifier_digest=data.get('verifierDigest'),
        verifier_sandbox_id=data.get('verifierSandboxId'),
        failure_phase=data.get('failurePhase'),
        failure_detail=data.get('failureDetail'),
        phase_timings_ms=_snake_keys(data.get('phaseTimingsMs')),
        created_at=data.get('createdAt', ''),
        settled_at=data.get('settledAt'),
    )


def _map_regrade_filter(data: Any) -> Optional[RegradeFilter]:
    if not isinstance(data, dict):
        return None
    return RegradeFilter(status=data.get('status'), task_key=data.get('taskKey'))


def _map_regrade_job(data: Dict[str, Any]) -> RegradeJob:
    raw_results = data.get('results') if isinstance(data.get('results'), dict) else {}
    items, next_cursor, has_more = _page_parts(raw_results)
    return RegradeJob(
        id=data['id'],
        source_job_id=data.get('sourceJobId', ''),
        status=data.get('status', ''),
        sandbox_provider=data.get('sandboxProvider', ''),
        results=RegradeResultsPage(
            total=int(raw_results.get('total', 0)),
            by_status=raw_results.get('byStatus') or {},
            items=[_map_regrade_result(item) for item in items],
            next_cursor=next_cursor,
            has_more=has_more,
        ),
        created_at=data.get('createdAt', ''),
        updated_at=data.get('updatedAt', ''),
        filter=_map_regrade_filter(data.get('filter')),
    )


def _map_custom_harness(data: Dict[str, Any]) -> CustomHarness:
    return CustomHarness(
        name=data.get('name', ''),
        source=data.get('source', ''),
        run_command=data.get('runCommand', ''),
        env=data.get('env') or {},
        created_at=data.get('createdAt', ''),
        updated_at=data.get('updatedAt', ''),
    )


def _map_benchmark_import(data: Dict[str, Any]) -> BenchmarkImport:
    benchmark_import = BenchmarkImport(
        id=data.get('id', ''),
        status=data.get('status', ''),
        benchmark_name=data.get('benchmarkName', ''),
        version=data.get('version', ''),
    )
    benchmark_import.failure = _map_import_failure(data.get('failure'))
    if isinstance(data.get('taskCount'), int):
        benchmark_import.task_count = data.get('taskCount')
    if isinstance(data.get('createdAt'), str):
        benchmark_import.created_at = data['createdAt']
    if isinstance(data.get('updatedAt'), str):
        benchmark_import.updated_at = data['updatedAt']
    return benchmark_import


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
        'retry_after_sec': retry_after if isinstance(retry_after, (int, float)) else None,
        'request_id': error['requestId'] if isinstance(error.get('requestId'), str) else None,
    }


def _raise_api_error(exc: urllib.error.HTTPError) -> None:
    detail = exc.read().decode('utf-8', errors='replace')
    parsed = _parse_error_body(detail, str(exc.reason))
    # Header fallbacks, so an unparseable body still yields a usable request id
    # and retry delay.
    headers = getattr(exc, 'headers', None)
    header_request_id = headers.get('X-Request-Id') if headers else None
    header_retry_after = headers.get('Retry-After') if headers else None
    try:
        header_retry_sec = float(header_retry_after) if header_retry_after else None
    except ValueError:
        header_retry_sec = None
    raise EvolveAPIError(
        exc.code,
        parsed['code'],
        parsed['message'],
        param=parsed.get('param'),
        details=parsed.get('details'),
        retry_after_sec=parsed.get('retry_after_sec') or header_retry_sec,
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

    async def request_bytes(self, path: str) -> 'tuple[bytes, Dict[str, str]]':
        return await asyncio.to_thread(self._request_sync, path, 'GET', None, None, True)

    async def request_upload(
        self, path: str, data: bytes, headers: Dict[str, str], method: str = 'POST'
    ) -> Dict[str, Any]:
        """Send raw bytes (e.g. a gzipped tarball) and parse the JSON reply.

        ``method`` exists for the custom-harness upsert, which is the same body
        grammar at the same content type under PUT.
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
            with urllib.request.urlopen(request, timeout=600) as response:
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
            with urllib.request.urlopen(request, timeout=60) as response:
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
            with urllib.request.urlopen(request, timeout=600) as response:
                os.makedirs(to_dir, exist_ok=True)
                disposition = response.headers.get('Content-Disposition', '') or ''
                match = re.search(r'filename="([^"]+)"', disposition)
                filename = match.group(1) if match else default_filename
                target = os.path.join(to_dir, filename)
                with open(target, 'wb') as f:
                    shutil.copyfileobj(response, f)
                return target
        except urllib.error.HTTPError as exc:
            _raise_api_error(exc)
            raise  # unreachable; _raise_api_error always raises


def _multipart_body(
    fields: Dict[str, Optional[str]],
    file: Optional['tuple[str, bytes]'] = None,
) -> 'tuple[bytes, str]':
    """Build the multipart/form-data body both upload routes take.

    Metadata goes in named parts FIRST, then the bytes as a ``file`` part —
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
    if file is not None:
        filename, data = file
        parts.append(
            f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
            f'filename="{filename}"\r\nContent-Type: application/gzip\r\n\r\n'.encode('utf-8')
        )
        parts.append(data)
        parts.append(b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode('utf-8'))
    return b''.join(parts), f'multipart/form-data; boundary={boundary}'


def _harness_upload_body(
    caller: str,
    *,
    name: str,
    run_command: str,
    install_script: Optional[str],
    directory: Optional[str],
    env: Optional[Dict[str, str]],
) -> 'tuple[bytes, str]':
    """The multipart body both ``create()`` and ``upsert()`` send.

    Shared because the two differ only in method and URL: one grammar means a
    harness registered by either route is byte-identical on the wire.
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
    fields: Dict[str, Optional[str]] = {'name': name, 'runCommand': run_command}
    if env is not None:
        fields['env'] = json.dumps(env)
    if install_script is not None:
        fields['installScript'] = install_script
    file: Optional['tuple[str, bytes]'] = None
    if directory is not None:
        file = ('source.tar.gz', _tar_gzip_directory(directory))
    return _multipart_body(fields, file)


def _tar_gzip_directory(directory: str) -> bytes:
    """Deterministically tar + gzip a corpus directory for the directory import.

    Same content -> same bytes (so the tarball sha256 the server records as the
    import's source identity is reproducible): entries sorted by path, headers
    normalized (mtime 0, uid/gid 0, empty uname/gname, mode 0644), gzip carries
    no timestamp. Hidden entries (".git"/".DS_Store"/".venv") and symlinks are
    skipped — a corpus is plain files and the server rejects symlinks anyway.
    """
    root = os.path.abspath(directory)
    if not os.path.isdir(root):
        raise ValueError(f'directory not found: {directory}')
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith('.'))
        for name in sorted(filenames):
            if name.startswith('.'):
                continue
            abs_path = os.path.join(dirpath, name)
            if os.path.islink(abs_path):
                continue
            rel = os.path.relpath(abs_path, root).replace(os.sep, '/')
            files.append((rel, abs_path))
    files.sort(key=lambda t: t[0])

    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode='wb', mtime=0, compresslevel=9) as gz:
        with tarfile.open(fileobj=gz, mode='w', format=tarfile.USTAR_FORMAT) as tar:
            for rel, abs_path in files:
                info = tarfile.TarInfo(name=rel)
                info.size = os.path.getsize(abs_path)
                info.mtime = 0
                info.mode = 0o644
                info.uid = 0
                info.gid = 0
                info.uname = ''
                info.gname = ''
                info.type = tarfile.REGTYPE
                with open(abs_path, 'rb') as handle:
                    tar.addfile(info, handle)
    return buf.getvalue()


# =============================================================================
# PAGINATION (awaitable + async-iterable)
# =============================================================================

class _PaginatedList:
    """A cursor-paged result that is both awaitable and async-iterable.

    ``await`` resolves the first page, honoring the caller's ``limit``/``cursor``
    (the original page form). ``async for`` walks every row across pages,
    following ``next_cursor`` from the caller's starting cursor.
    """

    def __init__(self, fetch_page, rows_of, *, limit=None, cursor=None):
        # fetch_page: async (limit, cursor) -> page
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
    :class:`JobEvent`. This is the same dual-use shape :class:`_PaginatedList`
    already uses for ``list()``, and the same shape the TypeScript SDK's
    ``jobs().watch()`` returns — TS/Python parity is a law here, and the two
    disagreed: TS had one dual-use method, Python had ``watch`` plus
    ``watch_iter``.

    Python won on nothing and lost on consistency: it already spelled the
    dual-use idiom for pagination, so having a second, split idiom for watching
    made the SDK disagree with ITSELF as well as with TypeScript.
    ``watch_iter()`` remains as a thin alias so existing code keeps working.

    Pick one form per handle: both drive the same underlying SSE stream.
    """

    def __init__(self, events, final):
        # events: () -> AsyncIterator[JobEvent]; final: async () -> Job
        self._events = events
        self._final = final

    def __await__(self):
        return self._final().__await__()

    def __aiter__(self):
        return self._events()


# =============================================================================
# BENCHMARKS CLIENT
# =============================================================================

class BenchmarksClient:
    """Client for the shared benchmark catalog.

    Created via the standalone ``benchmarks()`` factory. Requires
    ``EVOLVE_API_KEY`` unless ``HostedClientConfig(api_key=...)`` is given.

    Example::

        from evolve import benchmarks

        async with benchmarks() as b:
            catalog = await b.list()
            deep_swe = await b.get('deep-swe@1.1')
    """

    def __init__(self, config: Optional[HostedClientConfig] = None):
        self._http = _HostedHttp('benchmarks', config)

    async def __aenter__(self) -> 'BenchmarksClient':
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        return None

    def list(
        self,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> _PaginatedList:
        """List benchmarks with their active versions (cursor-paged).

        ``await`` the result for one page (honoring ``limit``/``cursor``), or
        ``async for`` it to walk the whole catalog across cursor pages.
        """
        async def fetch_page(page_limit, page_cursor) -> BenchmarkPage:
            raw = await self._http.request_json(
                f'/api/benchmarks{_page_query(page_limit, page_cursor)}'
            )
            items, next_cursor, has_more = _page_parts(raw)
            return BenchmarkPage(
                items=[
                    Benchmark(
                        name=item['name'],
                        title=item.get('title'),
                        description=item.get('description'),
                        active_version=(
                            _map_benchmark_version(item['activeVersion'])
                            if item.get('activeVersion')
                            else None
                        ),
                        upstream=_map_upstream(item.get('upstream')),
                    )
                    for item in items
                ],
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
    ) -> Benchmark:
        """Get one benchmark: all versions + one page of the selected version's tasks.

        ``ref`` is ``"name"`` (active version's tasks) or ``"name@version"``;
        ``limit``/``cursor`` page the TASK list.
        """
        name, ref_version = _parse_benchmark_ref(ref)
        query = _page_query(limit, cursor, version=ref_version)
        raw = await self._http.request_json(
            f'/api/benchmarks/{urllib.parse.quote(name)}{query}'
        )
        active = raw.get('activeVersion')
        selected = raw.get('selectedVersion')
        task_items, task_cursor, task_more = _page_parts(raw.get('tasks'))
        return Benchmark(
            name=raw['name'],
            title=raw.get('title'),
            description=raw.get('description'),
            active_version=_map_benchmark_version(active) if active else None,
            upstream=_map_upstream(raw.get('upstream')),
            versions=[_map_benchmark_version(item) for item in raw.get('versions', [])],
            selected_version=_map_benchmark_version(selected) if selected else None,
            tasks=TaskPage(
                items=[_map_task(item) for item in task_items],
                next_cursor=task_cursor,
                has_more=task_more,
            ),
            created_at=raw.get('createdAt'),
            updated_at=raw.get('updatedAt'),
        )

    async def get_active(
        self,
        name: str,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> ActiveBenchmark:
        """Get a benchmark's active version resolved to a runnable shape.

        Unlike :meth:`get`, ``version`` and ``tasks`` are guaranteed present.
        Raises :class:`NoActiveVersionError` when the benchmark has no active
        version. Use :meth:`get` for the full multi-version detail.
        """
        bench = await self.get(name, limit=limit, cursor=cursor)
        if bench.active_version is None:
            raise NoActiveVersionError(name)
        return ActiveBenchmark(
            name=bench.name,
            title=bench.title,
            description=bench.description,
            active_version=bench.active_version,
            version=bench.active_version.version,
            tasks=bench.tasks or TaskPage(items=[], next_cursor=None, has_more=False),
            versions=bench.versions or [],
            created_at=bench.created_at,
            updated_at=bench.updated_at,
        )

    async def import_benchmark(
        self,
        *,
        git_url: Optional[str] = None,
        ref: Optional[str] = None,
        directory: Optional[str] = None,
        benchmark_name: str,
        version: str,
    ) -> BenchmarkImport:
        """Start a benchmark import job.

        Provide EITHER a git source (``git_url`` + ``ref``) OR a local corpus
        ``directory`` (tarred + gzipped deterministically on the client and
        uploaded). Returns immediately; poll with :meth:`get_import` /
        :meth:`watch_import`. ``version`` labels the imported benchmark version.
        """
        # ONE body grammar: multipart/form-data, metadata in named parts. The
        # corpus is the ``file`` part; a git source is the gitUrl + ref parts.
        if directory is not None:
            gzipped = await asyncio.to_thread(_tar_gzip_directory, directory)
            body, content_type = _multipart_body(
                {'benchmarkName': benchmark_name, 'version': version},
                ('corpus.tar.gz', gzipped),
            )
        elif git_url and ref:
            body, content_type = _multipart_body({
                'benchmarkName': benchmark_name,
                'version': version,
                'gitUrl': git_url,
                'ref': ref,
            })
        else:
            raise ValueError(
                'import_benchmark() requires either a git source (git_url=..., ref=...) '
                'or a local corpus directory (directory=...), plus benchmark_name=... '
                'and version=...'
            )
        raw = await self._http.request_upload(
            '/api/benchmarks/imports', body, {'Content-Type': content_type}
        )
        return _map_benchmark_import(raw)

    async def get_import(self, id: str) -> BenchmarkImport:
        """Get an import job's status (error and task_count when available)."""
        raw = await self._http.request_json(
            f'/api/benchmarks/imports/{urllib.parse.quote(id)}'
        )
        return _map_benchmark_import(raw)

    async def watch_import(
        self,
        id: str,
        *,
        on_status: Optional[Callable[[BenchmarkImport], None]] = None,
        poll_interval_s: float = 2.0,
        timeout_s: Optional[float] = None,
    ) -> BenchmarkImport:
        """Poll ``get_import()`` until the job reaches a terminal status.

        Terminal statuses: "IMPORTED" or "FAILED" (``error`` populated).
        ``on_status`` fires on every observed status change, including the
        first status seen.
        """
        if poll_interval_s <= 0:
            raise ValueError('poll_interval_s must be positive')
        deadline = time.monotonic() + timeout_s if timeout_s is not None else None
        last_status: Optional[str] = None
        while True:
            benchmark_import = await self.get_import(id)
            if benchmark_import.status != last_status:
                last_status = benchmark_import.status
                if on_status is not None:
                    on_status(benchmark_import)
            if benchmark_import.status in _TERMINAL_IMPORT_STATUSES:
                return benchmark_import
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f'watch_import({id!r}) timed out after {timeout_s}s')
            await asyncio.sleep(poll_interval_s)

    def list_imports(
        self,
        *,
        status: Optional[str] = None,
        benchmark: Optional[str] = None,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> _PaginatedList:
        """List your own imports, newest first (cursor-paged).

        This is how you find an import again after losing the id ``import_()``
        returned — without it, closing a tab made a running import permanently
        unwatchable.

        ``await`` for one page, or ``async for`` to walk them all. ``status``
        filters on the import vocabulary ("IMPORTING" | "IMPORTED" | "FAILED");
        ``benchmark`` narrows to one benchmark name.
        """
        async def fetch_page(page_limit, page_cursor) -> BenchmarkImportPage:
            query = _page_query(page_limit, page_cursor)
            extra = []
            if status is not None:
                extra.append(f'status={urllib.parse.quote(status)}')
            if benchmark is not None:
                extra.append(f'benchmark={urllib.parse.quote(benchmark)}')
            if extra:
                query = f'{query}&{"&".join(extra)}' if query else f'?{"&".join(extra)}'
            raw = await self._http.request_json(f'/api/benchmarks/imports{query}')
            items, next_cursor, has_more = _page_parts(raw)
            return BenchmarkImportPage(
                items=[_map_benchmark_import(item) for item in items],
                next_cursor=next_cursor,
                has_more=has_more,
            )

        return _PaginatedList(
            fetch_page, lambda page: page.items, limit=limit, cursor=cursor
        )

    async def delete(self, name: str) -> None:
        """Delete a benchmark you own, with every version, task, and archived solution.

        Refused (``benchmark_in_use``) while any job still references it — a
        benchmark is never deleted out from under a job that measured against
        it, and ``err.details['sampleJobIds']`` names the jobs blocking it. A
        platform benchmark is refused with ``benchmark_not_owned``; a name you
        cannot see is a plain not-found.
        """
        await self._http.request_json(
            f'/api/benchmarks/{urllib.parse.quote(name)}', method='DELETE'
        )


# =============================================================================
# CUSTOM HARNESSES CLIENT
# =============================================================================

class CustomHarnessesClient:
    """Client for the caller's own private (bring-your-own) harnesses.

    Created via the standalone ``custom_harnesses()`` factory. Register a
    harness once, then name it in ``agents[].harness`` exactly like a
    built-in. Requires ``EVOLVE_API_KEY`` unless
    ``HostedClientConfig(api_key=...)`` is given.

    Example::

        from evolve import custom_harnesses, jobs, JobAgent

        async with custom_harnesses() as harnesses:
            await harnesses.create(
                name='acme-cli',
                install_script='curl -fsSL https://acme.dev/install.sh | sh',
                run_command='acme-cli --headless',
            )

        async with jobs() as jobs_client:
            await jobs_client.run(
                benchmark='deep-swe',
                agents=[JobAgent(harness='acme-cli', model='gpt-5.5')],
                max_trial_spend_usd=25,
            )
    """

    def __init__(self, config: Optional[HostedClientConfig] = None):
        self._http = _HostedHttp('custom_harnesses', config)

    async def __aenter__(self) -> 'CustomHarnessesClient':
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
    ) -> CustomHarness:
        """Register a private harness.

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
        body, content_type = _harness_upload_body(
            'create()',
            name=name,
            run_command=run_command,
            install_script=install_script,
            directory=directory,
            env=env,
        )
        raw = await self._http.request_upload(
            '/api/custom-harnesses', body, {'Content-Type': content_type}
        )
        return _map_custom_harness(raw)

    def list(
        self,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> _PaginatedList:
        """List the caller's registered custom harnesses (cursor-paged).

        ``await`` the result for one page, or ``async for`` it to walk them all.
        """
        async def fetch_page(page_limit, page_cursor) -> CustomHarnessPage:
            raw = await self._http.request_json(
                f'/api/custom-harnesses{_page_query(page_limit, page_cursor)}'
            )
            items, next_cursor, has_more = _page_parts(raw)
            return CustomHarnessPage(
                items=[_map_custom_harness(item) for item in items],
                next_cursor=next_cursor,
                has_more=has_more,
            )

        return _PaginatedList(
            fetch_page, lambda page: page.items, limit=limit, cursor=cursor
        )

    async def get(self, name: str) -> CustomHarness:
        """Get one custom harness by name."""
        raw = await self._http.request_json(
            f'/api/custom-harnesses/{urllib.parse.quote(name)}'
        )
        return _map_custom_harness(raw)

    async def upsert(
        self,
        name: str,
        *,
        run_command: str,
        install_script: Optional[str] = None,
        directory: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> CustomHarness:
        """Register or replace a harness in ONE call, under ``name``.

        Use this instead of ``delete()`` + ``create()`` to change an existing
        registration: the pair leaves a window where the harness does not exist,
        and anything naming it in that window fails for a change that was only
        ever meant to be an edit.

        This is a full REPLACEMENT, not a patch — every field comes from this
        call, and an omitted ``env`` becomes empty.
        """
        body, content_type = _harness_upload_body(
            'upsert()',
            name=name,
            run_command=run_command,
            install_script=install_script,
            directory=directory,
            env=env,
        )
        raw = await self._http.request_upload(
            f'/api/custom-harnesses/{urllib.parse.quote(name)}',
            body,
            {'Content-Type': content_type},
            method='PUT',
        )
        return _map_custom_harness(raw)

    async def delete(self, name: str) -> None:
        """Delete a custom harness. Past jobs keep their recorded harness."""
        # 204 No Content — nothing to map.
        await self._http.request_json(
            f'/api/custom-harnesses/{urllib.parse.quote(name)}', method='DELETE'
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


# =============================================================================
# JOBS CLIENT
# =============================================================================

class JobsClient:
    """Client for hosted jobs.

    Created via the standalone ``jobs()`` factory. Requires
    ``EVOLVE_API_KEY`` unless ``HostedClientConfig(api_key=...)`` is given.

    ``watch()`` consumes the server-sent event stream (replay + live,
    Last-Event-ID resume on reconnect) and resolves with the final job;
    ``watch_iter()`` yields each :class:`JobEvent` instead.

    Example::

        from evolve import jobs, JobAgent

        async with jobs() as j:
            job = await j.run(
                benchmark='deep-swe@1.1',
                agents=[JobAgent(harness='codex', model='gpt-5.5')],
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

    async def run(
        self,
        *,
        benchmark: str,
        tasks: Optional[List[str]] = None,
        agents: List[Union[JobAgent, Dict[str, Any]]],
        runs_per_task: Optional[int] = None,
        concurrency: Optional[int] = None,
        max_trial_spend_usd: Optional[float] = None,
        sandbox_provider: Optional[str] = None,
        idempotency_key: Optional[str] = None,
    ) -> Job:
        """Create a job.

        ``benchmark`` is ``"name"`` (resolved server-side to the active READY
        version) or ``"name@version"``; the response always echoes
        ``"name@version"``. ``agents`` accepts :class:`JobAgent`
        instances or plain dicts with the same fields (``harness``, ``model``,
        optional ``harness_version``). ``max_trial_spend_usd`` caps EACH
        trial and is the platform's only spend enforcement; omitted, the server
        applies its own default ($200, operator-tunable). The response echoes
        the RESOLVED cap either way, so an omitted one is never invisible, and
        reports the resulting worst case for the whole job. Supports
        Idempotency-Key.
        """
        body: Dict[str, Any] = {'benchmark': benchmark}
        if tasks is not None:
            body['tasks'] = tasks
        body['agents'] = [
            (agent if isinstance(agent, JobAgent) else JobAgent(**agent))._to_wire()
            for agent in agents
        ]
        if runs_per_task is not None:
            body['runsPerTask'] = runs_per_task
        if concurrency is not None:
            body['concurrency'] = concurrency
        if max_trial_spend_usd is not None:
            body['maxTrialSpendUsd'] = max_trial_spend_usd
        if sandbox_provider is not None:
            body['sandboxProvider'] = sandbox_provider
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
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> _PaginatedList:
        """List the caller's jobs, newest first (cursor-paged).

        ``await`` the result for one page (honoring ``limit``/``cursor``), or
        ``async for`` it to walk every job across cursor pages.
        """
        async def fetch_page(page_limit, page_cursor) -> JobPage:
            raw = await self._http.request_json(
                f'/api/jobs{_page_query(page_limit, page_cursor)}'
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
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> _PaginatedList:
        """List a job's trials (cursor-paged).

        ``status`` filters to the given statuses (e.g. the failures behind a
        rerun decision). ``await`` the result for one page (honoring
        ``limit``/``cursor``), or ``async for`` it to walk every trial
        across cursor pages.
        """
        async def fetch_page(page_limit, page_cursor) -> TrialPage:
            query = _page_query(
                page_limit,
                page_cursor,
                status=','.join(status) if status else None,
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
        onto the asyncio queue. The server heartbeats every 15s, so the 60s
        socket timeout only trips on a genuinely dead connection."""

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
            with urllib.request.urlopen(request, timeout=60) as response:
                connection.response = response
                event_id: Optional[str] = None
                event_type: Optional[str] = None
                data_lines: List[str] = []
                for raw_line in response:
                    line = raw_line.decode('utf-8', errors='replace').rstrip('\r\n')
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
            # one that arrives from a request, param and details included.
            put(('http_error', exc.code, _parse_error_body(detail, str(exc.reason))))
            return
        except Exception as exc:
            put(('error', exc))
            return
        put(('eof', None))

    async def watch_iter(
        self,
        id: str,
        *,
        timeout_s: Optional[float] = None,
        reconnect_delay_s: float = 1.0,
        max_reconnect_delay_s: float = 30.0,
    ) -> AsyncIterator[JobEvent]:
        """Async-iterate the job's server-sent events until terminal.

        Replays from the beginning, resumes with Last-Event-ID on reconnect
        (exponential backoff), and completes on the terminal event
        (``job.completed`` / ``job.cancelled`` / ``job.failed``).

        .. deprecated::
            Prefer ``async for event in j.watch(job_id)``. :meth:`watch` is now
            dual-use (awaitable OR iterable), matching the TypeScript SDK's one
            ``watch()``; this method stays so existing code keeps working.

        Example::

            async for event in j.watch_iter(job.id):
                print(event.seq, event.type, event.data)
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
            await asyncio.sleep(min(delay, remaining() or delay))
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
        arrives, firing ``on_event`` for each event on the way — exactly what
        this method did before, so ``job = await j.watch(id)`` is unchanged.

        ``async for`` yields each :class:`JobEvent` instead, which is what
        :meth:`watch_iter` did. One method now covers both, matching the
        TypeScript SDK's ``jobs().watch()``.

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
        async for event in self.watch_iter(
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

    async def rerun_failed(self, id: str, *, idempotency_key: Optional[str] = None) -> Job:
        """Create a NEW linked job of only the failed trials."""
        headers = {'Idempotency-Key': idempotency_key} if idempotency_key else None
        raw = await self._http.request_json(
            f'/api/jobs/{urllib.parse.quote(id)}/rerun-failed',
            method='POST',
            body={},
            headers=headers,
        )
        return _map_job(raw)

    async def regrade(
        self,
        id: str,
        *,
        status: Optional[List[str]] = None,
        task_key: Optional[str] = None,
    ) -> RegradeJob:
        """Regrade a terminal job: re-run the verifier of every REGRADABLE
        trial (settled separate-mode trials, which recorded their verifier
        inputs) against those recorded inputs, in fresh separate verifier boxes.

        The agent phase is never re-run and the source trials are never
        modified. ``status`` / ``task_key`` narrow the set of source trials.
        Returns a new regrade job with one result per selected trial.
        """
        body: Dict[str, Any] = {}
        if status is not None:
            body['status'] = status
        if task_key is not None:
            body['taskKey'] = task_key
        raw = await self._http.request_json(
            f'/api/jobs/{urllib.parse.quote(id)}/regrade', method='POST', body=body
        )
        return _map_regrade_job(raw)

    async def regrade_trial(self, id: str, trial_id: str) -> RegradeJob:
        """Regrade one settled trial: re-run its verifier against its recorded
        inputs in a fresh separate verifier box.

        Refused (``regrade_source_ineligible``) for shared-mode or
        pre-persistence trials. Returns a regrade job with one result.
        """
        raw = await self._http.request_json(
            f'/api/jobs/{urllib.parse.quote(id)}'
            f'/trials/{urllib.parse.quote(trial_id)}/regrade',
            method='POST',
            body={},
        )
        return _map_regrade_job(raw)

    async def regrade_job(
        self,
        job_id: str,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> RegradeJob:
        """Read a regrade job and one page of its per-trial results.

        Each result carries its lineage and reward delta. ``limit``/``cursor``
        page the results — a regrade of a 10,000-trial job holds 10,000 of them.
        """
        raw = await self._http.request_json(
            f'/api/regrades/{urllib.parse.quote(job_id)}{_page_query(limit, cursor)}'
        )
        return _map_regrade_job(raw)

    async def export(
        self,
        id: str,
        *,
        to: Optional[str] = None,
        format: Optional[str] = None,
    ):
        """Download the research archive (gzipped JSON) of a terminal job.

        Returns the archive bytes, or — when ``to`` (a directory) is given —
        streams straight to disk and returns the saved file path.
        ``format='harbor'`` selects the Harbor job-layout bundle instead of
        the canonical archive.
        """
        if format is not None and format != 'harbor':
            raise ValueError(f"Unknown format {format!r}; supported: 'harbor'")
        query = f'?format={urllib.parse.quote(format)}' if format else ''
        path = f'/api/jobs/{urllib.parse.quote(id)}/export{query}'
        if to is not None:
            return await self._http.download(path, to, f'job-{id}-export.json.gz')
        payload, _headers = await self._http.request_bytes(path)
        return payload

    async def trial(self, id: str, trial_id: str) -> TrialDetail:
        """Get one trial's full detail.

        Same shape as a list row plus ``job_id``; unlike list rows,
        ``failure_detail`` is untruncated.
        """
        raw = await self._http.request_json(
            f'/api/jobs/{urllib.parse.quote(id)}'
            f'/trials/{urllib.parse.quote(trial_id)}'
        )
        return _map_trial_detail(raw)

    async def trial_trace(
        self,
        id: str,
        trial_id: str,
        *,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> TrialTracePage:
        """Get one page of a trial's trace.

        ``cursor`` returns events with seq strictly greater than it (omit =
        from the beginning); resume with ``cursor=page.next_cursor``. A None
        ``next_cursor`` means CAUGHT UP — to resume a poll later, keep the last
        event's ``seq`` and pass it as ``cursor``.
        """
        raw = await self._http.request_json(
            f'/api/jobs/{urllib.parse.quote(id)}'
            f'/trials/{urllib.parse.quote(trial_id)}/trace{_page_query(limit, cursor)}'
        )
        items, next_cursor, has_more = _page_parts(raw)
        return TrialTracePage(
            items=[_map_trace_event(item) for item in items],
            next_cursor=next_cursor,
            has_more=has_more,
        )

    async def trial_trace_events(
        self,
        id: str,
        trial_id: str,
        *,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ):
        """Iterate a trial's trace events, fetching pages under the hood.

        Drains the currently available trace, then stops: ``next_cursor`` is
        None when there is no next page, which now says "caught up" rather than
        echoing the position back. Resume later by passing the last seen seq as
        ``cursor``.
        """
        position = cursor
        while True:
            page = await self.trial_trace(id, trial_id, cursor=position, limit=limit)
            for event in page.items:
                yield event
            if not page.next_cursor:
                return
            position = page.next_cursor

    async def compare(self, ids: List[str]) -> JobComparison:
        """Side-by-side comparison of 2-5 owned jobs.

        Per-job aggregates plus a per-task matrix with disagreement
        rows first. Means cover SCORED trials only; coverage is always reported.
        """
        query = ','.join(urllib.parse.quote(item) for item in ids)
        raw = await self._http.request_json(f'/api/jobs/compare?ids={query}')
        return JobComparison(
            jobs=[
                _map_comparison_aggregate(item) for item in raw.get('jobs', [])
            ],
            task_matrix=[
                _map_comparison_task_row(item) for item in raw.get('taskMatrix', [])
            ],
        )


def _parse_benchmark_ref(ref: str) -> 'tuple[str, Optional[str]]':
    at = ref.find('@')
    if at == -1:
        return ref.strip(), None
    name = ref[:at].strip()
    version = ref[at + 1:].strip()
    if not name or not version:
        raise ValueError(f'Invalid benchmark ref "{ref}": expected "name" or "name@version"')
    return name, version


# =============================================================================
# FRONT DOOR
# =============================================================================

class HostedEvolve:
    """The hosted surface, configured once.

    The three clients are the right decomposition — a benchmark catalog, your
    own harness registrations, and jobs are three genuinely different lifetimes
    — but they made you say the same thing three times::

        b = benchmarks(config)
        h = custom_harnesses(config)   # again
        j = jobs(config)               # and again

    and any one of those drifting out of sync with the others is a bug that
    looks like a permissions problem. One door, one config::

        from evolve import hosted

        client = hosted()
        catalog = await client.benchmarks.list()
        job = await client.jobs.run(benchmark='deep-swe', agents=[...])

    The three clients are built LAZILY, on first access. That matters because
    they raise when no API key is present, and :meth:`meta` needs no key at all
    — so ``await hosted().meta()`` works with no credentials configured, while
    ``hosted().jobs`` still fails loudly the moment you reach for something
    that does need them.
    """

    def __init__(self, config: Optional[HostedClientConfig] = None):
        self._config = config
        self._benchmarks: Optional[BenchmarksClient] = None
        self._custom_harnesses: Optional[CustomHarnessesClient] = None
        self._jobs: Optional[JobsClient] = None

    @property
    def benchmarks(self) -> BenchmarksClient:
        """The benchmark catalog: list, get, import, delete."""
        if self._benchmarks is None:
            self._benchmarks = BenchmarksClient(self._config)
        return self._benchmarks

    @property
    def custom_harnesses(self) -> CustomHarnessesClient:
        """Your own bring-your-own harness registrations."""
        if self._custom_harnesses is None:
            self._custom_harnesses = CustomHarnessesClient(self._config)
        return self._custom_harnesses

    @property
    def jobs(self) -> JobsClient:
        """Jobs: run, watch, compare, regrade, export."""
        if self._jobs is None:
            self._jobs = JobsClient(self._config)
        return self._jobs

    async def meta(self) -> CapabilityDocument:
        """The capability document. Public: no API key required.

        Fetch it once and stop hardcoding. It is what tells you the legal
        harness names without having to send a bad one and read the 400.
        """
        return await meta(self._config)

    async def __aenter__(self) -> 'HostedEvolve':
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        for client in (self._benchmarks, self._custom_harnesses, self._jobs):
            if client is not None:
                await client.close()


async def meta(config: Optional[HostedClientConfig] = None) -> CapabilityDocument:
    """Fetch the capability document.

    NO API KEY. The document is the same information the docs publish, and
    requiring credentials would mean a signed-out page could not populate its
    own harness picker — so this is the one hosted call that takes only a base
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
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode('utf-8'))
        except urllib.error.HTTPError as exc:
            _raise_api_error(exc)
            raise  # unreachable; _raise_api_error always raises

    return _map_capability_document(await asyncio.to_thread(fetch))
