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
from pathlib import Path
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
    TypedDict,
    Union,
    get_args,
)

from . import _http
from .config import HostedClientConfig
from .results import UsageReading, _usage_reading_from_data

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

#: Backstop bound on watch_import's settle phase — how long past import
#: COMPLETED the watch may wait for the version to settle before refusing
#: with ``ImportSettleError('settle_timeout')``. Normally one confirming
#: read: the server settles a publish at import COMPLETED (COMPLETED means
#: the version is READY under build-then-READY), so this bound exists for a
#: mid-deploy older server still moving a version after COMPLETED;
#: overridable per call.
_DEFAULT_SETTLE_TIMEOUT_S = 30 * 60.0

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
    'invalid_visibility',
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
    # Partial publish: the failure-detail read of a task name with no recorded
    # build outcome in the version, and a job create that NAMES a task whose
    # build FAILED (refused typed, quoting the build failure — never a silent
    # skip of an explicitly requested task; the refusal details carry every
    # named task with its reason under the failed-tasks key).
    'task_not_found',
    'task_failed_to_build',
    'agent_not_found',
    'agent_name_taken',
    'agent_name_reserved',
    'agent_invalid_name',
    'agent_source_required',
    'agent_source_conflict',
    'agent_invalid_env',
    'agent_too_large',
    'agent_limit_reached',
    'skill_not_found',
    'skill_name_not_found',
    'skill_ref_invalid',
    'skill_unresolvable',
    'skill_invalid',
    'skill_in_use',
    'skill_too_large',
    'skill_limit_reached',
    'secret_not_found',
    'secret_ambiguous',
    'secret_brokered_unsupported',
    'secret_exists',
    'agent_version_not_found',
    'agent_version_unresolvable',
    'agent_kwarg_unsupported',
    'agent_config_unsupported',
    'agent_config_key_refused',
    'agent_preset_unsupported',
    'job_too_large',
    'provider_unsupported',
    'job_not_found',
    'job_not_terminal',
    'no_failed_trials',
    'trial_not_found',
    'trial_not_settled',
    'concurrent_update',
    'regrade_source_ineligible',
    'no_regradable_trials',
    # Analyze: a rubric that cannot rule an analysis (unknown keys, empty or
    # duplicate criteria, bounds exceeded); one wave at a time (re-analysis is
    # legal once the previous wave settles); a terminal job with no analyzable
    # trial (every trial CANCELLED).
    'invalid_rubric',
    'analysis_already_running',
    'no_analyzable_trials',
    # Job upload (POST /api/jobs/upload): the archive is not a Harbor job
    # directory (no result.json / config.json at its root, or they do not
    # parse); one trial directory that cannot be ingested (the refusal names
    # the trial and the reason, 422); the archive over the byte cap (413,
    # distinct from import_too_large — that one belongs to dataset corpora);
    # and a run-lifecycle verb (resume / retry / regrade) on an UPLOADED job —
    # a terminal record of a run that happened elsewhere, never runnable here
    # (409; analyze is deliberately not among the refusers).
    'not_a_job_dir',
    'invalid_trial',
    'upload_too_large',
    'job_uploaded',
    # Re-uploading an archive whose job this caller already uploaded (409),
    # detected by (uploading user, the archive result.json's own job id);
    # details name the existing job. Deliberately NOT Harbor's
    # update-in-place: our trial rows carry analyses and analysis history —
    # silently replacing trials would destroy them; Harbor's hub rows have no
    # such children.
    'job_already_uploaded',
    'import_not_found',
    'import_too_large',
    'invalid_archive',
    'unpinned_git_ref',
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


class ImportSettleError(Exception):
    """Raised by ``datasets().watch_import()`` when the import COMPLETED but
    the WATCH cannot truthfully report the version settled: the
    ``settle_timeout_s`` backstop elapsed first (``code`` is
    ``'settle_timeout'``, the only cause).

    This bounds the WAIT, never the publish — keep following with
    ``get("name@version")``. When ``state`` is ``'FAILED'`` the version DID
    settle and the budget was spent retrying the final import read through
    rate limits — read the failure with ``get_import(import_id)``. Rare by
    construction: the server settles a publish at import COMPLETED
    (COMPLETED means the version is READY under build-then-READY), so the
    settle phase normally confirms in one read; the timeout exists for a
    mid-deploy older server still finishing a version after COMPLETED.

    NOT an :class:`EvolveAPIError`: no request failed — the caller's wait
    could not be honestly satisfied. Carries the last observed version
    ``state`` so a handler can say exactly where the publish stands.
    """

    def __init__(
        self,
        code: str,
        message: str,
        *,
        import_id: str,
        dataset: str,
        version: str,
        state: Optional[str],
    ):
        super().__init__(message)
        #: The named cause; 'settle_timeout' is the only one.
        self.code = code
        #: The import job whose version did not settle.
        self.import_id = import_id
        #: The dataset the import published into.
        self.dataset = dataset
        #: The version the import created.
        self.version = version
        #: The last observed version state; None when the version was never
        #: observed.
        self.state = state


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
class DatasetManifestAuthor:
    """One dataset.toml author: a name, and an email when the manifest gives one."""
    name: str
    email: Optional[str] = None


@dataclass
class DatasetManifestMetadata:
    """The metadata half of the Harbor dataset.toml a version imported under.

    The full manifest additionally pins per-task/per-file content digests —
    verified server-side at import (a mismatch FAILS the import,
    ``manifest_digest_mismatch``) and readable in the retained package; the
    wire carries identity + metadata. ``name`` is the manifest's own dataset
    name in Harbor ``org/name`` format; ``task_count`` counts the manifest's
    ``[[tasks]]`` refs (duplicates included) and is ``None`` on rows stored
    before the count was recorded.
    """
    name: str
    version: Optional[str] = None
    description: str = ''
    authors: List[DatasetManifestAuthor] = field(default_factory=list)
    keywords: List[str] = field(default_factory=list)
    task_count: Optional[int] = None


@dataclass
class DatasetVersionSource:
    """One version's git provenance.

    The repository, the ref exactly as requested, the RESOLVED commit the
    clone landed on (for an annotated tag, the peeled commit — never the tag
    object), and the repository subfolder the corpus was read from. Served on
    EVERY git-imported version whatever its state — a version whose build
    FAILED can never become the active version, so this is where its
    imported bytes stay observable.
    """
    #: The ref the import was asked for, exactly as requested: a sha, a tag,
    #: or (legacy rows) a branch.
    ref: str
    #: The commit the corpus was actually read from — the resolved sha,
    #: peeled for an annotated tag.
    commit: str
    #: The repository this version was imported from, userinfo (an embedded
    #: token) stripped; ``None`` only when the stored url cannot be parsed.
    git_url: Optional[str] = None
    #: The repository subfolder the corpus was read from; ``None`` =
    #: repository root.
    path: Optional[str] = None


@dataclass
class TaskBuildFailure:
    """Why one task FAILED its independent build — the ONE failure grammar
    for every step: parse-level refusals (schema/capability) and build-level
    failures (image build, mirror, compose resolution, image-config read,
    skills verification) speak it identically.
    """
    #: Typed reason. Parse refusals record ``task_parse_failed``; build steps
    #: record the builder's own family (``image_build_failed``,
    #: ``builder_unavailable``, ...). Open set — render the string; branch on
    #: ``step`` for coarse grouping.
    code: str
    #: The build step that failed: ``parse``, ``image-build``,
    #: ``image-config``, ``skills-verify``, ``compose-resolve``,
    #: ``image-mirror``, or ``store``.
    step: str
    #: The failure sentence, naming the task's own defect.
    message: str
    #: Bounded tail of the failing step's build log (the failing line and its
    #: neighbourhood). Served by the per-task build route
    #: (:meth:`DatasetsClient.get_task_build`); list surfaces omit it. None
    #: when the step produced no log to excerpt (a parse refusal's message IS
    #: the whole story).
    excerpt: Optional[str] = None


@dataclass
class TaskBuild:
    """One task's build outcome inside one published version — the
    failure-detail read (:meth:`DatasetsClient.get_task_build`, the
    partial-publish model). READY tasks answer too (failure and log pointer
    None), so a poller needs no negative-space reasoning.
    """
    task_name: str
    #: ``"READY"`` or ``"FAILED"`` — the per-task member of the
    #: DatasetVersionState family. No per-task "building" state exists on the
    #: wire: outcomes are recorded only when the version settles.
    state: str
    #: The typed reason WITH the failing-step excerpt; None on READY.
    failure: Optional[TaskBuildFailure] = None
    #: Pointer to the FULL build log of the failing step
    #: (``cloudwatch://<group>/<stream>`` for image builds), for operators
    #: and support tooling. None when the failing step kept no separate log
    #: (parse refusals), and on READY tasks.
    build_log_ref: Optional[str] = None


@dataclass
class DatasetFailedTask:
    """One failed task on the dataset detail's ``failed_tasks`` list: the
    compact typed reason. The failing-step excerpt and build-log pointer live
    on the per-task build route (:meth:`DatasetsClient.get_task_build`).
    """
    task_name: str
    failure: TaskBuildFailure


@dataclass
class DatasetVersion:
    """One immutable version of a dataset — one shape on every surface."""
    version: str
    state: str
    created_at: str
    #: The READY (runnable) tasks of this version. Under the partial-publish
    #: model this is what a whole-dataset job runs.
    task_count: int
    #: Tasks of the published corpus that FAILED their independent build and
    #: are therefore not runnable in this version (the partial-publish
    #: model). 0 on a fully built version — and on servers that predate the
    #: field. The names and reasons are on the dataset detail's
    #: ``failed_tasks``; the full per-task detail (excerpt + build-log
    #: pointer) answers at :meth:`DatasetsClient.get_task_build`. Fixing one
    #: is a re-publish — versions are immutable.
    n_failed_tasks: int = 0
    #: The dataset.toml identity/metadata this version imported under.
    #: ``None`` when the corpus carried no manifest, and on servers that
    #: predate the field — absence is "nothing to report", never a crash.
    manifest: Optional[DatasetManifestMetadata] = None
    #: What THIS version was imported from — git only. ``None`` when the
    #: version was not imported from a git remote (an uploaded tarball, a
    #: seeded directory, a pre-provenance row), and on servers that predate
    #: the field — never a fabricated value.
    source: Optional[DatasetVersionSource] = None


@dataclass
class TaskProviderVerdict:
    """One provider's verdict for a task: runnable (ok), refused with the
    limitation named, or — GPU tasks only — runnable via a recorded DEGRADE:
    ``ok`` True with ``degrades_to`` ``"modal"`` means a job stamped on this
    provider still runs the task, on modal, and the trial records the same
    fact as ``sandbox_provider_degrade``; ``reason`` then carries this
    provider's own sentence for why it could not serve the GPUs itself."""
    ok: bool
    reason: Optional[str] = None
    degrades_to: Optional[str] = None


@dataclass
class Task:
    """Public task fields only — instructions/environments/tests never leave the server.

    ``providers`` maps each sandbox provider to a :class:`TaskProviderVerdict`.
    Advisory for choosing a job's provider — creating a job whose tasks include
    one refused on the chosen provider is rejected with the same reason, so
    nothing is ever spent on a trial that cannot execute.

    ``gpus``/``gpu_types`` are the task's declared GPU requirement (Harbor's
    task fields honored verbatim): 0 = a CPU task; ``gpu_types`` None = any
    type is acceptable (always None when ``gpus`` is 0).
    """
    task_name: str
    agent_timeout_sec: float
    verifier_timeout_sec: float
    providers: Dict[str, TaskProviderVerdict]
    gpus: int = 0
    gpu_types: Optional[List[str]] = None


@dataclass
class TaskPage:
    """One page of a dataset version's tasks — paged like every collection,
    because a SWE-bench-scale dataset has thousands of them."""
    items: List[Task]
    next_cursor: Optional[str]
    has_more: bool


@dataclass
class UpstreamStatus:
    """The active version's git provenance, plus the watch on a ref that can
    move.

    The provenance half — ``git_url`` + the requested ``ref`` + the resolved
    commit (``current_commit``) + the repository subfolder (``path``) — says
    what the active version was built from. The watch half (``latest_commit``,
    ``moved``, ``checked_at``, …) is the data behind a "new version available"
    badge; on a version pinned to a commit sha it stays at rest (None / False),
    because a pin cannot move and nothing checks one.

    Nothing here imports anything by itself — a new version is always a row you
    create, or ``auto_import`` creates.
    """
    #: The ref the active version was imported from, exactly as requested.
    ref: str
    #: The commit the active version was built from (the resolved sha).
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
    #: The repository the active version was imported from, userinfo (an
    #: embedded token) stripped. None on an older server or an unparseable url.
    git_url: Optional[str] = None
    #: The repository subfolder the corpus was read from; None = the
    #: repository root (or an older server).
    path: Optional[str] = None
    #: The newest commit a local version already exists for, whether or not it
    #: is the active one; None before any import recorded one (or an older
    #: server).
    acked_commit: Optional[str] = None


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
    #: The dataset's NEWEST version row (newest ``created_at`` first, id as
    #: the tiebreak) -- active or not. This is what makes a publish
    #: observable BEFORE it lands: a first publish walks IMPORTING ->
    #: BUILDING here while ``active_version`` is still None -- the importer
    #: itself flips the finished build to READY and, on an owner-stamped
    #: dataset, promotes it to the active version in the same transaction. It
    #: can also hold a version that never landed (a FAILED build), so it is
    #: NOT a substitute for ``active_version``: a bare-name job ref still
    #: resolves the active version and refuses without one. None when the
    #: dataset has no version rows at all, and on an older server.
    latest_version: Optional[DatasetVersion] = None
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
    #: The selected version's tasks that FAILED their independent build
    #: (get() only; the partial-publish model). Always present on the detail
    #: body — empty on a fully built version. Ordered by task name and capped
    #: at the task page limit; ``n_failed_tasks`` on the version object is
    #: always the exact count. Each entry carries the typed reason; the
    #: failing-step excerpt and build-log pointer live on
    #: :meth:`DatasetsClient.get_task_build`. None on list rows (and on an
    #: older server) — never a crash.
    failed_tasks: Optional[List[DatasetFailedTask]] = None
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


#: The ``effort_support`` vocabulary, as one runtime tuple so the contract
#: drift gate can hold it to the spec's enum — and so a caller can narrow an
#: unknown string. The server serves exactly these members.
EFFORT_SUPPORT_VALUES = ('level', 'binary', 'none')

#: What an agent does with ``agents[].reasoning_effort`` — see
#: :attr:`AgentCapability.effort_support`.
EffortSupport = Literal['level', 'binary', 'none']


@dataclass
class AgentModelOption:
    """One model alias an agent offers, for a picker's option list."""
    alias: str
    model_id: str
    description: Optional[str] = None


@dataclass
class AgentCapability:
    """One built-in agent's declared capabilities."""
    name: str
    #: What this agent does with ``agents[].reasoning_effort``:
    #: ``'level'`` — the value reaches the agent CLI as a level;
    #: ``'binary'`` — thinking on/off only, a level outside
    #: ``limits['job']['binary_effort_values']`` is refused at create;
    #: ``'none'`` — no effort input at all, naming one is refused at create.
    #: Anything this SDK does not recognize maps to ``'none'`` (fail closed).
    effort_support: EffortSupport
    #: Whether job ``agents[].version`` may pin this agent.
    version_pinnable: bool
    #: False = registered but the agent phase must refuse it; ``reason`` says why.
    runnable: bool = True
    #: Why not, when ``runnable`` is False. None otherwise.
    reason: Optional[str] = None
    #: What the evolve SDK runs when no model is named. This API REQUIRES an
    #: explicit model, so treat it as the sensible pre-selection for a picker —
    #: the server never fills it in for you.
    default_model: Optional[str] = None
    #: Known model aliases for this agent — the picker's option list.
    models: List[AgentModelOption] = field(default_factory=list)
    #: The pinned default stored when a create request omits the effort;
    #: None for ``effort_support`` ``'none'``.
    default_effort: Optional[str] = None
    #: Newest published version, for a "your pin is out of date" badge. None
    #: means "not known right now", never "up to date".
    latest_version: Optional[str] = None
    #: Whether job ``agents[].kwargs['config']`` reaches this agent — native
    #: agent-settings support (Harbor's SUPPORTS_CONFIG). Declaring a config
    #: for an agent without it is refused ``agent_config_unsupported``.
    supports_config: bool = False
    #: The named settings presets this agent can guarantee ('no-internet',
    #: 'pinned-context'). Declaring ``agents[].preset`` outside this list is
    #: refused ``agent_preset_unsupported``. Empty on older servers.
    presets: List[str] = field(default_factory=list)


@dataclass
class ProviderCapability:
    """One sandbox provider, its ceilings, and what it refuses.

    ``gpus`` (a dict with the wire's own keys: supported / max_gpus /
    degrades_to / reason / source) states this provider's GPU capability
    right now; None on servers predating the field.
    """
    name: str
    default: bool
    sizing: Dict[str, Any]
    refuses: List[Dict[str, str]]
    gpus: Optional[Dict[str, Any]] = None


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
    #: Fleet-wide cap on concurrently in-flight trials of GPU-declaring tasks
    #: (platform-paid GPU compute). None on servers predating the field.
    gpu_concurrency_cap: Optional[int] = None


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
class SkillLock:
    """Provenance of one skill an arm's runs actually mounted.

    Harbor's AgentSkillLock vocabulary: name, pinned source reference, content
    digest (Harbor's recipe over the skill folder), and for git-backed skills
    the repo URL and exact commit.
    """
    name: str
    source: str
    digest: str
    git_url: Optional[str] = None
    git_commit_id: Optional[str] = None


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

    ``kwargs`` is Harbor's ``--ak`` channel in its wire shape. The one key
    this platform delivers is ``config``: an INLINE settings dict converted
    into the harness's native settings document inside the sandbox (the user
    document is the base; platform routing is stamped on top). It is part of
    the arm's identity — the same agent and model with two configs are two
    arms. Acceptance is typed, never silent: an unrecognized kwarg key is
    ``agent_kwarg_unsupported``, ``config`` for an agent without
    :attr:`AgentCapability.supports_config` is ``agent_config_unsupported``,
    and a config key touching billing, base URLs, routing, or env is
    ``agent_config_key_refused``. Pass a dict, not a path — the server never
    reads a client path (the CLI's ``--ak config=<path>`` resolves the file
    client-side the same way).

    ``preset`` names a platform-authored settings bundle delivered through
    the same channel and stamped ON TOP of the user document:
    ``'no-internet'`` (vendor server-side web tools off — Claude settings
    deny WebSearch/WebFetch, Codex ``-c web_search=disabled``) or
    ``'pinned-context'`` (one fixed effective context window). Part of the
    arm's identity. A preset the agent cannot guarantee (see
    :attr:`AgentCapability.presets`) is refused ``agent_preset_unsupported``,
    never half-applied.
    """
    name: str
    model_name: str
    version: Optional[str] = None
    reasoning_effort: Optional[str] = None
    kwargs: Optional[Dict[str, Any]] = None
    preset: Optional[str] = None
    #: Skill references mounted into every run of this arm — Harbor's
    #: trial-config shape: a list of source strings. Accepted forms:
    #: ``skills.sh/<owner>/<repo>[/<skill>]``, ``org/repo[@ref]``, an https
    #: git URL, ``upload:<id>`` naming an uploaded skill (see
    #: :class:`SkillsClient`), or ``name:<skill-name>`` — the caller's moving
    #: name pointer, resolved SERVER-SIDE at creation to its current record
    #: and pinned as that record's ``upload:<id>`` (unknown names are the
    #: typed ``skill_name_not_found``; the SDK passes the string through).
    #: Git references are pinned to their exact commit
    #: at job creation and echoed back in pinned spelling; part of the arm's
    #: identity. Raw filesystem paths are refused by the server — upload the
    #: folder first.
    skills: List[str] = field(default_factory=list)
    #: What actually mounted (one lock per skill), stamped when the arm's
    #: first trial resolves its skills; None until then. Echo-only.
    skill_locks: Optional[List[SkillLock]] = None

    def _to_wire(self) -> Dict[str, Any]:
        result: Dict[str, Any] = {'name': self.name, 'model_name': self.model_name}
        if self.version is not None:
            result['version'] = self.version
        if self.reasoning_effort is not None:
            result['reasoning_effort'] = self.reasoning_effort
        if self.kwargs is not None:
            result['kwargs'] = self.kwargs
        if self.preset is not None:
            result['preset'] = self.preset
        if self.skills:
            result['skills'] = list(self.skills)
        # skill_locks are provenance the SERVER stamps; never sent.
        return result


@dataclass
class ReportedTotals:
    """The job-level sum of the trials' ``upload.reported_agent_result``
    figures — the uploader's own claims aggregated once at ingest, REPORTED
    like their per-trial parts and never entering the platform-metered
    fields (``stats['cost_usd']`` and the token stats stay None for an
    uploaded job). Each total sums the trials that reported that field and
    is None when none did (a zero would be a claim); ``n_trials_reporting``
    counts the trials that carried any reported figure, against the job's
    ``n_total_trials`` — the honesty note for a partially reporting
    archive."""
    cost_usd: Optional[float]
    n_input_tokens: Optional[int]
    n_cache_tokens: Optional[int]
    n_output_tokens: Optional[int]
    n_trials_reporting: int


@dataclass
class UploadProvenance:
    """Provenance of an UPLOADED job (:meth:`JobsClient.upload`) — what the
    archive's own record files said about themselves: the job id its
    result.json carried and the job_name its config.json carried (each None
    when the file did not state one — never fabricated), when the platform
    ingested it, and the job-level sum of the trials' REPORTED figures
    (:class:`ReportedTotals`). The platform-minted row ids replace the
    archive's ids everywhere else on the surface; these fields are where the
    originals remain readable. ``Job.upload`` is None on every job this
    platform executed; non-None marks a terminal RECORD — resume, retry and
    regrade refuse it (``job_uploaded``), analyze works on it unchanged.
    """
    original_job_id: Optional[str]
    original_job_name: Optional[str]
    uploaded_at: str
    #: The aggregated REPORTED figures, or None on jobs ingested before the
    #: field existed.
    reported_totals: Optional[ReportedTotals]


@dataclass
class JobDeleteResult:
    """The deletion receipt of ``DELETE /api/jobs/{jobId}``: what was
    destroyed. The contract's own minimal shape — Harbor's hub delete
    answers no wire body, so there was no shape to mirror.
    ``trials_deleted`` counts the trial rows destroyed with the job (their
    trace events, attempts and stored trace objects went with them);
    ``analyses_deleted`` the trial-analysis rows, their stored analyzer
    streams included.
    """
    job_id: str
    trials_deleted: int
    analyses_deleted: int


@dataclass
class SourceJob:
    """Provenance of a derived job.

    ``action='regrade'`` = verifier-only re-run of the source;
    ``action='resume'`` = new job over the source's failed and stopped
    trials; ``action='retry'`` = manual retry — new job over caller-SELECTED
    source trials (explicit ids, failed-only, or the whole job). ``type`` is
    always ``'hub'`` on this hosted surface.
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


class AgentDatasetStats(TypedDict, total=False):
    """Per-(agent, model, dataset) statistics — one ``stats['evals']`` group.

    The evals key format is ``{agent}__{model}__{dataset}`` — the dataset ref
    is always the LAST ``__`` segment, which is where Harbor-compatible
    readers recover it — with the platform extension of an ``__{effort}``
    segment inserted BEFORE the dataset when a declared reasoning effort is
    part of the arm identity: ``{agent}__{model}__{effort}__{dataset}``.

    A ``TypedDict``: at runtime this IS the plain wire dict, read by key like
    always — the class only teaches type checkers the keys. Every key is
    optional, like the TypeScript interface's ``?`` fields.
    """
    #: Trials that produced a rewards map — rewarded, not merely settled.
    n_trials: int
    #: Trials carrying ``exception_info`` — indeterminate and cancelled included.
    n_errors: int
    #: Metric results (a mean entry per arm today: the primary reward averaged
    #: over EVERY trial of the group, unrewarded trials counting 0); open objects.
    metrics: List[Dict[str, Any]]
    #: pass@k for this group, k (as a string — JSON object keys always are) to
    #: a value in [0, 1]; ``{}`` when the group cannot answer. Read it with
    #: :func:`pass_at_k`, which returns sorted numeric points.
    pass_at_k: Dict[str, float]
    #: reward key -> reward value -> trial identifiers.
    reward_stats: Dict[str, Dict[str, List[str]]]
    #: exception type -> trial identifiers.
    exception_stats: Dict[str, List[str]]


class JobStats(TypedDict, total=False):
    """Aggregate statistics of a job. Progress counters, token totals, and
    measured cost. The ``n_*`` counters are CUMULATIVE, Harbor-style: errored
    trials are a subset of completed, cancelled a subset of errored — a
    cancelled trial counts in all three. The disjoint per-status breakdown
    rides ``Job.trials.by_status``. ``cost_usd`` is what the trials actually
    spent so far — reporting, never a gate (enforcement is the per-trial cap).

    A ``TypedDict``: at runtime this IS the plain wire dict, read by key like
    always (``stats.get('cost_usd')``, ``stats['evals']``) — the class only
    teaches type checkers the keys. Every key is optional, like the
    TypeScript interface's ``?`` fields.
    """
    #: Cumulative: every trial that produced a result — errored and cancelled included.
    n_completed_trials: int
    #: Cumulative: every completed trial carrying ``exception_info``, cancelled included.
    n_errored_trials: int
    n_running_trials: int
    n_pending_trials: int
    #: A subset of ``n_errored_trials``.
    n_cancelled_trials: int
    n_retries: int
    #: Keyed ``{agent}__{model}__{dataset}`` — dataset ref last, optional
    #: effort segment before it.
    evals: Dict[str, AgentDatasetStats]
    #: Total input tokens (cache included); None until recorded.
    n_input_tokens: Optional[int]
    n_cache_tokens: Optional[int]
    n_output_tokens: Optional[int]
    #: Measured spend across settled trials — the WHOLE model bill, agent and
    #: judge together; None before any settled.
    cost_usd: Optional[float]
    #: Sum of the job's per-trial GPU compute ESTIMATES (each trial's
    #: ``gpu_cost['estimate_usd']``) — a SEPARATE labeled figure, never merged
    #: into ``cost_usd`` (metered model spend). None when no trial of the job
    #: carries an estimate; a real $0 (a GPU trial that provably never booted
    #: a sandbox) keeps the sum non-None.
    gpu_cost_usd: Optional[float]
    #: The judge share of ``cost_usd``, itemized: what the trials'
    #: verifier-phase judge keys spent. 0 for a job with no judge-enabled
    #: tasks; None before anything settled, like ``cost_usd``.
    judge_cost_usd: Optional[float]
    #: HOW MANY SETTLED TRIALS ``cost_usd`` CANNOT ACCOUNT FOR — trials whose
    #: ``spend_source`` lane is ``'assumed_cap'``, meaning nobody ever
    #: measured their gateway spend. Such a trial stores 0, and the job total
    #: is the sum of its trials, so each one folds a zero in and ``cost_usd``
    #: comes out LOWER than what was really spent. A plain count, never None:
    #: before anything settles it is honestly 0, where ``cost_usd`` is None.
    #: It is a FLOOR — a retried-away attempt's lineage snapshot keeps no
    #: spend-source column, so an earlier attempt nobody measured cannot be
    #: counted here.
    n_unmeasured_trials: int
    #: The judge half of the same fact, itemized the way ``judge_cost_usd``
    #: itemizes ``cost_usd``: trials that ran a judge whose spend was never
    #: measured (``judge_spend_source`` ``'assumed_cap'``). 0 on jobs with no
    #: judge-enabled tasks.
    n_unmeasured_judge_trials: int
    #: Aggregate of the job's trace analyses; None when no trial of this job
    #: has ever been analyzed. Never a fabricated empty object — absence of
    #: analysis is stated as None, here and on each trial.
    analysis: Optional['JobAnalysisStats']


class JobRetryConfigInput(TypedDict, total=False):
    """Auto-retry policy INPUT — ``jobs().start(retry=...)``, the spec's
    ``RetryConfigInput`` schema, Harbor's RetryConfig vocabulary verbatim.

    ONE NAMING NOTE: Harbor, the spec, and the TypeScript SDK call this pair
    ``RetryConfig`` / ``RetryConfigInput``. The Python SDK exports them as
    ``JobRetryConfig`` / ``JobRetryConfigInput`` because ``evolve.RetryConfig``
    already names the Swarm client-side retry helper (``max_attempts``,
    ``backoff_ms``, ...) — two unrelated shapes never share one exported name.

    A ``TypedDict``: pass the plain dict you always passed — the class only
    teaches type checkers the keys. Every key is optional, and an omitted key
    takes Harbor's own default with ONE named deviation: ``max_retries``
    omitted takes the PLATFORM fleet default (published as
    ``limits['job']['default_max_retries']`` on ``meta()``; 2 unless the
    operator tuned it) rather than Harbor's 0 — infrastructure errors on a
    hosted fleet retry automatically. Send ``{'max_retries': 0}`` to turn
    retries off.

    Inside the policy, an EXPLICIT ``'exclude_exceptions': None`` is not the
    same as leaving the key out: None turns exclusions off entirely (Harbor's
    own None semantics), while an omitted key keeps Harbor's default
    non-retryable set. ``include_exceptions`` has no such split: None, an
    omitted key, and ``[]`` all mean no filter.
    """
    #: Maximum automatic retries per trial (0-10). Omitted = fleet default; 0 = off.
    max_retries: int
    #: Exception types to retry on. None, omitted, or ``[]`` = no filter.
    include_exceptions: Optional[List[str]]
    #: Exception types to NOT retry on; wins over ``include_exceptions``.
    #: Omitted = Harbor's default non-retryable set; an EXPLICIT None turns
    #: exclusions off entirely.
    exclude_exceptions: Optional[List[str]]
    #: Multiplier for exponential backoff wait time (default 1.0).
    wait_multiplier: float
    #: Minimum wait in seconds between retries (default 1.0).
    min_wait_sec: float
    #: Maximum wait in seconds between retries (default 60.0; platform cap 3600).
    max_wait_sec: float


# One attached env secret — ``jobs().start(secrets=[...])``, the spec's
# JobSecretRef schema: a REFERENCE to a stored env secret of the caller's
# (Secrets surface), by name and optional label, with an optional in-sandbox
# rename — values never ride the wire on a reference. Functional TypedDict
# form because ``as`` is a Python keyword; pass the plain dict either way.
# Resolution law (the 'default'-label fallback, the typed
# ``secret_ambiguous`` refusal, the reserved-name refusals, the typed
# ``secret_brokered_unsupported`` refusal for brokered-delivery secrets) is
# the server's — see ``start()``.
JobSecretRef = TypedDict(
    'JobSecretRef',
    {'name': str, 'label': str, 'as': str},
    total=False,
)


# One INLINE env secret — the spec's JobSecretInline schema: the convenience
# door into the same vault, not a second wire shape for values. The server
# saves ``value`` as a normal env secret first (``delivery`` REQUIRED —
# 'brokered' or 'direct', no silent default; ``label`` defaults to
# 'default') and the job then stores only the reference — the stored job
# never contains a value. A (name, label) identity that already exists
# splits on proof: an entry restating the stored row byte-for-byte (same
# value, same delivery) attaches it exactly like a reference — a network
# retry of the same request converges instead of colliding with its own
# first attempt — while a different value or delivery is the typed
# ``secret_exists`` refusal (attach by reference or pick a label — never a
# silent overwrite); ``delivery='brokered'`` refuses as
# ``secret_brokered_unsupported`` until eval trials can broker.
JobSecretInline = TypedDict(
    'JobSecretInline',
    {'name': str, 'value': str, 'delivery': str, 'label': str, 'as': str},
    total=False,
)


class RubricCriterion(TypedDict):
    """One analysis criterion — Harbor's RubricCriterion verbatim (their
    cli/quality_checker/models.py ``{name, description, guidance}``). The
    name becomes the key of the matching entry in ``checks``; the guidance is
    what the analyzer agent is instructed with. A plain dict at runtime, like
    every wire shape here.
    """
    #: Criterion identifier, snake_case (it keys the result's ``checks``).
    #: Harbor's defaults are ``reward_hacking`` and ``task_specification``.
    name: str
    #: What the criterion evaluates, one sentence.
    description: str
    #: Evaluation guidance handed to the analyzer agent — what evidence to
    #: read and what PASS / FAIL / NOT_APPLICABLE mean for this criterion.
    guidance: str


class Rubric(TypedDict):
    """An analysis rubric — Harbor's Rubric shape (``{criteria: [...]}``,
    their cli/quality_checker/models.py). The criteria set is FROZEN into
    each analysis at enqueue: the stored result is validated against exactly
    this set — a missing or extra criterion is a stored typed failure, never
    a partial pass.
    """
    criteria: List[RubricCriterion]


class AnalyzeConfigInput(TypedDict, total=False):
    """Trace-analysis configuration INPUT — Harbor's ``harbor analyze``
    vocabulary (their cli/analyze.py: ``--model``, ``--rubric``), the spec's
    ``AnalyzeConfigInput`` schema.

    PRESENCE of this object is the switch: on ``jobs().start(analyze=...)``
    it arms the embedded trigger (each trial is analyzed server-side right
    after it settles; CANCELLED trials are skipped); ``{}`` is legal and
    means "all defaults" — glm-5.3-flash over Harbor's default rubric
    (reward_hacking, task_specification). The analyzer always runs the
    claude-code harness in its own sealed sandbox — on the provider
    ``sandbox_provider`` names, or the platform's analysis default when it
    names none; its spend is capped per analysis and metered as its own
    line, never blended into the trial's own bill.
    """
    #: Model the analyzer agent runs — Harbor's ``--model``; the default is
    #: glm-5.3-flash on this platform's claude roster (a recorded deviation
    #: from Harbor's claude-haiku-4-5 default — analysis is input-dominated,
    #: and flash is the input-price frontier; name glm-5.3 to escalate).
    #: Same vocabulary as ``agents[].model_name``: either advertised
    #: spelling is accepted and stored as given (the default is the roster
    #: alias); stored analyses serve the spelling they were created under.
    #: Off-roster models are refused typed (``invalid_input``).
    model_name: str
    rubric: Rubric
    #: The provider whose sandbox the analyzer boots — the job lineup, the
    #: same vocabulary as ``sandbox_provider`` on ``jobs().start()`` and held
    #: to the same rule: an unknown value is refused ``invalid_input`` naming
    #: the lineup. Stored as given and honored wherever this config enqueues
    #: an analysis. Omitted, the platform's analysis default applies at each
    #: enqueue (daytona unless the operator retuned the fleet) — the value
    #: the resolved ``AnalyzeConfig['sandbox_provider']`` echo reports.
    sandbox_provider: EvalSandboxProvider


class AnalyzeConfig(TypedDict):
    """The RESOLVED trace-analysis policy — the caller's values or the
    defaults of the day, resolved at accept and stored (same law as
    ``JobRetryConfig``). Echoed as ``Job.analyze`` when the job was created
    with ``analyze``; each analysis additionally carries the exact pair IT
    ran under (``Trial.analysis['model_name']`` / ``['rubric']``), which a
    later manual re-analysis may have changed.
    """
    model_name: str
    rubric: Rubric
    #: The provider this policy's analyses run on. Named at create it is
    #: served as stored, forever. When the create named none, this echoes the
    #: platform's analysis default OF THE DAY — the value the next enqueue
    #: under this policy would stamp — because that default is an operator
    #: fleet knob, resolved where an analysis is actually enqueued rather
    #: than baked into the stored policy (the one deliberate nuance to the
    #: resolved-at-accept law above, stated so the echo is never read as
    #: history).
    sandbox_provider: EvalSandboxProvider


class AnalysisCheck(TypedDict):
    """One criterion's verdict — Harbor's QualityCheckModel verbatim (their
    cli/quality_checker/models.py ``{explanation, outcome}``)."""
    #: ``'pass'`` | ``'fail'`` | ``'not_applicable'``.
    outcome: str
    #: The analyzer's rationale, citing trial evidence.
    explanation: str


class AnalysisFailure(TypedDict):
    """Why an analysis FAILED — a stored typed failure, never a silent
    absence and never a fake pass."""
    #: Which part failed: ``invalid_result`` (the analyzer ran but its
    #: analysis.json failed validation — the message preserves every
    #: validator reason, one per line), ``inputs`` (the trial tree or task
    #: content could not be assembled), or an infrastructure stage of the
    #: analyzer run (``mint_key``, ``boot``, ``harness_install``, ``agent``,
    #: ``artifact_read``, ``lease_expired``, ...).
    phase: str
    message: str


class TrialAnalysis(TypedDict):
    """One trace analysis of a trial — ``Trial.analysis``.

    The result half is Harbor's AnalyzeResult verbatim (their
    analyze/models.py: ``summary``, ``checks`` keyed by criterion,
    ``estimated_cost_usd``; the enclosing trial is Harbor's ``trial_name``);
    the rest is provenance — which model and rubric THIS analysis ran under,
    its lifecycle status, and its typed failure when it failed.

    ``estimated_cost_usd`` is the analyzer agent's OWN metered spend — its
    own line, never part of the trial's ``agent_result.cost_usd`` or the
    job's ``stats['cost_usd']``; the job aggregate is
    ``stats['analysis']['cost_usd']``. None when nothing was measured, never
    a fabricated 0. A plain wire dict at runtime — except ``usage``, which
    the mapper normalizes into the shared
    :class:`evolve.results.UsageReading` by the same one rule the trial's
    own ``usage`` follows.
    """
    id: str
    #: ``'queued'`` | ``'running'`` | ``'completed'`` | ``'failed'``. Every
    #: non-terminal analysis reaches ``completed`` or ``failed``; a worker
    #: death mid-run is reaped to a typed ``failed``.
    status: str
    model_name: str
    rubric: Rubric
    #: 3–5 sentence overview of the trial (Harbor's summary contract). None
    #: until completed.
    summary: Optional[str]
    #: One entry per rubric criterion, keys exactly the rubric's criterion
    #: names (the frozen-criteria law). None until completed.
    checks: Optional[Dict[str, AnalysisCheck]]
    estimated_cost_usd: Optional[float]
    #: The analyzer's one-home usage reading — the SAME shape, same keys, the
    #: trial and session surfaces serve
    #: (:class:`evolve.results.UsageReading`), built from the analyzer's OWN
    #: gateway records. Present and ticking while the analysis runs — a
    #: mid-run reading is a lagging LOWER BOUND, always ``provisional=True``
    #: — and settled by the same read that writes ``estimated_cost_usd``,
    #: which stays Harbor's word for the FINAL figure. None = the meter never
    #: answered, never zero.
    usage: Optional[UsageReading]
    #: Non-None exactly when status is ``'failed'``.
    failure: Optional[AnalysisFailure]
    #: When this analysis was enqueued.
    created_at: str
    #: When it settled; None while queued or running.
    finished_at: Optional[str]


class JobAnalysisStats(TypedDict):
    """The job-level analysis aggregate — ``stats['analysis']``.

    Harbor's job ``analysis.json`` is a flat list of per-trial results
    (their analyze/models.py AnalyzeReport); each trial's own result rides
    ``Trial.analysis``, and this object aggregates them. LATEST-per-trial: a
    re-analyzed trial contributes only its newest analysis, matching Harbor,
    where a re-run overwrites the trial directory's ``analysis.json``.
    """
    #: Trials whose latest analysis produced a valid result.
    n_completed: int
    #: Trials whose latest analysis is a stored typed failure.
    n_failed: int
    #: Trials whose latest analysis is still queued or running.
    n_pending: int
    #: Measured spend of the LATEST analyses summed — the analyzer's own
    #: metered line, never part of ``stats['cost_usd']``. None when no
    #: analysis recorded measured spend.
    cost_usd: Optional[float]
    #: Per-criterion outcome tally over the completed latest analyses, keyed
    #: by criterion name: ``{n_pass, n_fail, n_not_applicable}`` each.
    checks: Dict[str, Dict[str, int]]


class JobRetryConfig(TypedDict):
    """The RESOLVED auto-retry policy a job runs under — the spec's
    ``RetryConfig`` schema, echoed on every job body as ``Job.retry``: the
    caller's values or the defaults of the day, resolved at create and
    stored, so the row always states the policy it executes. Backoff between
    attempts is Harbor's formula:
    min(min_wait_sec x wait_multiplier^attempt, max_wait_sec).

    A ``TypedDict``: at runtime this IS the plain wire dict, read by key like
    always (``job.retry['max_retries']``) — the class only teaches type
    checkers the keys. Every key is REQUIRED, like the spec's own required
    list: the mapper reads an older server that sends no policy as the
    retries-off policy with Harbor's defaults — exactly how such a server
    behaves — so every field is always present.

    Named ``JobRetryConfig`` rather than the spec's ``RetryConfig`` because
    ``evolve.RetryConfig`` is the (unrelated) Swarm retry helper — see
    :class:`JobRetryConfigInput` for the input half and the naming note.
    """
    max_retries: int
    #: None = no include filter (everything the exclude set admits).
    include_exceptions: Optional[List[str]]
    exclude_exceptions: List[str]
    wait_multiplier: float
    min_wait_sec: float
    max_wait_sec: float


@dataclass
class JobBuildExclusion:
    """One dataset of a job whose selection excluded tasks that FAILED to
    build (the partial-publish model). ``note`` is the sentence to show, and
    the structured fields beside it are the same fact for a UI:
    ``n_tasks_selected`` is how many READY tasks the caller's filters matched
    BEFORE any ``n_tasks`` cap, ``n_tasks_ran`` how many the job actually ran
    from this dataset (fewer than ``n_tasks_selected`` only under an
    ``n_tasks`` cap), and ``n_tasks_failed_to_build`` what the filters would
    have taken but the build lost. Uncapped, the note reads "ran N of M tasks
    — K failed to build" with M = n_tasks_selected + K; capped it reads
    "selection matched M tasks: K failed to build: …; ran R (n_tasks cap)" —
    the run was short for two separate reasons and the sentence keeps them
    apart. ``failed_task_names`` names every one, sorted; the reasons live on
    the dataset's ``failed_tasks`` and the per-task build route
    (:meth:`DatasetsClient.get_task_build`). (Jobs recorded before
    ``n_tasks_selected`` existed answer it as ``n_tasks_ran`` — read as
    uncapped.)
    """
    dataset: DatasetRef
    n_tasks_ran: int
    n_tasks_selected: int
    n_tasks_failed_to_build: int
    failed_task_names: List[str]
    note: str


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
    #: The most this job can cost: every trial spending its whole cap on every
    #: attempt the retry policy allows — cap x trials x
    #: (retry['max_retries'] + 1), since each attempt is minted its own full
    #: cap. There is no job-wide budget, so this product is the real ceiling.
    worst_case_spend_usd: float
    #: The RESOLVED auto-retry policy this job runs under — Harbor's
    #: RetryConfig field names (``max_retries``, ``include_exceptions``,
    #: ``exclude_exceptions``, ``wait_multiplier``, ``min_wait_sec``,
    #: ``max_wait_sec``). Still the plain wire dict at runtime, read by key —
    #: :class:`JobRetryConfig` types the keys, and every field is ALWAYS
    #: present: an older server that sends no policy reads as the retries-off
    #: policy with Harbor's defaults, exactly how such a server behaves.
    retry: JobRetryConfig
    #: The resolved embedded-analysis policy the job was created with; None
    #: when the create named none (a later manual :meth:`JobsClient.analyze`
    #: does not rewrite it — the job row states what the CREATE asked for,
    #: each analysis states what IT ran under). Always None on a regrade job.
    analyze: Optional[AnalyzeConfig]
    #: The RESOLVED timeout multipliers this job's phases arm under —
    #: Harbor's five flat JobConfig fields, echoed on every job body. The
    #: global one is always a number (1.0 when the create request named
    #: none); each phase field below is None when not overridden, meaning the
    #: global one applies to that phase.
    timeout_multiplier: float
    agent_timeout_multiplier: Optional[float]
    verifier_timeout_multiplier: Optional[float]
    agent_setup_timeout_multiplier: Optional[float]
    environment_build_timeout_multiplier: Optional[float]
    #: Where this job's trials execute. None exactly on an UPLOADED job
    #: (``upload`` non-None): an ingested record never executed on any
    #: platform sandbox, and naming a provider would be an execution claim.
    #: Never None on a job this platform ran.
    sandbox_provider: Optional[EvalSandboxProvider]
    counts: JobCounts
    #: THE RESULTS-HONESTY LABEL of the partial-publish model: one entry per
    #: dataset of this job whose selection excluded tasks that FAILED to
    #: build — a whole-dataset (or glob) run over a partially built version
    #: runs the READY tasks, and this field is where the job says so plainly
    #: instead of silently truncating. Always present; empty when nothing was
    #: excluded. Recorded at create and immutable; derived jobs
    #: (resume/retry) answer empty — their honesty lives on the source job.
    build_exclusions: List[JobBuildExclusion]
    n_total_trials: int
    #: The zeros-included 8-status histogram, beside the coarser counters in
    #: ``stats``.
    trials: TrialTally
    #: Aggregate statistics (progress counters, token totals, ``cost_usd`` —
    #: measured spend, never a gate; ``gpu_cost_usd`` — the SEPARATE summed
    #: GPU compute estimate, never merged into ``cost_usd``; ``evals`` keyed
    #: ``agent__model__dataset``, each group carrying its mean and its
    #: ``pass_at_k`` — read the latter with :func:`pass_at_k`).
    #: Still the plain wire dict at runtime, read by key, never constructed —
    #: :class:`JobStats` types the keys so ``stats['evals']`` and friends
    #: check instead of being ``Any``.
    stats: JobStats
    #: Why the job FAILED, or None.
    failure: Optional[JobFailure]
    #: Provenance of a derived job; empty for an original one.
    source_jobs: List[SourceJob]
    #: Derived: any source_jobs entry with action "regrade".
    is_regrade: bool
    #: The upload provenance echo — None for every job this platform
    #: executed, non-None only on a job ingested by :meth:`JobsClient.upload`.
    upload: Optional[UploadProvenance]
    #: True when the server replayed an existing job for this Idempotency-Key.
    idempotent_replay: bool
    started_at: str
    updated_at: str
    #: None while the job is live.
    finished_at: Optional[str]


@dataclass
class PassAtKPoint:
    """One pass@k number: the estimate over ``k`` attempts."""
    #: How many attempts the estimate is over — always 2 or more.
    k: int
    #: Probability that k attempts contain at least one success, in [0, 1].
    value: float


@dataclass
class PassAtKGroup:
    """One evals group's pass@k curve, ready to plot or print."""
    #: The ``stats['evals']`` key these numbers belong to.
    evals_key: str
    #: Ascending by k; never empty (a group with no numbers is not returned).
    points: List[PassAtKPoint]


def pass_at_k(job: Job) -> List[PassAtKGroup]:
    """Read a job's pass@k out of ``stats['evals']``, as numbers.

    The wire keys k as a string (JSON object keys always are); this returns it
    as an int, ascending, per evals group. Groups that cannot answer (empty
    ``pass_at_k`` — rewards that are not binary, no eligible k, or attempts
    still in flight) are left out entirely, so an empty list means "this job
    has no pass@k to show" and the shape is the same whether the job is
    running or finished.

    Pure reading: no request is made and nothing is recomputed. The numbers are
    the platform's, and the same ones the job's download archive carries.

        for group in pass_at_k(job):
            for point in group.points:
                print(group.evals_key, f"pass@{point.k}", round(point.value, 3))
    """
    stats = job.stats if isinstance(job.stats, dict) else {}
    evals = stats.get('evals')
    if not isinstance(evals, dict):
        return []
    groups: List[PassAtKGroup] = []
    for evals_key in sorted(evals):
        entry = evals.get(evals_key)
        raw = entry.get('pass_at_k') if isinstance(entry, dict) else None
        if not isinstance(raw, dict):
            continue
        points: List[PassAtKPoint] = []
        for key, value in raw.items():
            try:
                k = int(key)
            except (TypeError, ValueError):
                continue
            # bool is an int in Python; a boolean here is malformed, not a 1.
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                continue
            points.append(PassAtKPoint(k=k, value=float(value)))
        if not points:
            continue
        points.sort(key=lambda point: point.k)
        groups.append(PassAtKGroup(evals_key=evals_key, points=points))
    return groups


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
class JudgeResult:
    """What the verifier phase's LLM judge consumed — the judge half of a
    trial's model bill.

    A judge-enabled task's verifier holds a DISTINCT short-lived gateway key
    (scoped to the requested credential's model family only, minted at verify
    start, revoked after scoring; judge model selection itself is Harbor-exact
    — the rubric names the model, or rewardkit's own library default applies), and
    these figures are that key's spend and tokens as the platform measured
    them at the gateway — never anything the verifier reported about itself.
    ``cost_usd`` is the judge share alone; ``agent_result.cost_usd`` stays the
    agent's, and the trial's whole bill is the sum. See ``judge_spend_source``
    on the trial for which lane the figure is in.
    """
    n_input_tokens: Optional[int] = None
    n_cache_tokens: Optional[int] = None
    n_output_tokens: Optional[int] = None
    #: None until measured; None never means $0.
    cost_usd: Optional[float] = None


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
class ReportedAgentResult:
    """The uploaded ``agent_result``'s own token and cost figures — the
    archive's claim, served for the reader. Uploader-reported, never
    platform-measured; each field is None when the archive stated nothing."""
    n_input_tokens: Optional[int]
    n_cache_tokens: Optional[int]
    n_output_tokens: Optional[int]
    cost_usd: Optional[float]


@dataclass
class TrialUploadProvenance:
    """What the uploaded archive said about THIS trial: its own ids, the full
    task name verbatim, and the uploader's own usage figures. REPORTED means
    exactly that — ``reported_agent_result`` is the archive's claim; it never
    populates the platform-metered fields (``agent_result``, ``usage``,
    ``spend_source``), which stay None because this platform's meter never
    saw the run."""
    #: The archive trial result.json's own ``id``; None when it stated none.
    original_trial_id: Optional[str]
    #: The archive's own ``trial_name`` (the trial directory).
    original_trial_name: str
    #: The archive's task name VERBATIM — possibly registry-qualified
    #: (``org/name``); the trial's ``task_name`` serves the parsed leaf.
    original_task_name: str
    #: The uploaded figures, or None when the archive carried none.
    reported_agent_result: Optional[ReportedAgentResult]


@dataclass
class Trial:
    """The ONE public trial shape, shared verbatim by list rows and the detail
    route (detail returns ``exception_info.exception_message`` untruncated —
    the only documented difference). A trial id is globally addressable;
    ``job_id`` is the reverse pointer.

    Execution facts (``sandbox_provider``, ``verifier_environment_mode``,
    ``agent_result.cost_usd``, ``spend_source``) are None until the trial has
    actually executed: a QUEUED or CANCELLED trial never ran, so None means
    "did not run" and never zero. An UPLOADED trial (``upload`` non-None)
    keeps them None forever — this platform's meter never saw the run; the
    archive's own reported figures are served under
    ``upload.reported_agent_result`` and nowhere else.
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
    #: The verifier COMMAND window — the graded command alone, and not the work
    #: that prepared it. On a SHARED-mode trial the preparation that runs first
    #: is reported beside this pair as ``shared_verify_setup``. Read this pair
    #: against ``verifier_timeout_sec`` and nothing else.
    verifier: Optional[TimingInfo]
    #: How long the trial sat claimable before a worker began it. It ends at
    #: the run's beginning, which is APPROXIMATELY — not exactly — where
    #: ``environment_setup`` starts, so never treat the two pairs as adjacent.
    #: The open bound is when the row became claimable, which for a retried
    #: trial is its backoff deadline rather than its creation: this never bills
    #: the attempt that failed before it.
    queue_wait: Optional[TimingInfo]
    #: The harness bundle resolve, NESTED inside ``environment_setup``. A miss
    #: that actually BUILT also carries the publish upload back to the shared
    #: bundle store, which the building caller waits out inside this window — a
    #: trial that joined someone else's build, or hydrated the bytes from that
    #: store, pays neither. Read with ``harness_bundle_cache_hit``.
    harness_bundle: Optional[TimingInfo]
    #: The provider image/snapshot/template ensure, also NESTED inside
    #: ``environment_setup`` and excluding the boot that follows it. Near-zero
    #: on modal BY DESIGN — modal pre-builds nothing, so the real
    #: pull-and-cache happens provider-side when the box is created — so never
    #: compare it across providers raw.
    image_prepare: Optional[TimingInfo]
    #: What a SHARED-mode verify did BEFORE its command — the judge key mint,
    #: the rewardkit bundle resolve and upload, the test-file uploads, the env
    #: write. It ends exactly where ``verifier`` begins, and the two never
    #: overlap. ``None`` on separate-mode trials, on multi-step trials (which
    #: verify per step and report no trial-level verifier window), and on
    #: anything that settled before the pair was recorded — never a zero-length
    #: pair standing in for "did not happen".
    shared_verify_setup: Optional[TimingInfo]
    #: ``True`` when the bundle resolve served bytes already on the worker.
    #: ``False`` covers every path that had to produce them — a shared-store
    #: hydrate, a builder run, or joining another trial's in-flight build.
    #: ``None`` is unrecorded (a trial older than these timers, or one whose
    #: resolve failed), never "miss".
    harness_bundle_cache_hit: Optional[bool]
    #: Per-step results for a multi-step task, in execution order. ``None`` on
    #: every single-step trial — "this trial has no steps", never "it ran zero
    #: of them". A trial that stopped early carries only the steps that ran.
    #: Each entry: ``step_name``, ``agent_result``, ``verifier_result``,
    #: ``exception_info``, ``agent_execution``, ``verifier``.
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
    #: GPU degrade record: present ({'from','to','reason'}) when this trial's
    #: task declared GPUs the job's stamped provider could not allocate, so it
    #: ran on modal instead. None on every other trial.
    sandbox_provider_degrade: Optional[Dict[str, str]]
    #: GPU compute ESTIMATE — present on settled GPU trials only, None on
    #: every other trial. Measured agent-sandbox lifetime x the platform's
    #: versioned, source-dated rate card; a SEPARATE labeled figure NEVER
    #: merged into ``agent_result.cost_usd`` (metered model spend). Keys:
    #: ``estimate_usd``/``unpriced_reason`` (exactly one set), ``provider``,
    #: ``gpu_type``, ``declared_gpu_type``, ``gpu_count``, ``duration_sec``,
    #: ``rate_usd_per_gpu_sec``, ``rate_card`` ({version, source,
    #: source_date}), ``measured_from``, ``measured_to``. A GPU trial that
    #: provably never booted a sandbox carries a real ``estimate_usd: 0``.
    gpu_cost: Optional[Dict[str, Any]]
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
    #: Provenance of an UPLOADED trial (its job's ``upload`` is non-None):
    #: the identity and reported figures the archive's own record files
    #: carried (:class:`TrialUploadProvenance`). None for every trial this
    #: platform executed.
    upload: Optional['TrialUploadProvenance']
    started_at: Optional[str]
    finished_at: Optional[str]
    #: Automatic retries this trial consumed (0 = never retried). The trial
    #: body always shows the LATEST attempt; ``retries`` holds the lineage.
    n_retries: int = 0
    #: Attempt lineage: earlier attempts whose failure was retried away,
    #: oldest first — each a :class:`TrialRetry`. The final attempt's outcome
    #: is the trial body itself and is not repeated here.
    retries: List['TrialRetry'] = field(default_factory=list)
    # Declared last (dataclass default-ordering), read beside agent_result:
    #: The judge share of the trial's bill, itemized (see JudgeResult). None
    #: when no judge ever ran — the task requested no judge credential, or the
    #: trial never reached its verify phase. None never means "$0 of judging".
    judge_result: Optional[JudgeResult] = None
    #: Which lane ``judge_result.cost_usd`` is in — the same three-lane
    #: vocabulary as ``spend_source``, same rules. None exactly when
    #: ``judge_result`` is None: no judge ever ran.
    judge_spend_source: Optional[SpendSource] = None
    #: THE ONE-HOME USAGE READING: spend so far plus the token breakdown from
    #: the same gateway records, ``provisional`` saying whether the numbers
    #: can still grow — present and ticking while the trial runs, settled
    #: once the lane is ``measured``. The overlapping fields
    #: (``agent_result`` tokens, ``live_spent_usd``, ``spend_source``) remain
    #: for their existing readers; this is where a caller reads the whole
    #: answer at once, with the same keys the managed-agents session surfaces
    #: serve (:class:`evolve.results.UsageReading`). None = the meter never
    #: answered, never zero.
    usage: Optional[UsageReading] = None
    #: The trial's LATEST trace analysis (:class:`TrialAnalysis`); None when
    #: the trial has never been analyzed — never a fabricated empty object. A
    #: re-analysis (same job, different rubric or model) replaces what this
    #: field serves, matching Harbor, where a re-run overwrites the trial
    #: directory's analysis.json; earlier analyses stay stored as the audit
    #: record.
    analysis: Optional[TrialAnalysis] = None


@dataclass
class TrialRetry:
    """One retired attempt of a trial — the terminal facts preserved when the
    auto-retry scheduler put the trial back on the queue. ``cost_usd`` is REAL
    money the job total includes; the trial's own ``agent_result.cost_usd``
    carries only the final attempt's.
    """
    #: 1-based dispatch number within this trial.
    attempt_number: int
    exception_info: ExceptionInfo
    #: What THIS attempt spent; None when nothing was recorded.
    cost_usd: Optional[float] = None
    #: When the attempt was claimed.
    started_at: Optional[str] = None
    #: When its failure settled (and the retry was scheduled).
    settled_at: Optional[str] = None


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
class JobGrepGroup:
    """One trial's slice of a job-wide grep — jobs().grep().

    ``match_count`` is EXACT and never truncates; ``events`` is the first few
    matching events (the platform caps the sample at 5). The full match list
    of one trial is ``trials().trace()`` with the same pattern as ``grep``.
    ``task_name`` is None only when the task row is gone.
    """
    trial_id: str
    task_name: Optional[str]
    match_count: int
    events: List[TraceEvent]


@dataclass
class JobGrepPage:
    """One page of a job-wide grep, ordered by trial id — jobs().grep()."""
    items: List[JobGrepGroup]
    next_cursor: Optional[str]
    has_more: bool


@dataclass
class TrialFile:
    """One stored file of a trial's tree — trials().files().

    ``path`` is prefix-relative, exactly the path ``trials().file()`` reads.
    """
    path: str
    size_bytes: int


@dataclass
class TrialFilePage:
    """One page of a trial's stored file tree, sorted by path."""
    items: List[TrialFile]
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

    A version whose warnings include ``no_solutions_archived`` permanently
    lacks its reference-solution record — the record operator verification
    tooling reads, never a gate. The version still publishes, activates, and
    runs; the warning makes the permanent gap visible instead of silent.
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


@dataclass
class SkillUpload:
    """One skill uploaded to the platform.

    Immutable content: the digest is the identity (Harbor's skill-digest
    recipe over the folder), and jobs reference it as ``upload:<id>`` in
    ``agents[].skills`` — that exact string is :attr:`ref`.
    ``skill_md`` carries the manifest text on :meth:`SkillsClient.get` only.
    """
    id: str
    name: str
    digest: str
    size_bytes: int
    description: Optional[str]
    ref: str
    created_at: str
    skill_md: Optional[str] = None


@dataclass
class SkillUploadPage:
    items: List[SkillUpload]
    next_cursor: Optional[str]
    has_more: bool


# =============================================================================
# MAPPERS
# =============================================================================

def _map_dataset_ref(data: Dict[str, Any]) -> DatasetRef:
    return DatasetRef(name=data.get('name', ''), version=data.get('version', ''))


def _map_agent_arm(data: Dict[str, Any]) -> AgentArm:
    # Map only the public arm fields.
    kwargs = data.get('kwargs')
    # Older servers carry no skills fields:
    # absent or garbage reads as "no skills" ([] / None), never a crash.
    raw_skills = data.get('skills')
    skills = [s for s in raw_skills if isinstance(s, str)] if isinstance(raw_skills, list) else []
    raw_locks = data.get('skill_locks')
    skill_locks: Optional[List[SkillLock]] = None
    if isinstance(raw_locks, list):
        skill_locks = []
        for entry in raw_locks:
            if not isinstance(entry, dict):
                continue
            name = entry.get('name')
            digest = entry.get('digest')
            if not isinstance(name, str) or not isinstance(digest, str):
                continue
            skill_locks.append(SkillLock(
                name=name,
                source=entry.get('source') if isinstance(entry.get('source'), str) else '',
                digest=digest,
                git_url=entry.get('git_url') if isinstance(entry.get('git_url'), str) else None,
                git_commit_id=entry.get('git_commit_id') if isinstance(entry.get('git_commit_id'), str) else None,
            ))
    return AgentArm(
        name=data.get('name', ''),
        model_name=data.get('model_name', ''),
        version=data.get('version'),
        reasoning_effort=data.get('reasoning_effort'),
        # Absent on older servers = none declared; anything non-dict is
        # unreadable and reads as none rather than crashing a list call.
        kwargs=kwargs if isinstance(kwargs, dict) else None,
        # Same law for the preset: absent on older servers = none declared.
        preset=data.get('preset') if isinstance(data.get('preset'), str) else None,
        skills=skills,
        skill_locks=skill_locks,
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
        git_url=data.get('git_url'),
        path=data.get('path'),
        acked_commit=data.get('acked_commit'),
    )


def _map_capability_document(raw: Dict[str, Any]) -> CapabilityDocument:
    """Map GET /api/meta into the public dataclass."""
    return CapabilityDocument(
        schema_version=raw.get('schema_version', 0),
        agents=[
            AgentCapability(
                name=item['name'],
                # The wire value is the tri-state string vocabulary; anything
                # else (including the boolean an obsolete server would send)
                # fails CLOSED to 'none' — never a silently-accepted effort.
                effort_support=item.get('effort_support')
                if item.get('effort_support') in EFFORT_SUPPORT_VALUES else 'none',
                version_pinnable=item.get('version_pinnable') is True,
                # Absent on an older server = the historical behavior: every
                # listed agent was runnable.
                runnable=item.get('runnable') is not False,
                reason=item.get('reason') if isinstance(item.get('reason'), str) else None,
                default_model=item.get('default_model')
                if isinstance(item.get('default_model'), str) else None,
                models=[
                    AgentModelOption(
                        alias=m['alias'],
                        model_id=m['model_id'],
                        description=m.get('description')
                        if isinstance(m.get('description'), str) else None,
                    )
                    for m in item.get('models', [])
                    if isinstance(m, dict) and 'alias' in m and 'model_id' in m
                ] if isinstance(item.get('models'), list) else [],
                default_effort=item.get('default_effort')
                if isinstance(item.get('default_effort'), str) else None,
                latest_version=item.get('latest_version'),
                supports_config=item.get('supports_config') is True,
                presets=[p for p in item.get('presets', []) if isinstance(p, str)]
                if isinstance(item.get('presets'), list) else [],
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
                gpus=item.get('gpus') if isinstance(item.get('gpus'), dict) else None,
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
        gpu_concurrency_cap=(
            raw['gpu_concurrency_cap']
            if isinstance(raw.get('gpu_concurrency_cap'), int)
            else None
        ),
    )


def _map_version_manifest(data: Any) -> Optional[DatasetManifestMetadata]:
    """The dataset.toml metadata a version imported under, defensively.

    An older server (no field) or garbage reads as ``None``; a present
    manifest gets its lists normalized so a caller iterates without guarding.
    """
    if not isinstance(data, dict) or not isinstance(data.get('name'), str):
        return None
    raw_authors = data.get('authors')
    authors: List[DatasetManifestAuthor] = []
    if isinstance(raw_authors, list):
        for item in raw_authors:
            if isinstance(item, dict) and isinstance(item.get('name'), str):
                email = item.get('email')
                authors.append(DatasetManifestAuthor(
                    name=item['name'],
                    email=email if isinstance(email, str) else None,
                ))
    keywords = data.get('keywords')
    version = data.get('version')
    description = data.get('description')
    task_count = data.get('task_count')
    return DatasetManifestMetadata(
        name=data['name'],
        version=version if isinstance(version, str) else None,
        description=description if isinstance(description, str) else '',
        authors=authors,
        keywords=[k for k in keywords if isinstance(k, str)] if isinstance(keywords, list) else [],
        task_count=(
            task_count
            if isinstance(task_count, int) and not isinstance(task_count, bool)
            else None
        ),
    )


def _map_version_source(data: Any) -> Optional[DatasetVersionSource]:
    """Map a version's own git provenance, tolerating every server generation.

    Absent (an older server, or a non-git version — an uploaded tarball has
    no git upstream) or unreadable input is ``None`` — "nothing to report",
    never a fabricated value and never a crash. Served on every git-imported
    version, including one whose build FAILED (it can never
    activate, so it never appears as ``upstream``).
    """
    if not isinstance(data, dict):
        return None
    ref = data.get('ref')
    commit = data.get('commit')
    if not isinstance(ref, str) or not isinstance(commit, str):
        return None
    git_url = data.get('git_url')
    path = data.get('path')
    return DatasetVersionSource(
        ref=ref,
        commit=commit,
        git_url=git_url if isinstance(git_url, str) else None,
        path=path if isinstance(path, str) else None,
    )


def _map_dataset_version(data: Dict[str, Any]) -> DatasetVersion:
    n_failed = data.get('n_failed_tasks')
    return DatasetVersion(
        version=data['version'],
        state=data.get('state', ''),
        created_at=data.get('created_at', ''),
        task_count=int(data.get('task_count', 0)),
        # Tasks that FAILED their independent build (partial-publish model).
        # Absent (an older server) reads as 0 — a fully built version.
        n_failed_tasks=n_failed if isinstance(n_failed, int) else 0,
        manifest=_map_version_manifest(data.get('manifest')),
        source=_map_version_source(data.get('source')),
    )


def _map_task_build_failure(data: Any) -> TaskBuildFailure:
    """The ONE failure grammar of a task's independent build — compact on
    the dataset detail's ``failed_tasks`` (no excerpt), full on the per-task
    build route."""
    if not isinstance(data, dict):
        data = {}
    return TaskBuildFailure(
        code=data.get('code', ''),
        step=data.get('step', ''),
        message=data.get('message', ''),
        excerpt=data.get('excerpt') if isinstance(data.get('excerpt'), str) else None,
    )


def _map_failed_tasks(data: Any) -> List[DatasetFailedTask]:
    """The dataset detail's ``failed_tasks`` list (partial-publish model).
    Absent (an older server) reads as an empty list — never a crash."""
    if not isinstance(data, list):
        return []
    return [
        DatasetFailedTask(
            task_name=item.get('task_name', ''),
            failure=_map_task_build_failure(item.get('failure')),
        )
        for item in data
        if isinstance(item, dict)
    ]


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
        # The newest version row, active or not -- the field that lets a
        # caller watch a FIRST import from the list alone. Absent on an older
        # server, which reads as None.
        latest_version=(
            _map_dataset_version(data['latest_version'])
            if data.get('latest_version')
            else None
        ),
        upstream=_map_upstream(data.get('upstream')),
    )


def _map_task(data: Dict[str, Any]) -> Task:
    providers_raw = data.get('providers') or {}
    gpus_raw = data.get('gpus')
    gpu_types_raw = data.get('gpu_types')
    return Task(
        task_name=data['task_name'],
        agent_timeout_sec=data.get('agent_timeout_sec', 0),
        verifier_timeout_sec=data.get('verifier_timeout_sec', 0),
        providers={
            provider: TaskProviderVerdict(
                ok=bool(verdict.get('ok')),
                reason=verdict.get('reason'),
                degrades_to=verdict.get('degrades_to'),
            )
            for provider, verdict in providers_raw.items()
            if isinstance(verdict, dict)
        },
        # Absent (older server) or garbage reads as "a CPU task" — never a crash.
        gpus=gpus_raw if isinstance(gpus_raw, int) and gpus_raw > 0 else 0,
        gpu_types=(
            [str(entry) for entry in gpu_types_raw]
            if isinstance(gpu_types_raw, list) and gpu_types_raw
            else None
        ),
    )


def _map_dataset_detail(raw: Dict[str, Any]) -> Dataset:
    """The full detail Dataset shape: get() and activate() echo it."""
    active = raw.get('active_version')
    # The newest version row, active or not -- served on the detail route
    # beside active_version. Absent on an older server, which reads as None.
    latest = raw.get('latest_version')
    selected = raw.get('selected_version')
    task_items, task_cursor, task_more = _page_parts(raw.get('tasks'))
    return Dataset(
        name=raw['name'],
        title=raw.get('title'),
        description=raw.get('description'),
        active_version=_map_dataset_version(active) if active else None,
        latest_version=_map_dataset_version(latest) if latest else None,
        upstream=_map_upstream(raw.get('upstream')),
        versions=[_map_dataset_version(item) for item in raw.get('versions', [])],
        selected_version=_map_dataset_version(selected) if selected else None,
        tasks=TaskPage(
            items=[_map_task(item) for item in task_items],
            next_cursor=task_cursor,
            has_more=task_more,
        ),
        # Always present on the detail body (empty on a fully built version);
        # absent only on an older server, which reads the same way.
        failed_tasks=_map_failed_tasks(raw.get('failed_tasks')),
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


def _map_job_delete_result(data: Dict[str, Any]) -> JobDeleteResult:
    """The receipt's three fields are REQUIRED by the contract — read in the
    same tolerant shape every required field here uses, a zero count riding
    verbatim as the server's own claim about an empty job."""
    return JobDeleteResult(
        job_id=data.get('job_id', ''),
        trials_deleted=data.get('trials_deleted', 0),
        analyses_deleted=data.get('analyses_deleted', 0),
    )


def _optional_float(value: Any) -> Optional[float]:
    """A wire number or None — anything else (an older server, garbage) is None."""
    return float(value) if isinstance(value, (int, float)) else None


def _map_retry_config(data: Any) -> JobRetryConfig:
    """The resolved retry policy off a job body. Tolerant of an OLDER server
    that does not send one yet: the absent-field reading is the retries-off
    policy with Harbor's defaults — exactly how such a server behaves.
    """
    raw = data if isinstance(data, dict) else {}

    def _number(value: Any, default: float) -> float:
        # bool is an int in Python; a boolean here is malformed, not a number.
        return value if isinstance(value, (int, float)) and not isinstance(value, bool) else default

    include = raw.get('include_exceptions')
    exclude = raw.get('exclude_exceptions')
    return {
        'max_retries': int(_number(raw.get('max_retries'), 0)),
        'include_exceptions': include if isinstance(include, list) else None,
        'exclude_exceptions': exclude if isinstance(exclude, list) else [],
        'wait_multiplier': _number(raw.get('wait_multiplier'), 1.0),
        'min_wait_sec': _number(raw.get('min_wait_sec'), 1.0),
        'max_wait_sec': _number(raw.get('max_wait_sec'), 60.0),
    }


def _map_build_exclusions(data: Any) -> List[JobBuildExclusion]:
    """The job body's ``build_exclusions`` — "ran N of M" per dataset (the
    partial-publish model's honesty label). Absent (an older server) reads as
    an empty list: nothing excluded."""
    if not isinstance(data, list):
        return []
    exclusions: List[JobBuildExclusion] = []
    for item in data:
        if not isinstance(item, dict):
            continue
        dataset = item.get('dataset')
        names = item.get('failed_task_names')
        n_ran = item.get('n_tasks_ran', 0) if isinstance(item.get('n_tasks_ran'), int) else 0
        exclusions.append(JobBuildExclusion(
            dataset=_map_dataset_ref(dataset if isinstance(dataset, dict) else {}),
            n_tasks_ran=n_ran,
            # Absent on a body recorded before the field existed: the
            # server's own answer for those is n_tasks_ran (read as uncapped).
            n_tasks_selected=(
                item.get('n_tasks_selected')
                if isinstance(item.get('n_tasks_selected'), int)
                else n_ran
            ),
            n_tasks_failed_to_build=(
                item.get('n_tasks_failed_to_build', 0)
                if isinstance(item.get('n_tasks_failed_to_build'), int)
                else 0
            ),
            failed_task_names=[str(name) for name in names] if isinstance(names, list) else [],
            note=item.get('note', '') if isinstance(item.get('note'), str) else '',
        ))
    return exclusions


def _map_upload_provenance(data: Any) -> Optional[UploadProvenance]:
    """The upload provenance echo, defensively: absent (a job this platform
    executed, or an older server) and malformed both read None — "not an
    uploaded job", never a crash. ``uploaded_at`` is the one required member;
    an echo without it reads None whole rather than as a fabricated
    half-provenance, and the two originals pass through as the None the
    archive stated when it stated nothing."""
    if not isinstance(data, dict):
        return None
    uploaded_at = data.get('uploaded_at')
    if not isinstance(uploaded_at, str):
        return None
    original_id = data.get('original_job_id')
    original_name = data.get('original_job_name')
    # The job-level sum of the trials' REPORTED figures. None when absent (a
    # pre-field ingest) or malformed — n_trials_reporting is the one member
    # the shape cannot stand without, since the figures only mean anything
    # against how many trials claimed them.
    totals = data.get('reported_totals')

    def _total_int(value: Any) -> Optional[int]:
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    def _total_number(value: Any) -> Optional[float]:
        return (
            float(value)
            if isinstance(value, (int, float)) and not isinstance(value, bool)
            else None
        )

    reported_totals = None
    if (
        isinstance(totals, dict)
        and isinstance(totals.get('n_trials_reporting'), int)
        and not isinstance(totals.get('n_trials_reporting'), bool)
    ):
        reported_totals = ReportedTotals(
            cost_usd=_total_number(totals.get('cost_usd')),
            n_input_tokens=_total_int(totals.get('n_input_tokens')),
            n_cache_tokens=_total_int(totals.get('n_cache_tokens')),
            n_output_tokens=_total_int(totals.get('n_output_tokens')),
            n_trials_reporting=totals['n_trials_reporting'],
        )
    return UploadProvenance(
        original_job_id=original_id if isinstance(original_id, str) else None,
        original_job_name=original_name if isinstance(original_name, str) else None,
        uploaded_at=uploaded_at,
        reported_totals=reported_totals,
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
        # Resolved with Harbor's defaults for anything absent — an older
        # server that sends no policy reads as the retries-off policy, which
        # is exactly how such a server behaves; every field always present.
        retry=_map_retry_config(data.get('retry')),
        # The resolved embedded-analysis policy, or None: a create that named
        # none, and an older server that sends nothing, both mean "no
        # embedded analysis" — exactly what None states.
        analyze=(
            data['analyze'] if isinstance(data.get('analyze'), dict) else None
        ),
        # Timeout multipliers: an older server sends none — 1.0 / None reads
        # as "every phase at 1.0", exactly how such a server behaves.
        timeout_multiplier=(
            float(data['timeout_multiplier'])
            if isinstance(data.get('timeout_multiplier'), (int, float))
            else 1.0
        ),
        agent_timeout_multiplier=_optional_float(data.get('agent_timeout_multiplier')),
        verifier_timeout_multiplier=_optional_float(data.get('verifier_timeout_multiplier')),
        agent_setup_timeout_multiplier=_optional_float(data.get('agent_setup_timeout_multiplier')),
        environment_build_timeout_multiplier=_optional_float(
            data.get('environment_build_timeout_multiplier')
        ),
        # None exactly on an uploaded job — the record executed on no
        # platform sandbox, so naming a provider would be an execution claim.
        sandbox_provider=(
            data['sandbox_provider']
            if isinstance(data.get('sandbox_provider'), str)
            else None
        ),
        counts=_map_counts(data.get('counts')),
        # THE RESULTS-HONESTY LABEL (partial-publish model): always a list —
        # absent (an older server) reads as "nothing was excluded".
        build_exclusions=_map_build_exclusions(data.get('build_exclusions')),
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
        upload=_map_upload_provenance(data.get('upload')),
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


def _map_judge_result(data: Any) -> Optional[JudgeResult]:
    if not isinstance(data, dict):
        return None
    return JudgeResult(
        n_input_tokens=data.get('n_input_tokens'),
        n_cache_tokens=data.get('n_cache_tokens'),
        n_output_tokens=data.get('n_output_tokens'),
        cost_usd=data.get('cost_usd'),
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


def _map_trial_retry(data: Dict[str, Any]) -> TrialRetry:
    exception_info = _map_exception_info(data.get('exception_info'))
    return TrialRetry(
        attempt_number=int(data.get('attempt_number', 0)),
        exception_info=exception_info
        if exception_info is not None
        else ExceptionInfo(exception_type='InfrastructureError', exception_message=''),
        cost_usd=data.get('cost_usd'),
        started_at=data.get('started_at'),
        settled_at=data.get('settled_at'),
    )


def _map_provider_degrade(data: Any) -> Optional[Dict[str, str]]:
    """The wire degrade object, defensively: anything malformed answers None,
    never a crash and never a partial row; extra keys never ride through."""
    if not isinstance(data, dict):
        return None
    from_provider = data.get('from')
    to_provider = data.get('to')
    reason = data.get('reason')
    if not (
        isinstance(from_provider, str)
        and isinstance(to_provider, str)
        and isinstance(reason, str)
    ):
        return None
    return {'from': from_provider, 'to': to_provider, 'reason': reason}


def _map_trial(data: Dict[str, Any]) -> Trial:
    retries = data.get('retries')
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
        # The judge share of the bill, itemized (Wave-3 lane 12); absent on
        # older servers and on every non-judge trial — None either way.
        judge_result=_map_judge_result(data.get('judge_result')),
        judge_spend_source=data.get('judge_spend_source'),
        # The trial's LATEST trace analysis. Defensive like gpu_cost: absent
        # (an older server, or a never-analyzed trial) and malformed both
        # read None — "never analyzed", never a fabricated empty object. The
        # dict rides otherwise verbatim; its nested ``usage`` goes through
        # the one shared parsing rule, exactly as the trial's own does.
        analysis=(
            {
                **data['analysis'],
                'usage': _usage_reading_from_data(data['analysis'].get('usage')),
            }
            if isinstance(data.get('analysis'), dict) else None
        ),
        environment_setup=_map_timing(data.get('environment_setup')),
        agent_setup=_map_timing(data.get('agent_setup')),
        agent_execution=_map_timing(data.get('agent_execution')),
        verifier=_map_timing(data.get('verifier')),
        # The finer pairs beside the four phase pairs — NOT a partition of
        # them, and never summed with them. They were documented on this shape
        # before they were mapped, so a caller reading the reference block
        # found nothing where the server had sent a pair; an absent one still
        # reads None, the same "nothing to report" every other timing pair
        # answers.
        queue_wait=_map_timing(data.get('queue_wait')),
        harness_bundle=_map_timing(data.get('harness_bundle')),
        image_prepare=_map_timing(data.get('image_prepare')),
        shared_verify_setup=_map_timing(data.get('shared_verify_setup')),
        # None is unrecorded, never "miss": only a real bool is a reading, so a
        # stray 0/1 reads as no reading rather than as False.
        harness_bundle_cache_hit=(
            data['harness_bundle_cache_hit']
            if isinstance(data.get('harness_bundle_cache_hit'), bool)
            else None
        ),
        step_results=data.get('step_results'),
        spend_source=data.get('spend_source'),
        # Mid-run lower bound, kept beside the settled pair and never folded
        # into it: it lags the gateway and is CLEARED when the trial settles.
        live_spent_usd=data.get('live_spent_usd'),
        live_spend_at=data.get('live_spend_at'),
        # The one-home usage reading, by the one shared parsing rule — a
        # malformed or absent object reads None ("the meter never answered").
        usage=_usage_reading_from_data(data.get('usage')),
        max_trial_spend_usd=data.get('max_trial_spend_usd'),
        sandbox_provider=data.get('sandbox_provider'),
        # Defensive: a malformed degrade object reads as None, never a crash.
        sandbox_provider_degrade=_map_provider_degrade(data.get('sandbox_provider_degrade')),
        # Same defensive rule; absent (an older server) reads as None too.
        gpu_cost=(
            data['gpu_cost'] if isinstance(data.get('gpu_cost'), dict) else None
        ),
        # Where the trial ran. Absent reads the same as "never booted a box".
        sandbox_id=data.get('sandbox_id'),
        verifier_sandbox_id=data.get('verifier_sandbox_id'),
        verifier_environment_mode=data.get('verifier_environment_mode'),
        attempt_phase=data.get('attempt_phase'),
        session_ref=data.get('session_ref'),
        upload=_map_trial_upload_provenance(data.get('upload')),
        started_at=data.get('started_at'),
        finished_at=data.get('finished_at'),
        # Auto-retry lineage. An older server sends neither key; 0 / [] is
        # exactly what such a server's behavior means.
        n_retries=int(data.get('n_retries', 0) or 0),
        retries=(
            [_map_trial_retry(item) for item in retries if isinstance(item, dict)]
            if isinstance(retries, list)
            else []
        ),
    )


def _map_trial_upload_provenance(data: Any) -> Optional[TrialUploadProvenance]:
    """The trial-level upload provenance, defensively: absent (a native
    trial, or an older server) and malformed both read None. The two names
    are the contract's required strings — an echo missing either reads None
    whole rather than as a fabricated half-identity — and the reported
    figures are the archive's OWN claim: present they map (each None when
    unstated), absent or malformed they are None, and they never leak into
    the platform-metered fields beside them."""
    if not isinstance(data, dict):
        return None
    trial_name = data.get('original_trial_name')
    task_name = data.get('original_task_name')
    if not isinstance(trial_name, str) or not isinstance(task_name, str):
        return None
    trial_id = data.get('original_trial_id')
    reported = data.get('reported_agent_result')

    def _reported_int(value: Any) -> Optional[int]:
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    def _reported_number(value: Any) -> Optional[float]:
        return (
            float(value)
            if isinstance(value, (int, float)) and not isinstance(value, bool)
            else None
        )

    return TrialUploadProvenance(
        original_trial_id=trial_id if isinstance(trial_id, str) else None,
        original_trial_name=trial_name,
        original_task_name=task_name,
        reported_agent_result=(
            ReportedAgentResult(
                n_input_tokens=_reported_int(reported.get('n_input_tokens')),
                n_cache_tokens=_reported_int(reported.get('n_cache_tokens')),
                n_output_tokens=_reported_int(reported.get('n_output_tokens')),
                cost_usd=_reported_number(reported.get('cost_usd')),
            )
            if isinstance(reported, dict)
            else None
        ),
    )


def _map_trace_event(data: Dict[str, Any]) -> TraceEvent:
    return TraceEvent(
        seq=int(data.get('seq', -1)),
        type=data.get('type', ''),
        data=data.get('data') or {},
    )


def _map_grep_group(data: Dict[str, Any]) -> JobGrepGroup:
    return JobGrepGroup(
        trial_id=data.get('trial_id', ''),
        task_name=data.get('task_name'),
        match_count=int(data.get('match_count', 0)),
        events=[_map_trace_event(item) for item in data.get('events') or []],
    )


def _map_trial_file(data: Dict[str, Any]) -> TrialFile:
    return TrialFile(
        path=data.get('path', ''),
        size_bytes=int(data.get('size_bytes', 0)),
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


def _map_skill_upload(data: Dict[str, Any]) -> SkillUpload:
    return SkillUpload(
        id=data.get('id', ''),
        name=data.get('name', ''),
        digest=data.get('digest', ''),
        size_bytes=data.get('size_bytes', 0) if isinstance(data.get('size_bytes'), int) else 0,
        description=data.get('description') if isinstance(data.get('description'), str) else None,
        ref=data.get('ref') if isinstance(data.get('ref'), str) else f"upload:{data.get('id', '')}",
        created_at=data.get('created_at', ''),
        skill_md=data.get('skill_md') if isinstance(data.get('skill_md'), str) else None,
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
    # no_solutions_archived permanently lacks its reference-solution record,
    # and dropping the field would hide that gap.
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
        self,
        path: str,
        *,
        timeout: int = DOWNLOAD_TIMEOUT_SEC,
        headers: Optional[Dict[str, str]] = None,
    ) -> 'tuple[bytes, Dict[str, str]]':
        """GET raw bytes plus response headers.

        The timeout defaults to the DOWNLOAD budget, not the JSON one: every
        caller of this is fetching an archive or a package, and a 512 MB body
        does not arrive inside a request timeout sized for a status poll. The
        to-disk path has always used the larger budget, and the two shapes
        failing at different sizes is the kind of difference nobody debugs.
        ``headers`` exists for the one extra header this surface speaks:
        the byte-range read's ``Range``.
        """
        return await asyncio.to_thread(
            self._request_sync, path, 'GET', None, headers, True, timeout
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
        with_status: bool = False,
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
                status = response.status
                if raw:
                    return payload, dict(response.headers.items())
        except urllib.error.HTTPError as exc:
            _raise_api_error(exc)
        parsed = json.loads(payload.decode('utf-8')) if payload else {}
        return (parsed, status) if with_status else parsed

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

    async def get_task_build(self, ref: str, task_name: str) -> TaskBuild:
        """The failure-detail read of the partial-publish model.

        One task's own build outcome inside one published version — its state
        (READY or FAILED), the typed failure WITH the failing-step excerpt,
        and the full build-log pointer. The dataset detail's ``failed_tasks``
        carries the compact reasons for every failed task; this call is where
        the excerpt and the log pointer live, one task at a time.

        ``ref`` must pin the version: ``"name@version"`` (the outcome is a
        fact about one immutable version, so there is no active-version
        reading to guess). A task the build has not settled — or a name the
        corpus never contained — answers 404 ``task_not_found``.
        """
        name, version = _parse_dataset_ref(ref)
        if version is None:
            raise ValueError(
                'get_task_build() needs "name@version" — a task\'s build '
                f'outcome belongs to one immutable version (got "{ref}")'
            )
        raw = await self._http.request_json(
            f'/api/datasets/{urllib.parse.quote(name)}/versions/'
            f'{urllib.parse.quote(version)}/tasks/'
            f'{urllib.parse.quote(task_name)}/build'
        )
        failure = raw.get('failure')
        return TaskBuild(
            task_name=raw.get('task_name', task_name),
            state=raw.get('state', ''),
            failure=_map_task_build_failure(failure) if isinstance(failure, dict) else None,
            build_log_ref=(
                raw.get('build_log_ref')
                if isinstance(raw.get('build_log_ref'), str)
                else None
            ),
        )

    async def publish(
        self,
        *,
        git_url: Optional[str] = None,
        git_ref: Optional[str] = None,
        git_path: Optional[str] = None,
        directory: Optional[str] = None,
        name: Optional[str] = None,
        version: Optional[str] = None,
    ) -> DatasetImport:
        """Publish a dataset version (asynchronous server-side import).

        Provide EITHER a git source (``git_url`` + pinned ``git_ref``) OR a
        local corpus ``directory`` (tarred + gzipped deterministically on the
        client and uploaded). Returns immediately; poll with
        :meth:`get_import` / :meth:`watch_import`. ``version`` labels the new
        immutable version.

        ``git_path`` (git sources only) narrows the import to ONE repository
        subfolder — a POSIX path relative to the repository root, e.g.
        ``datasets/my-swe``. The server fetches just that folder via git
        sparse checkout; a path that is not a directory at the pinned ref
        fails the import loudly. Ambiguous paths (absolute, ``..`` or ``.``
        segments, backslashes, whitespace, pattern characters, ``.git``) are
        refused at validation.

        ``name`` and ``version`` may be omitted for a ``directory`` whose
        corpus carries a Harbor ``dataset.toml`` manifest — the server derives
        the name from the manifest (the short segment of its ``org/name``) and
        the version from ``[dataset].version``. A git source always requires
        both: its manifest is only readable after the server clones it, long
        after the publish has been accepted under a name.

        ``git_url`` must be https — the import runs on a worker with no ssh
        client, so ssh:// and git@ remotes are refused at validation. For a
        private repository, put a token in the https url.
        """
        # ONE body grammar: multipart/form-data, metadata in named parts. The
        # corpus is the ``archive`` part; a git source is git_url + git_ref
        # (+ optional git_path).
        if directory is not None and git_path is not None:
            raise ValueError(
                'publish() takes git_path only with a git source — a subfolder '
                'narrows a git clone, not a local directory (point directory=... '
                'at the subfolder itself instead)'
            )
        if directory is not None:
            if name is None or version is None:
                # The only client-side check is the cheap one that saves a
                # wasted upload: without the flags AND without a manifest,
                # the server would refuse after receiving the whole corpus.
                root = Path(directory)
                has_manifest = (
                    (root / 'dataset.toml').is_file()
                    or (root / 'tasks' / 'dataset.toml').is_file()
                )
                if not has_manifest:
                    missing = 'name' if name is None else 'version'
                    raise ValueError(
                        f'publish() needs {missing}=... — pass it explicitly, or add a '
                        'dataset.toml manifest to the corpus directory (the server then '
                        'derives name and version from it)'
                    )
            gzipped = await asyncio.to_thread(_tar_gzip_directory, directory)
            fields = {'name': name, 'version': version}
            body, content_type = _multipart_body(
                {k: v for k, v in fields.items() if v is not None},
                ('corpus.tar.gz', gzipped),
            )
        elif git_url and git_ref:
            if name is None or version is None:
                raise ValueError(
                    'publish() requires name=... and version=... for a git source — a '
                    'dataset.toml manifest can only supply them for a directory source, '
                    'because a git repository is cloned server-side after the publish '
                    'is accepted'
                )
            fields = {
                'name': name,
                'version': version,
                'git_url': git_url,
                'git_ref': git_ref,
            }
            # Only when narrowing to a subfolder: an absent part means "the
            # repository root", and an empty part would be refused.
            if git_path is not None:
                fields['git_path'] = git_path
            body, content_type = _multipart_body(fields)
        else:
            raise ValueError(
                'publish() requires either a git source (git_url=..., git_ref=...) '
                'or a local corpus directory (directory=...), plus name=... '
                'and version=... (both optional for a directory whose corpus '
                'carries a dataset.toml manifest)'
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
        on_version: Optional[Callable[[DatasetVersion, Dataset], None]] = None,
        poll_interval_s: float = 2.0,
        timeout_s: Optional[float] = None,
        settle_timeout_s: float = _DEFAULT_SETTLE_TIMEOUT_S,
    ) -> DatasetImport:
        """Watch a publish to its SETTLED end: READY or FAILED.

        Polls ``get_import()`` until the import is terminal. COMPLETED means
        the version is READY under build-then-READY — the build settled with
        at least one task ready (the partial-publish model; each provider
        builds its boot artifact lazily at the first trial) and, on an
        owner-stamped dataset, already ACTIVE —
        so the settle phase is normally one confirming dataset-detail read;
        against a mid-deploy OLDER server it keeps polling until the VERSION
        itself lands READY, ARCHIVED, or FAILED (a failure rides the returned
        import's ``failure``).

        ``on_status`` fires on every observed import status change (including
        the first status seen). ``on_version`` fires on every observed change
        of the version's state during the settle phase, with the detail read
        it came from — its ``active_version`` says whether the settled
        version is now the one a bare dataset name resolves to.

        Bounded on purpose (fail closed, never an infinite poll): raises the
        typed :class:`ImportSettleError` (``'settle_timeout'``) when the
        ``settle_timeout_s`` backstop elapses first — a bound on the WAIT,
        never a verdict on the publish; keep following with ``get()``.
        ``timeout_s`` still bounds the whole watch and raises
        :class:`TimeoutError`, exactly as before.

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
            if dataset_import.status == 'FAILED':
                return dataset_import
            if dataset_import.status == 'COMPLETED':
                # COMPLETED means the version is READY (built, and on an
                # owner dataset active) — the settle phase is one confirming
                # read, plus the poll that covers a mid-deploy older server
                # (see _settle_import).
                return await self._settle_import(
                    dataset_import,
                    on_version=on_version,
                    poll_interval_s=poll_interval_s,
                    overall_deadline=deadline,
                    overall_timeout_s=timeout_s,
                    settle_timeout_s=settle_timeout_s,
                )
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f'watch_import({id!r}) timed out after {timeout_s}s')
            await asyncio.sleep(poll_interval_s)

    async def _settle_import(
        self,
        imported: DatasetImport,
        *,
        on_version: Optional[Callable[[DatasetVersion, Dataset], None]],
        poll_interval_s: float,
        overall_deadline: Optional[float],
        overall_timeout_s: Optional[float],
        settle_timeout_s: float,
    ) -> DatasetImport:
        """Phase two of ``watch_import`` — the confirming read behind the
        import surface.

        Under build-then-READY the server completes an import only when the
        version is READY, so COMPLETED and "settled" are the same fact and
        this phase normally confirms it in one dataset-detail read. It still
        POLLS rather than assumes, for exactly one skew: a mid-deploy OLDER
        server can answer COMPLETED while its version is still short of
        READY — the poll then follows the version's own state until it lands:

        - state READY or ARCHIVED: settled success (ARCHIVED = superseded by
          a newer publish while we watched — it completed all the same)
        - state FAILED: the version's terminal failure lands its structured
          cause on the same row the import surface reads — re-read the
          import and return it FAILED, the one import shape

        Bounded on purpose (fail closed, never an infinite poll):
        ``settle_timeout_s`` backstops every stall (a server that answers
        nothing but 429/503 stalls the polling itself):
        ``ImportSettleError('settle_timeout')`` with the last observed
        state.
        """
        settle_deadline = time.monotonic() + settle_timeout_s
        ref = f'{imported.name}@{imported.version}'
        last_seen: Optional[str] = None
        last_version: Optional[DatasetVersion] = None

        def settle_timeout_error() -> ImportSettleError:
            """ONE home for the settle_timeout refusal, built from whatever
            was last observed. Two true stories share the code: usually the
            version never settled inside the budget; after a FAILED
            observation the version DID settle — it is the final import read
            the server kept refusing."""
            if last_version is not None and last_version.state == 'FAILED':
                return ImportSettleError(
                    'settle_timeout',
                    f'Import {imported.id}\'s dataset "{imported.name}" version '
                    f'"{imported.version}" settled FAILED, '
                    f'but the final import read kept answering '
                    f'rate-limited/unavailable past the {settle_timeout_s}s '
                    f'settle budget. Read the failure with '
                    f'datasets().get_import("{imported.id}").',
                    import_id=imported.id,
                    dataset=imported.name,
                    version=imported.version,
                    state=last_version.state,
                )
            last_state = last_version.state if last_version is not None else 'never observed'
            return ImportSettleError(
                'settle_timeout',
                f'Import {imported.id} completed, but dataset '
                f'"{imported.name}" version "{imported.version}" did not '
                f'settle within {settle_timeout_s}s: last observed state '
                f'{last_state}. Keep following with '
                f'datasets().get("{ref}").',
                import_id=imported.id,
                dataset=imported.name,
                version=imported.version,
                state=last_version.state if last_version is not None else None,
            )

        async def read_through_rate_limits(read):
            """ONE home for the settle phase's delay-not-outcome law: every
            read — the detail poll and the final import re-read alike —
            survives a 429/503 by sleeping the server's delay, and the SAME
            settle deadline bounds the retrying (a server answering nothing
            but rate limits must not turn this bounded wait into an infinite
            loop)."""
            while True:
                try:
                    return await read()
                except EvolveAPIError as error:
                    if error.status not in (429, 503):
                        raise
                    remaining = settle_deadline - time.monotonic()
                    if remaining <= 0:
                        raise settle_timeout_error() from error
                    if overall_deadline is not None and time.monotonic() >= overall_deadline:
                        raise TimeoutError(
                            f'watch_import({imported.id!r}) timed out after {overall_timeout_s}s'
                        ) from error
                    await asyncio.sleep(
                        min(max(error.retry_after_sec or 0.0, poll_interval_s), remaining)
                    )

        while True:
            # limit=1: the watch reads the version's state, never the task
            # list — keep the poll as small as the route allows.
            detail = await read_through_rate_limits(lambda: self.get(ref, limit=1))
            version = detail.selected_version
            if version is not None:
                last_version = version
                if version.state != last_seen:
                    last_seen = version.state
                    if on_version is not None:
                        on_version(version, detail)
                if version.state == 'FAILED':
                    # The failed version's row is what the import surface
                    # reads, so the import answers FAILED with the structured
                    # cause on ``failure`` — return that, the one import
                    # shape. The read lives under the same delay-not-outcome
                    # law: a transient 429 here must not turn a settled
                    # failure into a thrown rate-limit error.
                    return await read_through_rate_limits(
                        lambda: self.get_import(imported.id)
                    )
                if version.state in ('READY', 'ARCHIVED'):
                    return imported
            if time.monotonic() >= settle_deadline:
                raise settle_timeout_error()
            if overall_deadline is not None and time.monotonic() >= overall_deadline:
                raise TimeoutError(
                    f'watch_import({imported.id!r}) timed out after {overall_timeout_s}s'
                )
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
        """Make a built version the dataset's active version.

        Returns the full detail shape, exactly like :meth:`get`. A publish
        lands READY and active on its own (build-then-READY), so this verb
        re-points the default at a version that is already built — an older
        READY one. A version still building
        refuses with the typed 409 ``version_not_ready``
        (:class:`EvolveAPIError`).
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
# SKILLS CLIENT
# =============================================================================

class SkillsClient:
    """Client for platform-stored skills.

    An uploaded skill is an immutable folder (content-digested with Harbor's
    recipe) that jobs reference as ``upload:<id>`` in ``agents[].skills``,
    next to skills.sh and git references. Created via the standalone
    ``skills()`` factory; requires ``EVOLVE_API_KEY`` unless
    ``HostedClientConfig(api_key=...)`` is given.

    Example::

        from evolve import skills, jobs, AgentArm

        async with skills() as skills_client:
            uploaded = await skills_client.upload('./my-skill')

        async with jobs() as jobs_client:
            await jobs_client.start(
                datasets=[{'name': 'deep-swe'}],
                agents=[AgentArm(
                    name='claude',
                    model_name='claude-opus-4-1',
                    skills=[uploaded[0].ref],
                )],
            )
    """

    def __init__(self, config: Optional[HostedClientConfig] = None):
        self._http = _HostedHttp('skills', config)

    async def __aenter__(self) -> 'SkillsClient':
        return self

    async def __aexit__(self, *args: Any) -> None:
        await self.close()

    async def close(self) -> None:
        return None

    async def upload(self, directory: str) -> List[SkillUpload]:
        """Upload a local skill folder and return its records.

        The folder must contain ``SKILL.md``, or be a root whose immediate
        child directories each contain ``SKILL.md`` (Harbor's discovery law; a
        root uploads each child as its own skill and the list holds one record
        per skill). Content-addressed: re-uploading identical content under
        the same name answers the existing record instead of duplicating it.
        A skill NAME is a moving pointer: every upload makes its record the
        name's current one (different content = new record, pointer moves;
        old records keep their immutable ``upload:<id>`` handles), and
        ``name:<skill-name>`` in ``agents[].skills`` resolves through it at
        job create.
        """
        if not isinstance(directory, str) or not directory.strip():
            raise ValueError('skills().upload() requires a local skill directory path')
        gzipped = await asyncio.to_thread(_tar_gzip_directory, directory)
        # The archive packs the folder's CONTENT (SKILL.md at the archive
        # root); the folder's own name travels beside it, so a single-skill
        # upload is recorded — and later mounted — under its folder name.
        folder_name = os.path.basename(os.path.abspath(directory))
        fields = {'name': folder_name} if folder_name else {}
        body, content_type = _multipart_body(fields, ('skill.tar.gz', gzipped))
        raw = await self._http.request_upload(
            '/api/skills', body, {'Content-Type': content_type}
        )
        items = raw.get('skills')
        if not isinstance(items, list):
            items = [raw]
        return [_map_skill_upload(item) for item in items if isinstance(item, dict)]

    def list(
        self,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
    ) -> _PaginatedList:
        """List the caller's uploaded skills (cursor-paged).

        ``await`` the result for one page, or ``async for`` it to walk them all.
        """
        async def fetch_page(page_limit, page_cursor) -> SkillUploadPage:
            raw = await self._http.request_json(
                f'/api/skills{_page_query(page_limit, page_cursor)}'
            )
            items, next_cursor, has_more = _page_parts(raw)
            return SkillUploadPage(
                items=[_map_skill_upload(item) for item in items],
                next_cursor=next_cursor,
                has_more=has_more,
            )

        return _PaginatedList(
            fetch_page, lambda page: page.items, limit=limit, cursor=cursor
        )

    async def get(self, skill_id: str) -> SkillUpload:
        """Get one uploaded skill, including its SKILL.md text.

        Takes a record id, or ``name:<skill-name>`` — the moving name
        pointer, answered with its CURRENT record (unknown names are the
        typed ``skill_name_not_found``).
        """
        raw = await self._http.request_json(
            f'/api/skills/{urllib.parse.quote(skill_id)}'
        )
        return _map_skill_upload(raw)

    async def delete(self, skill_id: str) -> None:
        """Delete an uploaded skill.

        Refused (``skill_in_use``) while a non-terminal job references it;
        finished jobs keep their recorded locks either way.
        """
        await self._http.request_json(
            f'/api/skills/{urllib.parse.quote(skill_id)}', method='DELETE'
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
        retry: Optional[JobRetryConfigInput] = None,
        analyze: Optional[AnalyzeConfigInput] = None,
        timeout_multiplier: Optional[float] = None,
        agent_timeout_multiplier: Optional[float] = None,
        verifier_timeout_multiplier: Optional[float] = None,
        agent_setup_timeout_multiplier: Optional[float] = None,
        environment_build_timeout_multiplier: Optional[float] = None,
        agent_env: Optional[Dict[str, str]] = None,
        verifier_env: Optional[Dict[str, str]] = None,
        secrets: Optional[List[Union['JobSecretRef', 'JobSecretInline', Dict[str, Any]]]] = None,
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
        case for the whole job. ``retry`` is the auto-retry policy in
        Harbor's RetryConfig vocabulary (``max_retries``,
        ``include_exceptions``, ``exclude_exceptions``, ``wait_multiplier``,
        ``min_wait_sec``, ``max_wait_sec``) — a plain dict, typed
        :class:`JobRetryConfigInput`; omitted, the server applies its
        fleet defaults (infrastructure errors retry automatically — send
        ``{'max_retries': 0}`` to turn retries off), and the response echoes
        the RESOLVED policy either way as ``Job.retry``
        (:class:`JobRetryConfig`, every field present). Inside the policy, an EXPLICIT
        ``'exclude_exceptions': None`` is not the same as leaving the key
        out: None turns exclusions off entirely (everything the include set
        admits is retried — Harbor's own None semantics), while an omitted
        key keeps Harbor's default non-retryable set.
        ``'include_exceptions'`` has no such split: None, an omitted key,
        and the empty list ``[]`` all mean no filter — Harbor's include
        check treats the empty set exactly like None, so ``[]`` never means
        "retry nothing". ``analyze`` arms the EMBEDDED trace-analysis
        trigger (Harbor's ``harbor analyze`` vocabulary, the spec's
        AnalyzeConfigInput): PRESENCE is the switch — each trial is analyzed
        server-side right after it settles (CANCELLED trials are skipped),
        ``{}`` means "all defaults" (glm-5.3-flash, Harbor's default
        rubric), and the response echoes the RESOLVED policy as
        ``Job.analyze`` (:class:`AnalyzeConfig`); omitted, no embedded
        analysis runs and :meth:`analyze` remains the manual door. The five
        ``*timeout_multiplier`` arguments are
        Harbor's timeout knobs verbatim: ``timeout_multiplier`` multiplies
        every TASK-DECLARED timeout for this job's runs (default 1.0;
        values below 1 shrink), and each phase-specific one —
        ``agent_timeout_multiplier``, ``verifier_timeout_multiplier``,
        ``agent_setup_timeout_multiplier``,
        ``environment_build_timeout_multiplier`` — overrides it for that
        phase. The task itself is never rewritten. Every multiplier must be
        greater than 0 and at most the published ceiling
        (``limits['job']['max_timeout_multiplier']`` on the capability
        document; 10 unless the fleet changes it) — an absurd value is
        refused at create with a typed message naming the bound.
        ``agent_env`` / ``verifier_env`` are
        pass-through slots injected into every agent / verifier run — sent
        verbatim; the server owns acceptance (refused where unsupported,
        never silently dropped). The hosted platform honors exactly two
        ``verifier_env`` keys, Harbor rewardkit's per-run judge override
        (their ``--ve`` mechanism): ``REWARDKIT_JUDGE`` overwrites the
        rubric's ``[judge].judge`` field and ``REWARDKIT_MODEL`` overwrites
        its ``[judge].model`` field when the judge is an agent. Both are
        delivered into the verifier environment in both verifier modes,
        over any task-declared value of the same name; any other key is
        refused at create. ``secrets`` attaches env secrets to every agent
        run — REFERENCES to stored secrets (``{'name': ..., 'label': ...,
        'as': ...}``, the spec's JobSecretRef) and INLINE entries
        (``{'name': ..., 'value': ..., 'delivery': ..., 'label': ...,
        'as': ...}``, the spec's JobSecretInline) whose values are saved
        into your vault as normal env secrets FIRST and then pinned like
        any other reference — the stored job never contains a value. A
        (name, label) collision with an existing row splits on proof: a
        byte-equal restatement (same value, same delivery) attaches the
        existing row — retries of the same request converge — while a
        different value or delivery is the typed ``secret_exists``
        refusal (attach by reference or pick a label — never a silent
        overwrite). Reference resolution is the server's and
        is pinned at create: an omitted ``label`` takes the
        'default'-labeled row when one exists (the single row when exactly
        one exists), and a bare name matching several labels with no
        'default' is the typed ``secret_ambiguous`` refusal naming the
        labels; ``as`` renames the env var inside the sandbox, and names
        the trial contract owns (the ``EVOLVE_`` prefix, gateway/vendor key
        slots, the judge-override pair) are refused. DELIVERY MODES: every
        stored env secret carries ``delivery`` — ``'brokered'`` (the value
        never enters any sandbox; the managed-agents egress-proxy
        machinery) or ``'direct'`` (the raw value is placed in the sandbox
        environment). Eval trials deliver exactly the DIRECT mode: the
        value enters the trial env and is scrubbed at the credential seal,
        before hidden tests enter. Attaching a brokered secret is the
        typed ``secret_brokered_unsupported`` refusal at create — never a
        silent downgrade. Supports Idempotency-Key.
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
        if retry is not None:
            body['retry'] = retry
        if analyze is not None:
            body['analyze'] = analyze
        if timeout_multiplier is not None:
            body['timeout_multiplier'] = timeout_multiplier
        if agent_timeout_multiplier is not None:
            body['agent_timeout_multiplier'] = agent_timeout_multiplier
        if verifier_timeout_multiplier is not None:
            body['verifier_timeout_multiplier'] = verifier_timeout_multiplier
        if agent_setup_timeout_multiplier is not None:
            body['agent_setup_timeout_multiplier'] = agent_setup_timeout_multiplier
        if environment_build_timeout_multiplier is not None:
            body['environment_build_timeout_multiplier'] = environment_build_timeout_multiplier
        if agent_env is not None:
            body['agent_env'] = agent_env
        if verifier_env is not None:
            body['verifier_env'] = verifier_env
        if secrets is not None:
            body['secrets'] = [dict(ref) for ref in secrets]
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

    async def retry(
        self,
        id: str,
        *,
        trial_ids: Optional[List[str]] = None,
        failed_only: Optional[bool] = None,
        idempotency_key: Optional[str] = None,
    ) -> Job:
        """MANUAL retry: a NEW linked job holding fresh trials for
        caller-SELECTED trials of the source.

        ``source_jobs`` on the new job records ``action="retry"``; the source
        is never mutated. The selection is ``trial_ids`` XOR ``failed_only``
        (both together is refused): omitted, every trial of the (terminal)
        source retries; ``failed_only=True`` narrows a terminal source to its
        failures (SCORING_ERROR, INFRASTRUCTURE_ERROR, INDETERMINATE —
        stopped and scored trials are not failures); ``trial_ids`` names
        exact trials all-or-nothing, each must be SETTLED (the job itself may
        still be running — a settled trial's facts are final).

        Retry differs from :meth:`resume` on purpose: resume answers "finish
        what broke", retry answers "run THESE again" — a scored trial is a
        legitimate target. Supports Idempotency-Key (fingerprint over the
        RESOLVED selection, namespaced to this verb — a resume key can never
        replay a retry).
        """
        body: Dict[str, Any] = {}
        if trial_ids is not None:
            body['trial_ids'] = trial_ids
        if failed_only is not None:
            body['failed_only'] = failed_only
        headers = {'Idempotency-Key': idempotency_key} if idempotency_key else None
        raw = await self._http.request_json(
            f'/api/jobs/{urllib.parse.quote(id)}/retry',
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

    async def analyze(
        self,
        id: str,
        *,
        model_name: Optional[str] = None,
        rubric: Optional[Rubric] = None,
        sandbox_provider: Optional[EvalSandboxProvider] = None,
    ) -> Job:
        """Analyze a terminal job's trial traces (rubric-driven, Harbor's
        ``harbor analyze``), server-side.

        For each trial the analyzer agent reads the trial's Harbor-shape tree
        plus its original task and rules every rubric criterion, storing the
        result on the trial (``Trial.analysis``) and the aggregate on the job
        (``stats['analysis']``). THE RESPONSE IS THE JOB, its analyses
        enqueued — analyses are not a separate resource; follow them with
        :meth:`watch_analysis`, or poll the job's trials. This is also the
        RE-analysis path: calling again (same job, different rubric or
        model) runs a fresh wave once the previous one has settled.
        ``sandbox_provider`` picks the provider whose sandbox the analyzer
        boots — the job lineup; omitted, the platform's analysis default
        applies (daytona unless the operator retuned the fleet). Every
        argument omitted means the defaults: glm-5.3-flash over Harbor's
        default rubric (reward_hacking, task_specification), on the
        platform's analysis default provider. CANCELLED trials are never
        analyzed.

        The server owns every acceptance refusal, surfaced typed:
        ``job_not_terminal``, ``invalid_rubric`` (unknown keys named, empty
        or duplicate criteria, bounds), ``invalid_input`` (off-roster model,
        or a provider outside the lineup — the message names the roster),
        ``analysis_already_running`` (one wave at a time),
        ``no_analyzable_trials`` (every trial CANCELLED).
        """
        body: Dict[str, Any] = {}
        if model_name is not None:
            body['model_name'] = model_name
        if rubric is not None:
            body['rubric'] = rubric
        if sandbox_provider is not None:
            body['sandbox_provider'] = sandbox_provider
        raw = await self._http.request_json(
            f'/api/jobs/{urllib.parse.quote(id)}/analyze', method='POST', body=body
        )
        return _map_job(raw)

    async def watch_analysis(
        self,
        id: str,
        *,
        on_stats: Optional[Callable[[Job], None]] = None,
        poll_interval_s: float = 2.0,
        timeout_s: Optional[float] = None,
    ) -> Job:
        """Follow a job's analysis wave to its settled end.

        Analyses have no event stream — the contract's own words: poll the
        job's trials to watch them settle — so this polls :meth:`get` until
        ``stats['analysis']`` reports nothing pending, and returns the final
        job; the per-trial results then ride the job's trials
        (``Trial.analysis``). ``on_stats`` fires on every observed change of
        the analysis tally (including the first non-None one seen), with the
        job body the observation came from. A still-None tally is the
        enqueue race after an accepted :meth:`analyze` and is watched
        through, never misread as "never analyzed" — so on a job that was
        NEVER analyzed this polls indefinitely (until ``timeout_s``): call
        it after :meth:`analyze`, as the CLI always does. It is the MANUAL
        wave's companion, not the embedded trigger's: on a still-RUNNING job
        created with ``analyze``, ``n_pending`` can touch 0 between trial
        settles, so the watch can return before every trial has been
        analyzed.

        ``timeout_s`` bounds the whole watch and raises
        :class:`TimeoutError`. A rate limit or transient outage mid-watch is
        a delay, not an outcome: a 429/503 sleeps the server's
        ``retry_after_sec`` and keeps watching.
        """
        if poll_interval_s <= 0:
            raise ValueError('poll_interval_s must be positive')
        deadline = time.monotonic() + timeout_s if timeout_s is not None else None
        last_tally: Optional['tuple[int, int, int]'] = None
        while True:
            try:
                job = await self.get(id)
            except EvolveAPIError as error:
                if error.status not in (429, 503):
                    raise
                if deadline is not None and time.monotonic() >= deadline:
                    raise TimeoutError(
                        f'watch_analysis({id!r}) timed out after {timeout_s}s'
                    ) from error
                await asyncio.sleep(
                    max(error.retry_after_sec or 0.0, poll_interval_s)
                )
                continue
            analysis = job.stats.get('analysis')
            if isinstance(analysis, dict):
                tally = (
                    int(analysis.get('n_completed', 0)),
                    int(analysis.get('n_failed', 0)),
                    int(analysis.get('n_pending', 0)),
                )
                if tally != last_tally:
                    last_tally = tally
                    if on_stats is not None:
                        on_stats(job)
                if tally[2] == 0:
                    return job
            if deadline is not None and time.monotonic() >= deadline:
                raise TimeoutError(f'watch_analysis({id!r}) timed out after {timeout_s}s')
            await asyncio.sleep(poll_interval_s)

    async def download(
        self,
        id: str,
        *,
        to: Optional[str] = None,
    ):
        """Download a terminal job's results as one ``.tar.gz`` in the
        standard job-directory layout (deterministic bytes).

        The archive extracts to ``job-<id>/`` with ``config.json``,
        ``lock.json``, ``result.json`` (stats incl. ``pass_at_k``) and
        ``job.log``, and per trial its ``config.json``, ``lock.json``,
        ``result.json`` (``step_results`` on multi-step trials),
        ``trial.log``, ``agent/trajectory.json`` (the normalized ATIF
        trajectory), ``agent/{stdout,stderr}.log``, ``agent/sessions/``,
        ``verifier/test-stdout.txt``, ``verifier/reward.json``, the raw
        ``verifier/reward.txt`` (only when the grader wrote one),
        ``steps/<name>/verifier/reward.json`` (multi-step trials only),
        ``exception.txt``, and ``artifacts/`` with its always-present
        ``manifest.json`` — absent artifacts are absent files.

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

    async def upload(
        self,
        dir_or_archive: str,
        *,
        dataset: Optional[str] = None,
    ) -> Job:
        """Upload a Harbor job directory as a first-class TERMINAL job —
        Harbor's ``harbor upload`` in reverse, taking their CLI's own input
        (a ``job_dir`` with result.json + config.json at its root, one
        subdirectory per trial; the same gate applies here, client-side,
        with their refusal sentences).

        ``dir_or_archive`` is that directory — packed into a gzipped tar with
        the same deterministic packer every upload route here uses — or a
        ready-packed ``.tar.gz`` of one, uploaded byte-for-byte: the
        platform's own :meth:`download` produces exactly this format, so a
        downloaded job re-uploads as-is, and any real ``harbor run`` job dir
        works the same way.

        Trial facts land verbatim: rewards are never re-scored, a trial
        without a verdict lands INDETERMINATE, exceptions are carried, and
        the trajectory / raw streams / verifier log / reward.txt are stored
        byte-for-byte in the native trial slots. THE RESPONSE IS THE JOB —
        COMPLETED on creation, with ``upload`` carrying the provenance echo.
        It is a record, not a run: resume, retry and regrade refuse it
        (``job_uploaded``); :meth:`analyze` works on it unchanged.
        ``dataset`` (``"name"`` or ``"name@version"``) links the uploaded
        trials to a published dataset version by task name. The caps live on
        ``GET /api/meta`` under ``limits['uploads']`` (``job_archive_bytes``,
        ``job_trials``, ``job_trial_file_bytes``).
        """
        if not isinstance(dir_or_archive, str) or not dir_or_archive.strip():
            raise ValueError(
                'jobs().upload() requires a job directory (or .tar.gz archive) path'
            )
        path = os.path.abspath(dir_or_archive)
        if os.path.isfile(path):
            # A regular file is a ready-packed archive and rides verbatim.
            archive = await asyncio.to_thread(Path(path).read_bytes)
        else:
            # Harbor's own gate (their cli/upload.py checks result.json, then
            # config.json), applied client-side with their sentences — the
            # cheap refusal that saves tarring and shipping a tree the server
            # would refuse the same way (``not_a_job_dir``). A nonexistent
            # path lands here too and reads as the first refusal, exactly as
            # their CLI does.
            for required in ('result.json', 'config.json'):
                if not os.path.exists(os.path.join(path, required)):
                    raise ValueError(f'{path} does not contain {required}')
            archive = await asyncio.to_thread(_tar_gzip_directory, path)
        fields: Dict[str, Optional[str]] = {}
        if dataset is not None:
            fields['dataset'] = dataset
        body, content_type = _multipart_body(fields, ('job.tar.gz', archive))
        raw = await self._http.request_upload(
            '/api/jobs/upload', body, {'Content-Type': content_type}
        )
        return _map_job(raw)

    async def delete(self, id: str) -> JobDeleteResult:
        """Permanently delete one of your jobs — trials, trace events,
        analyses and every stored trace object included (Harbor's
        ``harbor hub job delete``: "Permanently delete Hub jobs you own,
        including their trials"). Works on uploaded and native jobs alike;
        deleting an uploaded job frees its duplicate lock, so
        delete-then-reupload is the replace path.

        CREATOR-ONLY: org members may operate a job (cancel, retry), never
        destroy its record — a member who did not create it is refused
        (``org_forbidden``, 403). TERMINAL ONLY — never a delete under a
        live worker: a QUEUED/RUNNING/CANCELLING job refuses
        ``job_not_terminal`` (409; cancel first), a queued or running
        analysis wave refuses ``analysis_already_running`` (409), and a live
        regrade derived from this job refuses ``job_not_terminal`` with the
        regrade jobs to wait for in ``details['regrade_job_ids']``. A
        regrade job id is itself not deletable here (``job_not_found``,
        404) — a regrade's results are deleted from the traces surface.
        What stays: regrade JOB rows and ``source_jobs`` history, which keep
        naming the deleted id; the model gateway's own ledger remains the
        billing truth.

        The response is the receipt: what was destroyed, counted.
        """
        raw = await self._http.request_json(
            f'/api/jobs/{urllib.parse.quote(id)}', method='DELETE'
        )
        return _map_job_delete_result(raw)

    async def grep(
        self,
        id: str,
        q: str,
        *,
        type: Optional[str] = None,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> JobGrepPage:
        """Grep the parsed trace of EVERY trial of the job in one server-side
        pass.

        ``q`` is the trace filter's grammar: a case-insensitive POSIX regex
        over each event's type and serialized content, where a plain string
        is a plain substring — grep's own rules; ``type`` narrows to one
        event type first. Items are per-trial groups ordered by trial id
        (the cursor is the last group's trial id): the trial's task name,
        the EXACT match count, and the first few matching events. An empty
        page means no matches anywhere — a normal answer.
        """
        raw = await self._http.request_json(
            f'/api/jobs/{urllib.parse.quote(id)}/grep'
            f'{_page_query(limit, cursor, q=q, type=type)}'
        )
        items, next_cursor, has_more = _page_parts(raw)
        return JobGrepPage(
            items=[_map_grep_group(item) for item in items],
            next_cursor=next_cursor,
            has_more=has_more,
        )

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
        type: Optional[str] = None,
        grep: Optional[str] = None,
        tail: Optional[int] = None,
    ) -> TraceEventPage:
        """Get one page of a trial's trace.

        ``cursor`` returns events with seq strictly greater than it (omit =
        from the beginning); resume with ``cursor=page.next_cursor``. A None
        ``next_cursor`` means CAUGHT UP — to resume a poll later, keep the last
        event's ``seq`` and pass it as ``cursor``.

        ``type`` / ``grep`` / ``tail`` filter the parsed events and COMPOSE
        with the cursor: only events of exactly that type; only events whose
        type or serialized content matches the case-insensitive POSIX regex
        (a plain string is a plain substring — grep's own grammar; an invalid
        pattern is the server's typed ``invalid_input`` refusal); only the
        last N matching events (a floor on the seq timeline, after which
        paging proceeds normally, oldest-first).
        """
        raw = await self._http.request_json(
            f'/api/trials/{urllib.parse.quote(trial_id)}/trace'
            f'{_page_query(limit, cursor, type=type, grep=grep, tail=str(tail) if tail is not None else None)}'
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
        type: Optional[str] = None,
        grep: Optional[str] = None,
        tail: Optional[int] = None,
    ):
        """Iterate a trial's trace events, fetching pages under the hood.

        Drains the currently available trace, then stops: ``next_cursor`` is
        None when there is no next page, which says "caught up" rather than
        echoing the position back. Resume later by passing the last seen seq as
        ``cursor``. The ``type`` / ``grep`` / ``tail`` filters ride every
        page — a filtered drain is still one drain.
        """
        position = cursor
        while True:
            page = await self.trace(
                trial_id, cursor=position, limit=limit, type=type, grep=grep, tail=tail
            )
            for event in page.items:
                yield event
            if not page.next_cursor:
                return
            position = page.next_cursor

    async def files(
        self,
        trial_id: str,
        *,
        cursor: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> TrialFilePage:
        """List the trial's ENTIRE stored file tree.

        The read-only-filesystem law: everything the platform stored under
        the trial's prefix — native session files, the verifier log, the raw
        agent streams, live checkpoint chunks — as ``{path, size_bytes}``
        rows sorted by path, no curation. Read any row with :meth:`file`.
        An empty page is a normal answer.
        """
        raw = await self._http.request_json(
            f'/api/trials/{urllib.parse.quote(trial_id)}/files'
            f'{_page_query(limit, cursor)}'
        )
        items, next_cursor, has_more = _page_parts(raw)
        return TrialFilePage(
            items=[_map_trial_file(item) for item in items],
            next_cursor=next_cursor,
            has_more=has_more,
        )

    async def file(
        self,
        trial_id: str,
        path: str,
        *,
        start: Optional[int] = None,
        end: Optional[int] = None,
        suffix: Optional[int] = None,
    ) -> bytes:
        """RAW BYTES of one stored file, by the path :meth:`files` names.

        Byte fidelity, no translation. ``start``/``end`` read an inclusive
        slice (``start`` alone reads to the end); ``suffix`` reads the last N
        bytes — the wire's single-``Range`` grammar, so a huge log tails
        without shipping whole. A path the tree does not hold surfaces as the
        API's typed 404.
        """
        encoded = '/'.join(
            urllib.parse.quote(segment) for segment in path.split('/') if segment
        )
        headers: Optional[Dict[str, str]] = None
        if suffix is not None:
            headers = {'Range': f'bytes=-{suffix}'}
        elif start is not None:
            headers = {'Range': f'bytes={start}-{end if end is not None else ""}'}
        payload, _headers = await self._http.request_bytes(
            f'/api/trials/{urllib.parse.quote(trial_id)}/files/{encoded}',
            headers=headers,
        )
        return payload

    async def artifact(
        self,
        trial_id: str,
        stream: Literal['trace-parsed', 'verifier', 'trace-stdout', 'trace-stderr', 'trace-atif', 'trajectory', 'agent-home'],
    ) -> Optional[Union[str, Dict[str, str]]]:
        """One raw trace artifact for a trial, by the trace route's ``?stream=``
        selector.

        ``"verifier"`` / ``"trace-stdout"`` / ``"trace-stderr"`` answer the log
        text; ``"trace-atif"`` answers the normalized trajectory — Harbor's
        ATIF v1.7 document as JSON text, built server-side from the stored
        parsed trace (the same document ``jobs.download()`` places at Harbor's
        own path ``agent/trajectory.json``); ``"trajectory"`` is a DIFFERENT
        artifact — the harness's own native session file, reserved ahead of
        its server wave; the server answers not-found for it until that wave
        lands, and the refusal surfaces as the API error it is;
        ``"agent-home"`` (the CLI's whole home folder, subagent
        transcripts included by construction) answers a dict of sandbox path to
        text. None = never stored (normal answer, not an error): a
        QUEUED/CANCELLED trial, a harness that wrote nothing, or a purged
        trace. ``"trace-parsed"`` is in the vocabulary but is not
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

    async def retry(
        self,
        trial_id: str,
        *,
        idempotency_key: Optional[str] = None,
    ) -> Job:
        """Run ONE settled trial again.

        THE RESPONSE IS A JOB — a one-trial retry job inheriting the source
        job's config, with ``source_jobs`` recording ``action="retry"``; the
        source trial is immutable. The same operation as
        ``jobs.retry(job_id, trial_ids=[trial_id])`` — one selection rule,
        one idempotency fingerprint — kept as its own door because the trial
        is what you are holding. The source JOB may still be running; the
        trial must be settled (``trial_not_settled`` otherwise). Supports
        Idempotency-Key.
        """
        headers = {'Idempotency-Key': idempotency_key} if idempotency_key else None
        raw = await self._http.request_json(
            f'/api/trials/{urllib.parse.quote(trial_id)}/retry',
            method='POST',
            body={},
            headers=headers,
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
        self._skills: Optional[SkillsClient] = None

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
        """Jobs: start, watch, compare, resume, retry, regrade, analyze, download."""
        if self._jobs is None:
            self._jobs = JobsClient(self._config)
        return self._jobs

    @property
    def trials(self) -> TrialsClient:
        """Globally addressable trials: get, trace, artifact, regrade, stop."""
        if self._trials is None:
            self._trials = TrialsClient(self._config)
        return self._trials

    @property
    def skills(self) -> SkillsClient:
        """Platform-stored skills, referenced as ``upload:<id>`` in agents[].skills."""
        if self._skills is None:
            self._skills = SkillsClient(self._config)
        return self._skills

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
