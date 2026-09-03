/**
 * Public types for the hosted evaluations API — datasets, jobs, trials, agents.
 *
 * THE VOCABULARY IS THE WIRE'S. Every field on a wire-shaped object below is
 * spelled exactly as spec/openapi.yaml spells it (snake_case), so the spec
 * reads as the SDK's own field reference and nothing is ever lost in a casing
 * translation. The only camelCase keys are the four frozen historical spots
 * the spec names: the page envelope (`items`/`nextCursor`/`hasMore`), the job
 * body's `trials.byStatus`, the compare response's `taskMatrix`, and the error
 * envelope (`retryAfterSec`/`requestId`). That freeze is a WIRE law, not a
 * property-name law: both SDKs send and receive those keys camelCase, this SDK
 * also exposes them verbatim, and the Python SDK maps them to snake_case
 * attributes (`next_cursor`/`has_more`/`by_status`/`task_matrix`,
 * `retry_after_sec`/`request_id`). SDK-side controls that never touch the
 * wire — client config, delivery options, callbacks — stay
 * TypeScript-idiomatic camelCase.
 */

/** Configuration for the datasets() / agents() / jobs() / trials() factories */
export interface HostedClientConfig {
  /** API key (default: process.env.EVOLVE_API_KEY) */
  apiKey?: string;
  /** API base URL override (default: the Evolve dashboard API) */
  baseUrl?: string;
}

/**
 * ONE page shape for every collection on this surface — top level or nested.
 *
 * `nextCursor` means one thing everywhere: pass it back as the next call's
 * `cursor` for the next page, and `null` means there is no next page. It never
 * echoes where you already are, so a poller can always tell it has caught up.
 * The three envelope keys are frozen verbatim on the wire.
 */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

/**
 * A value you can `await`, with the rest of the promise surface attached.
 *
 * The dual-use handles below were `PromiseLike` alone, which is enough for
 * `await` and nothing else — so `client.list().catch(...)` was a compile error
 * two lines after `await client.list()` compiled fine, and `.finally()` for a
 * spinner was unavailable. A handle that is 90% of a promise is worse than one
 * that is none of it, because the missing 10% is only discovered at the call
 * site that needed it.
 *
 * `then`/`catch`/`finally` all return real Promises, so anything chained off a
 * handle behaves exactly like promise code from that point on.
 */
export interface Awaitable<T> extends PromiseLike<T> {
  catch<TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null
  ): Promise<T | TResult>;
  finally(onfinally?: (() => void) | null): Promise<T>;
}

/** Cursor + page-size options, accepted by every paged call */
export interface PageOptions {
  /** Max items per page */
  limit?: number;
  /** Cursor from a previous page's nextCursor */
  cursor?: string;
}

/**
 * Job lifecycle status (wire values, as the API emits them).
 * Terminal: COMPLETED, CANCELLED, FAILED.
 */
export type JobStatus =
  | "QUEUED"
  | "RUNNING"
  | "CANCELLING"
  | "COMPLETED"
  | "CANCELLED"
  | "FAILED";

/**
 * Trial status law: a valid reward (including 0) = SCORED; verifier crash or
 * out-of-domain reward = SCORING_ERROR (never a fabricated zero);
 * INFRASTRUCTURE_ERROR: the trial was lost before a result was recorded;
 * INDETERMINATE: the platform cannot tell whether the trial completed.
 *
 * A runtime value (not only a type), like TRIAL_ARTIFACT_STREAMS, so the CLI
 * can validate a `--status` filter against this list instead of a second copy.
 */
export const TRIAL_STATUSES = [
  "QUEUED",
  "RUNNING",
  "SCORING",
  "SCORED",
  "SCORING_ERROR",
  "INFRASTRUCTURE_ERROR",
  "INDETERMINATE",
  "CANCELLED",
] as const;

/** One trial lifecycle status — see TRIAL_STATUSES for the law. */
export type TrialStatus = (typeof TRIAL_STATUSES)[number];

/**
 * Sandbox provider a hosted job runs on. Named `EvalSandboxProvider` to avoid
 * colliding with the core SDK's `SandboxProvider` (the sandbox-abstraction
 * interface). A runtime value for the same reason as TRIAL_STATUSES: the CLI
 * validates `-e/--env` against it.
 */
export const EVAL_SANDBOX_PROVIDERS = ["e2b", "daytona", "modal"] as const;

/** One sandbox provider — see EVAL_SANDBOX_PROVIDERS. */
export type EvalSandboxProvider = (typeof EVAL_SANDBOX_PROVIDERS)[number];

/**
 * The list scopes — Harbor's `--scope` on `harbor hub job list` (their
 * cli/hub.py list_jobs_cmd: my | shared | all). `my` is what you created;
 * `shared` is what your organizations' other members created — every row the
 * per-id doors already open for you that is not your own. Harbor's `all`
 * adds public rows; nothing hosted is public, so the server refuses it and
 * the CLI refuses it at the keyboard. A runtime value for the same reason as
 * TRIAL_STATUSES: the CLI validates `--scope` against it.
 */
export const JOB_LIST_SCOPES = ["my", "shared"] as const;

/** One list scope — see JOB_LIST_SCOPES. */
export type JobListScope = (typeof JOB_LIST_SCOPES)[number];

/**
 * An analysis's own lifecycle ladder — lowercase, the object's Harbor
 * dialect (spec TrialAnalysis.status). A runtime value so the CLI validates
 * `analysis list --status` against it instead of a second copy.
 */
export const ANALYSIS_STATUSES = ["queued", "running", "completed", "failed"] as const;

/** One analysis status — see ANALYSIS_STATUSES. */
export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

/**
 * Which lane a settled trial's `agent_result.cost_usd` came from. Only
 * `"measured"` is final. `"measured_provisional"` is a real gateway reading
 * taken inside its asynchronous spend flush — an honest floor a deferred pass
 * later confirms or raises into `"measured"`. `"assumed_cap"` means nobody
 * measured this trial: the figure it carries is zero, a placeholder and never
 * the cap (the platform under-bills rather than publish an invented number),
 * replaced when a real reading lands. Read anything but `"measured"` as not
 * yet final.
 */
export type SpendSource = "measured" | "measured_provisional" | "assumed_cap";

/**
 * THE ONE-HOME USAGE READING — "what has this run's meter said so far", money
 * and tokens from the SAME gateway spend-log records so the two can never
 * describe different sets of requests. Served under the one key `usage`, with
 * these exact keys, by the trial surfaces and the managed-agents session
 * surfaces alike. While the run is alive the platform's own poll raises the
 * numbers (~30s cadence over a gateway that batches its logs late), so a
 * polling reader sees them tick; once settled, the settled figures replace
 * the live ones under the same keys. The whole object is null when the meter
 * has never answered — never a fabricated zero.
 */
export interface UsageReading {
  /**
   * True while every number is a LOWER BOUND that can still grow — the run is
   * alive, or its settled lane is not yet confirmed. False = settled; the
   * reading will not move again.
   */
  provisional: boolean;
  /**
   * Metered model spend so far, USD. Null = the money was never measured
   * (which a trial's `spend_source` lane `assumed_cap` states; the token
   * fields beside it may still carry real readings).
   */
  spent_usd: number | null;
  /** Prompt tokens so far, INCLUDING the cached share. */
  input_tokens: number | null;
  /** The cached share of `input_tokens`. */
  cached_input_tokens: number | null;
  /** Completion tokens so far. */
  output_tokens: number | null;
  /** When this reading was taken — show its age, never the figure alone. */
  as_of: string | null;
}

/**
 * The wire's usage reading, defensively: anything malformed answers null,
 * which already means "the meter never answered" on this shape. Each numeric
 * field is taken only as a real number (a stray string never becomes money),
 * and `provisional` must be a real boolean — without it the reading has no
 * statement to make. Lives beside the type because BOTH clients that receive
 * the object — the hosted trials client and the sessions client — parse it
 * with this one rule.
 */
export function mapUsageReading(raw: unknown): UsageReading | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.provisional !== "boolean") return null;
  const numOrNull = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? value : null;
  return {
    provisional: record.provisional,
    spent_usd: numOrNull(record.spent_usd),
    input_tokens: numOrNull(record.input_tokens),
    cached_input_tokens: numOrNull(record.cached_input_tokens),
    output_tokens: numOrNull(record.output_tokens),
    as_of: typeof record.as_of === "string" ? record.as_of : null,
  };
}

/** Where a trial's verifier executed: inside the agent's environment, or a separate one */
export type VerifierEnvironmentMode = "shared" | "separate";

/**
 * Which step a RUNNING trial is in, so a polling caller can tell a slow build
 * from a slow agent — RUNNING alone cannot.
 */
export type AttemptPhase =
  | "prepare"
  | "build"
  | "boot"
  | "install"
  | "agent"
  | "verify"
  | "persist";

/**
 * Trial count histogram by status. EVERY status is present, zeros included, so
 * a status bar can be drawn straight off the response without hardcoding the
 * enum and discovering a new status only when a bar goes missing.
 */
export type TrialCounts = Record<TrialStatus, number>;

/**
 * The one "how many" shape: a total plus the zeros-included histogram.
 * `byStatus` is one of the four frozen camelCase wire keys.
 */
export interface TrialStatusTally {
  total: number;
  byStatus: TrialCounts;
}

// =============================================================================
// JOB — CONFIG SIDE
// =============================================================================

/** A resolved dataset reference as echoed on job bodies. */
export interface DatasetRef {
  name: string;
  version: string;
}

/**
 * One dataset a job runs, with per-dataset task filters. `task_names` and
 * `exclude_task_names` are glob patterns; `n_tasks` caps the task count AFTER
 * filtering. A bare `name` resolves to the active version (`no_active_version`
 * when none).
 */
export interface DatasetSelector {
  /** Catalog dataset name. */
  name: string;
  /** Pin a version; omitted, the active version is used. */
  version?: string;
  /** Include filter — glob patterns over task names. */
  task_names?: string[];
  /** Exclude filter — glob patterns over task names. */
  exclude_task_names?: string[];
  /** Cap the task count after filters are applied. */
  n_tasks?: number;
}

/**
 * One agent arm of a job: an agent (built-in or registered) plus a model. A
 * model is always required; the server applies no default.
 *
 * `version` pins an agent version; omitted, the platform resolves the latest
 * supported (`agent_version_not_found` when a pin cannot resolve). The version
 * that actually RAN is recorded on every trial as `agent_info.version`.
 *
 * `reasoning_effort` is the platform extension: declared effort, PART OF THE
 * ARM'S IDENTITY like the agent, the model and the version pin — the same
 * agent and model at "low" and at "high" are two systems, and they
 * de-duplicate separately. Accepted values are published by /api/meta; an
 * effort the agent cannot apply is refused at creation, never recorded and
 * silently dropped.
 */
export interface AgentArmInput {
  /** Agent name — a built-in or one registered under /api/agents. */
  name: string;
  model_name: string;
  version?: string | null;
  reasoning_effort?: string | null;
  /**
   * Agent kwargs, Harbor's `--ak` channel and wire shape. The one key this
   * platform delivers is `config`: an INLINE JSON object converted into the
   * harness's native settings document inside the sandbox (the CLI resolves
   * `--ak config=<path>` to the file's parsed content before sending — the
   * server never reads a client path). The user document is the base;
   * platform routing is stamped on top. Part of the arm's identity: the same
   * agent+model with two configs are two arms.
   *
   * Server acceptance is typed, never silent: an unrecognized kwarg key is
   * `agent_kwarg_unsupported`, `config` for an agent without native-config
   * support (see /api/meta `supports_config`) is `agent_config_unsupported`,
   * and a config key touching billing, base URLs, routing, or env is
   * `agent_config_key_refused`.
   */
  kwargs?: Record<string, unknown> | null;
  /**
   * Named agent-settings preset for this arm: `no-internet` (vendor
   * server-side web tools off — Claude settings deny WebSearch/WebFetch,
   * Codex `-c web_search=disabled`) or `pinned-context` (one fixed effective
   * context window). A platform-authored bundle delivered through the same
   * channel as `kwargs.config`, stamped ON TOP of the user document — normal
   * users tick a box and never learn what `--ak` is. Part of the arm's
   * identity: the same agent+model with and without a preset are two arms.
   *
   * Acceptance is typed, never silent: an unknown preset name is
   * `invalid_input`, and a known preset on an agent whose /api/meta entry
   * does not list it under `presets` is `agent_preset_unsupported` — a
   * preset the platform cannot guarantee is refused, never half-applied.
   * Enforcement is harness configuration, exactly as Harbor delivers it.
   */
  preset?: string | null;
  /**
   * Skill references mounted into every run of this arm — Harbor's
   * trial-config shape: a list of source strings (models/trial/config.py:81).
   * Accepted forms: `skills.sh/<owner>/<repo>[/<skill>]`, `org/repo[@ref]`,
   * an https git URL (optionally `/tree/<ref>/<subdir>`), `upload:<id>`
   * naming a skill uploaded to the platform, or `name:<skill-name>` — the
   * caller's moving name pointer, resolved SERVER-SIDE at creation to its
   * current record and pinned as that record's `upload:<id>` (an unknown
   * name is the typed `skill_name_not_found`). The SDK passes the string
   * through — no client-side resolution. Local filesystem paths are a
   * CLIENT-side convenience only — the CLI uploads the folder first and sends
   * the `upload:<id>` handle; the server refuses raw paths.
   *
   * Git references are PINNED at job creation (the exact commit resolved
   * once, recorded, and used by every trial), so a moving branch can never
   * make two trials of one job run different skill content. Part of the
   * arm's identity: the same agent and model with different skills are two
   * arms.
   */
  skills?: string[] | null;
}

/**
 * Provenance of one skill an arm's runs actually mounted — Harbor's
 * AgentSkillLock vocabulary (models/job/lock.py:141): name, source reference,
 * content digest, and for git-backed skills the repo URL and exact commit.
 */
export interface SkillLock {
  name: string;
  /** The pinned reference the content came from. */
  source: string;
  /** Content digest, Harbor's recipe: "sha256:<hex>". */
  digest: string;
  git_url: string | null;
  git_commit_id: string | null;
}

/** One agent arm as echoed on job bodies (requested pin; null = took the latest). */
export interface AgentArm {
  name: string;
  model_name: string;
  version: string | null;
  reasoning_effort: string | null;
  /** The arm's agent kwargs as accepted; null when none were declared. */
  kwargs: Record<string, unknown> | null;
  /** The arm's named settings preset; null when none was declared. */
  preset: string | null;
  /** The arm's skill references, pinned spelling. Empty = no skills. */
  skills: string[];
  /**
   * What actually mounted, one lock per skill — stamped when the arm's first
   * trial resolves its skills; null until then (and stays null on a job whose
   * trials never ran).
   */
  skill_locks: SkillLock[] | null;
}

/**
 * Provenance of a derived job. `action: "regrade"` = verifier-only re-run of
 * the source; `action: "resume"` (platform extension) = new job over the
 * source's failed and stopped trials; `action: "retry"` = manual retry — new
 * job over caller-SELECTED source trials (explicit ids, failed-only, or the
 * whole job). `type` is always "hub" on this hosted surface.
 */
export interface SourceJob {
  action: "regrade" | "resume" | "retry";
  type: "hub";
  job_id: string;
}

/**
 * Auto-retry policy input — Harbor's RetryConfig vocabulary verbatim. Only
 * trials that settle INFRASTRUCTURE_ERROR are ever considered; the
 * include/exclude sets refine within that class by exception name, exclude
 * taking precedence (Harbor's rule). Every omitted field takes Harbor's own
 * default, with ONE named deviation: `max_retries` omitted takes the
 * PLATFORM fleet default (published as `limits.job.default_max_retries` on
 * GET /api/meta; 2 unless the operator tuned it) rather than Harbor's 0 —
 * infrastructure errors on a hosted fleet retry automatically. Send
 * `max_retries: 0` to turn retries off. Each attempt carries the job's FULL
 * per-trial spend cap, and `worst_case_spend_usd` states the
 * (max_retries + 1) product outright.
 */
export interface RetryConfigInput {
  /** Maximum automatic retries per trial (0-10). Omitted = fleet default; 0 = off. */
  max_retries?: number;
  /**
   * Exception types to retry on. Null, omitted, or the empty array = no
   * filter — Harbor's include check treats the empty set exactly like None,
   * so `[]` never means "retry nothing".
   */
  include_exceptions?: string[] | null;
  /**
   * Exception types to NOT retry on; wins over include_exceptions. Omitted =
   * Harbor's default non-retryable set (AgentTimeoutError,
   * VerifierTimeoutError, RewardFileNotFoundError, RewardFileEmptyError,
   * VerifierOutputParseError, ApiUsageLimitError, AgentSafetyRefusalError,
   * AgentAuthenticationError, ModelNotFoundError). An EXPLICIT null is
   * DIFFERENT from omitting: null turns exclusions off entirely — everything
   * the include set admits is retried, the default set included — exactly
   * Harbor's None (their exclude check is guarded by
   * `if exclude_exceptions and ...`, so None disables it).
   */
  exclude_exceptions?: string[] | null;
  /** Multiplier for exponential backoff wait time (default 1.0). */
  wait_multiplier?: number;
  /** Minimum wait in seconds between retries (default 1.0). */
  min_wait_sec?: number;
  /** Maximum wait in seconds between retries (default 60.0; platform cap 3600). */
  max_wait_sec?: number;
}

/**
 * The RESOLVED auto-retry policy a job runs under, echoed on every job body —
 * the caller's values or the defaults of the day, resolved at create and
 * stored. Backoff between attempts is Harbor's formula:
 * min(min_wait_sec x wait_multiplier^attempt, max_wait_sec).
 */
export interface RetryConfig {
  max_retries: number;
  include_exceptions: string[] | null;
  exclude_exceptions: string[];
  wait_multiplier: number;
  min_wait_sec: number;
  max_wait_sec: number;
}

/**
 * One analysis criterion — Harbor's RubricCriterion verbatim (their
 * cli/quality_checker/models.py `{name, description, guidance}`). The name
 * becomes the key of the matching entry in `checks`; the guidance is what the
 * analyzer agent is instructed with.
 */
export interface RubricCriterion {
  /**
   * Criterion identifier, snake_case (it keys the result's `checks` object).
   * Harbor's defaults are `reward_hacking` and `task_specification`.
   */
  name: string;
  /** What the criterion evaluates, one sentence. */
  description: string;
  /**
   * Evaluation guidance handed to the analyzer agent — what evidence to read
   * and what PASS / FAIL / NOT_APPLICABLE mean for this criterion.
   */
  guidance: string;
}

/**
 * An analysis rubric — Harbor's Rubric shape (`{criteria: [...]}`, their
 * cli/quality_checker/models.py). The criteria set is FROZEN into each
 * analysis at enqueue: the stored result is validated against exactly this
 * set, a missing or extra criterion is a stored typed failure, never a
 * partial pass.
 */
export interface Rubric {
  criteria: RubricCriterion[];
}

/**
 * Trace-analysis configuration — Harbor's `harbor analyze` vocabulary (their
 * cli/analyze.py: `--model`, `--rubric`). PRESENCE of this object is the
 * switch: on `JobCreate.analyze` it arms the embedded trigger (each trial is
 * analyzed server-side right after it settles; CANCELLED trials are skipped);
 * as the body of `POST /api/jobs/{jobId}/analyze` it configures that manual
 * wave. `{}` is legal and means "all defaults": glm-5.3-flash over
 * Harbor's default rubric (reward_hacking, task_specification — their
 * analyze/prompts/analyze-rubric.toml, ported verbatim).
 *
 * The analyzer always runs the claude-code harness (Harbor's default analyze
 * agent) in its own sealed sandbox — on the provider `sandbox_provider`
 * names, or the platform's analysis default when it names none; its spend is
 * capped per analysis and metered as its own line, never blended into the
 * trial's own bill.
 */
export interface AnalyzeConfigInput {
  /**
   * Model the analyzer agent runs — Harbor's `--model`. The default is
   * glm-5.3-flash on this platform's claude roster — a recorded deviation
   * from Harbor's default analyze model (their cli/analyze.py
   * `claude-haiku-4-5`): analysis is input-dominated, and flash is the
   * input-price frontier; name `glm-5.3` (or any roster member) to
   * escalate. The value speaks the same vocabulary as
   * `agents[].model_name`: either advertised spelling is accepted and
   * stored AS GIVEN (the default is the roster alias), the wire id is
   * resolved only when the analyzer runs, and every stored analysis serves
   * the spelling it was created under. Must be on the claude roster
   * (`GET /api/meta`, `harnesses[].models`); anything else is refused at
   * accept (`invalid_input`, roster in the message).
   */
  model_name?: string;
  rubric?: Rubric;
  /**
   * The provider whose sandbox the analyzer boots — the job lineup, the same
   * vocabulary as `JobCreate.sandbox_provider` and held to the same rule: an
   * unknown value is refused `invalid_input` naming the lineup. Stored as
   * given and honored wherever this config enqueues an analysis — every
   * embedded analysis of the job, or the manual wave this body configures.
   * Omitted, the platform's analysis default applies at each enqueue
   * (daytona unless the operator retuned the fleet) — the value the resolved
   * `AnalyzeConfig.sandbox_provider` echo reports.
   */
  sandbox_provider?: EvalSandboxProvider;
}

/**
 * The RESOLVED trace-analysis policy — the caller's values or the defaults of
 * the day, resolved at accept and stored, so the record always states the
 * policy it executes (same law as RetryConfig). Echoed on the job body when
 * the job was created with `analyze`; each analysis additionally carries the
 * exact pair IT ran under (`Trial.analysis.model_name` / `.rubric`), which a
 * later manual re-analysis may have changed.
 */
export interface AnalyzeConfig {
  model_name: string;
  rubric: Rubric;
  /**
   * The provider this policy's analyses run on. Named at create it is served
   * as stored, forever. When the create named none, this echoes the
   * platform's analysis default OF THE DAY — the value the next enqueue
   * under this policy would stamp — because that default is an operator
   * fleet knob, resolved where an analysis is actually enqueued rather than
   * baked into the stored policy (the one deliberate nuance to the
   * resolved-at-accept law above, stated so the echo is never read as
   * history).
   */
  sandbox_provider: EvalSandboxProvider;
}

/** The job-creation body — POST /api/jobs. */
export interface JobCreate {
  /** User-facing label; server-generated when omitted. */
  job_name?: string;
  datasets: DatasetSelector[];
  agents: AgentArmInput[];
  /** Attempts per task per agent arm (default 1, max 100). */
  n_attempts?: number;
  /** Parallel trials across the job (default 4, max 16). */
  n_concurrent_trials?: number;
  /**
   * Per-trial spend cap in USD, minted onto each trial's gateway key — the
   * platform's ONLY spend enforcement (there is no job-wide budget). Omitted,
   * the server applies its published default ($200 unless the operator tuned
   * it); the response echoes the RESOLVED cap either way, and states the
   * resulting worst case for the job as a whole.
   */
  max_trial_spend_usd?: number;
  /** Sandbox provider to run on (optional; server default: `daytona`). */
  sandbox_provider?: EvalSandboxProvider;
  /** Auto-retry policy (Harbor RetryConfig grammar); omitted = the fleet defaults. */
  retry?: RetryConfigInput;
  /**
   * Trace-analysis policy (Harbor's `harbor analyze` vocabulary). PRESENCE
   * arms the embedded trigger: each trial is analyzed server-side right after
   * it settles (CANCELLED trials are skipped — withdrawn work is not billed
   * an uninvited analysis). `{}` means "analyze with all defaults"; omitted
   * means no embedded analysis — `jobs().analyze()` remains the manual door.
   */
  analyze?: AnalyzeConfigInput;
  /**
   * Multiplier for task timeouts — Harbor's `--timeout-multiplier`, all five
   * fields flat on this body exactly as Harbor's JobConfig carries them. The
   * worker multiplies each TASK-DECLARED timeout at the point that phase's
   * timeout is armed; the task itself is never rewritten, so the same task
   * runs unstretched in every other job. Values below 1 shrink, as in
   * Harbor. Every multiplier must be greater than 0 and at most the
   * published ceiling (`limits.job.max_timeout_multiplier` on GET /api/meta;
   * 10 unless the fleet changes it) — an absurd value is refused with a
   * typed `invalid_input` naming the bound, never silently clamped.
   * Default 1.0.
   */
  timeout_multiplier?: number;
  /** Multiplier for the agent execution timeout (overrides timeout_multiplier). */
  agent_timeout_multiplier?: number;
  /** Multiplier for the verifier timeout (overrides timeout_multiplier). */
  verifier_timeout_multiplier?: number;
  /** Multiplier for the agent setup timeout (overrides timeout_multiplier). */
  agent_setup_timeout_multiplier?: number;
  /** Multiplier for the environment build timeout (overrides timeout_multiplier). */
  environment_build_timeout_multiplier?: number;
  /**
   * Env injected into every agent run — a pass-through slot: the client sends
   * it verbatim and the server owns acceptance (refused where unsupported,
   * never silently dropped).
   */
  agent_env?: Record<string, string>;
  /**
   * Env injected into every verifier run — same pass-through contract. The
   * hosted platform honors exactly two keys, Harbor rewardkit's per-run judge
   * override (their `--ve` mechanism): `REWARDKIT_JUDGE` overwrites the
   * rubric's `[judge].judge` field and `REWARDKIT_MODEL` overwrites its
   * `[judge].model` field when the judge is an agent. Both are delivered into
   * the verifier environment in both verifier modes, over any task-declared
   * value of the same name; any other key is refused at create.
   */
  verifier_env?: Record<string, string>;
  /**
   * Env secrets to deliver into every agent run — REFERENCES to the
   * caller's own stored env secrets, plus INLINE entries ({name, value,
   * delivery, label?, as?}) whose values are saved into the vault as
   * normal env secrets first and then pinned like any other reference
   * (WIRE LAW: the stored job never contains a value; a (name, label)
   * collision splits on proof — a byte-equal restatement of the stored
   * row, same value and delivery, attaches it so retries of the same
   * request converge, while a different value or delivery is the typed
   * `secret_exists` refusal — attach by reference or pick a label, never
   * a silent overwrite). References are resolved at
   * create and pinned: an omitted `label` takes the 'default'-labeled row
   * when one exists (the single row when exactly one exists), and a bare
   * name matching several labels with no 'default' is the typed
   * `secret_ambiguous` refusal naming the labels — a job never guesses
   * which secret it runs with. `as` renames the env var inside the
   * sandbox; names the trial contract owns (the EVOLVE_ prefix,
   * gateway/vendor key slots, the judge-override pair) are refused.
   * DELIVERY MODES: every stored env secret carries `delivery` —
   * 'brokered' (the value never enters any sandbox; the managed-agents
   * egress-proxy machinery) or 'direct' (the raw value is placed in the
   * sandbox environment). Eval trials deliver exactly the DIRECT mode:
   * the value enters the trial env and is scrubbed at the credential seal,
   * before hidden tests enter. Attaching a brokered secret is the typed
   * `secret_brokered_unsupported` refusal at create — never a silent
   * downgrade.
   */
  secrets?: Array<JobSecretRef | JobSecretInline>;
}

/**
 * One attached env secret: a reference to a stored secret of the caller's,
 * by name and optional label, with an optional in-sandbox rename. The same
 * {name, label?, as?} shape as the managed-agents lane's ManagedSecretRef,
 * resolved by the same server-side law.
 */
export interface JobSecretRef {
  /** The stored secret's name (env-var-shaped; the EVOLVE_ prefix is reserved). */
  name: string;
  /** Which labeled row of that name; omitted = 'default' resolution law. */
  label?: string;
  /** Env var the value lands under in the sandbox (default: the name). */
  as?: string;
}

/**
 * One INLINE env secret on a job create — the convenience door into the
 * same vault, not a second wire shape for values: the value is saved as a
 * normal env secret first (delivery as stated, `label` defaulting to
 * 'default') and the job then stores only the reference. A (name, label)
 * identity that is already a stored row splits on proof: a byte-equal
 * restatement (same value, same delivery) attaches that row — retries of
 * the same request converge — while a different value or delivery is the
 * typed `secret_exists` refusal (409); `delivery: 'brokered'` refuses as
 * `secret_brokered_unsupported` until eval trials can broker.
 */
export interface JobSecretInline {
  /** Same grammar and reserved-name law as JobSecretRef.name. */
  name: string;
  /** The secret value to vault (at most 190 bytes). Never stored on the job. */
  value: string;
  /** The saved secret's delivery mode — REQUIRED, no silent default. */
  delivery: "brokered" | "direct";
  /** The labeled row to claim in the vault (default 'default'). */
  label?: string;
  /** Same in-sandbox rename law as JobSecretRef.as. */
  as?: string;
}

/** Body of POST /api/jobs/{jobId}/resume. */
export interface ResumeRequest {
  /**
   * Which failures to resume, matched against
   * `exception_info.exception_type`. Omitted, the default set is
   * ["ScoringError", "InfrastructureError", "IncompleteTrialError"] plus
   * stopped trials (settled CANCELLED, exception type "CancelledError")
   * and still-QUEUED trials of a cancelled source.
   */
  filter_error_types?: string[];
}

/**
 * Body of POST /api/jobs/{jobId}/retry — the selection, `trial_ids` XOR
 * `failed_only`. Omitted (or `{}`) selects every trial of the (terminal)
 * job; passing both fields is a contradiction the server refuses (400).
 */
export interface RetryRequest {
  /**
   * Exactly these trials of the source job, all-or-nothing: an unknown id
   * refuses the whole request (`trial_not_found`). Each named trial must be
   * settled — SCORED, SCORING_ERROR, INFRASTRUCTURE_ERROR, INDETERMINATE,
   * or CANCELLED (`trial_not_settled` otherwise) — but the JOB may still be
   * running: a settled trial's facts are final. Duplicates are deduplicated.
   */
  trial_ids?: string[];
  /**
   * Select the source's failed trials only (SCORING_ERROR,
   * INFRASTRUCTURE_ERROR, INDETERMINATE). Stopped (CANCELLED) and scored
   * trials are not failures — name them in `trial_ids`, or use resume for
   * stopped work.
   */
  failed_only?: boolean;
}

/**
 * Optional filter narrowing which trials a job-level regrade re-runs.
 * Omitted, every regradable trial is regraded.
 */
export interface RegradeRequest {
  statuses?: TrialStatus[];
  /** Restrict to one task's trials. */
  task_name?: string;
}

// =============================================================================
// JOB — RESULT SIDE
// =============================================================================

/**
 * Per-(agent, model, dataset) statistics. The evals key format is
 * `{agent}__{model}__{dataset}` — the dataset ref is always the LAST `__`
 * segment, which is where Harbor-compatible readers recover it — with the
 * platform extension of an `__{effort}` segment inserted BEFORE the dataset
 * when a declared reasoning effort is part of the arm identity:
 * `{agent}__{model}__{effort}__{dataset}`.
 */
export interface AgentDatasetStats {
  /** Trials that produced a rewards map — rewarded, not merely settled. */
  n_trials?: number;
  /** Trials carrying `exception_info` — indeterminate and cancelled included. */
  n_errors?: number;
  /**
   * Metric results (a mean entry per arm today: the primary reward averaged
   * over EVERY trial of the group, unrewarded trials counting 0); open objects.
   */
  metrics?: Record<string, unknown>[];
  /**
   * pass@k for this group — the standard unbiased estimator
   * `1 - C(n-c, k)/C(n, k)` per task, averaged over the group's tasks. Keys
   * are k as strings (JSON object keys always are), values in [0,1]. The k set
   * is the powers of two and the multiples of five up to the group's sparsest
   * task's attempt count, so k=1 is never present and a single-attempt job
   * answers `{}`. An attempt that produced no reward counts as a FAILED
   * attempt, never an excluded one.
   *
   * `{}` means the group cannot answer: its rewards are not binary, no
   * eligible k exists, or attempts are still in flight (the statistic appears
   * once every attempt of the group has settled). `passAtK(job)` reads this
   * field into sorted numeric points.
   */
  pass_at_k?: Record<string, number>;
  /** reward key -> reward value -> trial identifiers. */
  reward_stats?: Record<string, Record<string, string[]>>;
  /** exception type -> trial identifiers. */
  exception_stats?: Record<string, string[]>;
}

/**
 * Aggregate statistics of a job. Progress counters, token totals, and measured
 * cost. The `n_*` counters are CUMULATIVE, Harbor-style: errored trials are a
 * subset of completed, cancelled a subset of errored — a cancelled trial
 * counts in all three. The disjoint per-status breakdown rides
 * `Job.trials.byStatus`. `cost_usd` is what the trials actually spent so far —
 * reporting, never a gate (enforcement is the per-trial cap).
 */
export interface JobStats {
  /** Cumulative: every trial that produced a result — errored and cancelled included. */
  n_completed_trials?: number;
  /** Cumulative: every completed trial carrying `exception_info`, cancelled included. */
  n_errored_trials?: number;
  n_running_trials?: number;
  n_pending_trials?: number;
  /** A subset of `n_errored_trials`. */
  n_cancelled_trials?: number;
  n_retries?: number;
  /** Keyed `{agent}__{model}__{dataset}` — dataset ref last, optional effort segment before it. */
  evals?: Record<string, AgentDatasetStats>;
  /** Total input tokens (cache included); null until recorded. */
  n_input_tokens?: number | null;
  n_cache_tokens?: number | null;
  n_output_tokens?: number | null;
  /**
   * Measured spend across settled trials — the WHOLE model bill, agent and
   * judge together; null before any settled.
   */
  cost_usd?: number | null;
  /**
   * Sum of the job's per-trial GPU compute ESTIMATES (each trial's
   * `gpu_cost.estimate_usd`) — a SEPARATE labeled figure, never merged into
   * `cost_usd` (metered model spend). Null when no trial of the job carries
   * an estimate; a real $0 (a GPU trial that provably never booted a
   * sandbox) keeps the sum non-null. Absent on servers predating the field.
   */
  gpu_cost_usd?: number | null;
  /**
   * The judge share of `cost_usd`, itemized: what the trials' verifier-phase
   * judge keys spent. 0 for a job with no judge-enabled tasks; null before
   * anything settled, like `cost_usd`.
   */
  judge_cost_usd?: number | null;
  /**
   * HOW MANY SETTLED TRIALS `cost_usd` CANNOT ACCOUNT FOR — trials whose
   * `spend_source` lane is `assumed_cap`, meaning nobody ever measured their
   * gateway spend. Such a trial stores 0, and the job total is the sum of its
   * trials, so each one folds a zero in and `cost_usd` comes out LOWER than
   * what was really spent. A plain count, never null: before anything settles
   * it is honestly 0, where `cost_usd` is null. It is a FLOOR — a
   * retried-away attempt's lineage snapshot keeps no spend-source column, so
   * an earlier attempt nobody measured cannot be counted here. Absent on
   * servers predating the field.
   */
  n_unmeasured_trials?: number;
  /**
   * The judge half of the same fact, itemized the way `judge_cost_usd`
   * itemizes `cost_usd`: trials that ran a judge whose spend was never
   * measured (`judge_spend_source` `assumed_cap`). 0 on jobs with no
   * judge-enabled tasks.
   */
  n_unmeasured_judge_trials?: number;
  /**
   * Aggregate of the job's trace analyses; null when no trial of this job has
   * ever been analyzed. Never a fabricated empty object — absence of analysis
   * is stated as null, here and on each trial.
   */
  analysis?: JobAnalysisStats | null;
}

/**
 * The job-level analysis aggregate — Harbor's job `analysis.json` is a flat
 * list of per-trial results (their analyze/models.py AnalyzeReport); each
 * trial's own result rides `Trial.analysis`, and this object aggregates them.
 * LATEST-per-trial: a re-analyzed trial contributes only its newest analysis,
 * matching Harbor, where a re-run overwrites the trial directory's
 * `analysis.json`.
 */
export interface JobAnalysisStats {
  /** Trials whose latest analysis produced a valid result. */
  n_completed: number;
  /**
   * Trials whose latest analysis is a stored typed failure (invalid result,
   * or an infrastructure failure of the analyzer run).
   */
  n_failed: number;
  /** Trials whose latest analysis is still queued or running. */
  n_pending: number;
  /**
   * Measured spend of the LATEST analyses summed — the analyzer's own metered
   * line, never part of `stats.cost_usd`. Null when no analysis recorded
   * measured spend (mirrors Harbor's estimated_total_cost_usd, which is None
   * when nothing was recorded).
   */
  cost_usd: number | null;
  /**
   * Per-criterion outcome tally over the completed latest analyses, keyed by
   * criterion name. Criteria are whatever the contributing rubrics named —
   * after a re-analysis under a different rubric, keys from both may appear,
   * each counting only analyses that carried it.
   */
  checks: Record<
    string,
    { n_pass: number; n_fail: number; n_not_applicable: number }
  >;
}

/**
 * GPU COMPUTE ESTIMATE of one trial — present on settled GPU trials only,
 * null on every other trial. The estimate is the trial's MEASURED
 * agent-sandbox lifetime multiplied by a versioned, source-dated rate-card
 * row (the provider's public list price per GPU-second, times `gpu_count`).
 * A SEPARATE labeled figure by law: never merged into
 * `agent_result.cost_usd`, which is metered model spend. Exactly one of
 * `estimate_usd` / `unpriced_reason` is set — an unmeasurable lifetime (a
 * reaped run) or a request that let the provider choose the device (`any`,
 * or several candidates) states its reason instead of a guessed number, and
 * a GPU trial that provably never booted a sandbox carries a real
 * `estimate_usd: 0`.
 *
 * WHICH DEVICE IS PRICED: the type the provider reported pinned to the box
 * (`attached_gpu_type`) when it reported one, else the ONE type the create
 * request carried (`resolved_gpu_types`: modal reserves exactly the task's
 * first spelling; daytona receives the task's types in its own names, in
 * order, and pins the first with capacity). The three provenance fields
 * make the choice auditable; records priced under `rate_card.version` 1
 * predate them and serve `declared_gpu_types` as the single spelling they
 * kept, the other two null.
 */
export interface TrialGpuCost {
  /** The estimate, USD, micro-dollar resolution. Null exactly when `unpriced_reason` is set. */
  estimate_usd: number | null;
  /** Why no estimate exists. Null exactly when `estimate_usd` is set. */
  unpriced_reason: string | null;
  provider: EvalSandboxProvider;
  /**
   * The rate card's billing name the rate was looked up under (e.g. `H100`):
   * the attached type when reported, else the one type the request carried.
   * Null when no single device type is known.
   */
  gpu_type: string | null;
  /** The task's own `gpu_types` list, verbatim; null when it named none (any type). */
  declared_gpu_types: string[] | null;
  /**
   * What the create request carried for the provider, in the provider's
   * spelling: modal's one reservation, daytona's ordered candidates. Null
   * when no constraint travelled, and on rate-card v1 records.
   */
  resolved_gpu_types: string[] | null;
  /** The device type the provider reported pinned to the box; null when none was reported. */
  attached_gpu_type: string | null;
  gpu_count: number;
  /** Measured sandbox lifetime, fractional seconds; null when unmeasured. */
  duration_sec: number | null;
  /** The applied list price per GPU per second; null when no rate applied. */
  rate_usd_per_gpu_sec: number | null;
  /** Which card priced this trial: version, provider pricing page, and the date it was read. */
  rate_card: { version: number; source: string | null; source_date: string | null };
  /** Observed sandbox birth (ISO); null when unmeasured. */
  measured_from: string | null;
  /** Observed sandbox end (ISO); null when unmeasured. */
  measured_to: string | null;
}

/** One pass@k number: the estimate over `k` attempts. */
export interface PassAtKPoint {
  /** How many attempts the estimate is over — always 2 or more. */
  k: number;
  /** Probability that k attempts contain at least one success, in [0,1]. */
  value: number;
}

/** One evals group's pass@k curve, ready to plot or print. */
export interface PassAtKGroup {
  /** The `stats.evals` key these numbers belong to. */
  evals_key: string;
  /** Ascending by k; never empty (a group with no numbers is not returned). */
  points: PassAtKPoint[];
}

/**
 * Read a job's pass@k out of `stats.evals`, as numbers instead of the wire's
 * string keys. Groups that cannot answer (empty `pass_at_k` — non-binary
 * rewards, no eligible k, or attempts still in flight) are left out entirely,
 * so an empty array means "this job has no pass@k to show", and the shape is
 * the same whether the job is running or finished.
 *
 * Pure reading: no request is made, nothing is recomputed. The numbers are the
 * platform's, and the same ones the job's download archive carries.
 */
export function passAtK(job: Job): PassAtKGroup[] {
  const evals = job.stats?.evals ?? {};
  const groups: PassAtKGroup[] = [];
  for (const evals_key of Object.keys(evals).sort()) {
    const raw = evals[evals_key]?.pass_at_k ?? {};
    const points: PassAtKPoint[] = [];
    for (const key of Object.keys(raw)) {
      const k = Number(key);
      const value = raw[key];
      if (!Number.isFinite(k) || typeof value !== "number" || !Number.isFinite(value)) {
        continue;
      }
      points.push({ k, value });
    }
    if (points.length === 0) continue;
    points.sort((a, b) => a.k - b.k);
    groups.push({ evals_key, points });
  }
  return groups;
}

/**
 * Provenance of an UPLOADED job (`jobs().upload()`) — what the archive's own
 * record files said about themselves: the job id its result.json carried and
 * the job_name its config.json carried (each null when the file did not state
 * one — never fabricated), plus when the platform ingested it. The
 * platform-minted row ids replace the archive's ids everywhere else on the
 * surface; these fields are where the originals remain readable. Null on
 * every job this platform executed; non-null marks a terminal RECORD — resume,
 * retry and regrade refuse it (`job_uploaded`), analyze works on it unchanged.
 */
export interface UploadProvenance {
  original_job_id: string | null;
  original_job_name: string | null;
  uploaded_at: string;
  /**
   * The job-level sum of the trials' `upload.reported_agent_result` figures
   * — the uploader's own claims aggregated once at ingest, REPORTED like
   * their per-trial parts and never entering the platform-metered fields
   * (`stats.cost_usd` and the token stats stay null for an uploaded job).
   * Each total sums the trials that reported that field and is null when
   * none did (a zero would be a claim); `n_trials_reporting` counts the
   * trials that carried any reported figure, against the job's
   * `n_total_trials` — the honesty note for a partially reporting archive.
   * Null only on jobs ingested before this field existed.
   */
  reported_totals: {
    cost_usd: number | null;
    n_input_tokens: number | null;
    n_cache_tokens: number | null;
    n_output_tokens: number | null;
    n_trials_reporting: number;
  } | null;
}

/**
 * The deletion receipt of `DELETE /api/jobs/{jobId}`: what was destroyed.
 * The contract's own minimal shape — Harbor's hub delete answers no wire
 * body, so there was no shape to mirror. `trials_deleted` counts the trial
 * rows destroyed with the job (their trace events, attempts and stored
 * trace objects went with them); `analyses_deleted` the trial-analysis
 * rows, their stored analyzer streams included.
 */
export interface JobDeleteResult {
  /** The deleted job. */
  job_id: string;
  trials_deleted: number;
  analyses_deleted: number;
}

/**
 * Why a job FAILED — deliberately NOT under the key `error`, which on this
 * surface always means "this request failed". `if (body.error) throw` stays
 * correct on a healthy 200 read of a failed job.
 */
export interface JobFailure {
  /** `job_execution_failed` when the runner recorded no code. */
  code: string;
  message: string;
}

/**
 * One dataset of a job whose selection excluded tasks that FAILED to build
 * (the partial-publish model). `note` is the sentence to show, and the
 * structured fields beside it are the same fact for a UI: `n_tasks_selected`
 * is how many READY tasks the caller's filters matched BEFORE any `n_tasks`
 * cap, `n_tasks_ran` how many the job actually ran from this dataset (fewer
 * than `n_tasks_selected` only under an `n_tasks` cap), and
 * `n_tasks_failed_to_build` what the filters would have taken but the build
 * lost. Uncapped, the note reads "ran N of M tasks — K failed to build" with
 * M = n_tasks_selected + K; capped it reads "selection matched M tasks:
 * K failed to build: …; ran R (n_tasks cap)" — the run was short for two
 * separate reasons and the sentence keeps them apart. `failed_task_names`
 * names every one, sorted; the reasons live on the dataset's `failed_tasks`
 * and the per-task build route (datasets().getTaskBuild()). (Jobs recorded
 * before `n_tasks_selected` existed answer it as `n_tasks_ran` — read as
 * uncapped.)
 */
export interface JobBuildExclusion {
  dataset: DatasetRef;
  n_tasks_ran: number;
  n_tasks_selected: number;
  n_tasks_failed_to_build: number;
  failed_task_names: string[];
  note: string;
}

/**
 * THE job body — the same shape from create, get, list items, cancel, resume,
 * and regrade responses; no field appears on some responses and not others.
 */
export interface Job {
  id: string;
  /** User-facing label. */
  job_name: string;
  status: JobStatus;
  /** The resolved dataset references this job ran. */
  datasets: DatasetRef[];
  agents: AgentArm[];
  n_attempts: number;
  n_concurrent_trials: number;
  /** The resolved per-trial cap every trial key was minted with. */
  max_trial_spend_usd: number;
  /**
   * The most this job can cost: every trial spending its whole cap on every
   * attempt the retry policy allows — cap x trials x (retry.max_retries + 1),
   * since each attempt is minted its own full cap. Stated outright — the
   * per-trial cap is the only enforcement, so the product is the number
   * someone approving a 500-trial run actually needs to see.
   */
  worst_case_spend_usd: number;
  /** The RESOLVED auto-retry policy this job runs under. */
  retry: RetryConfig;
  /**
   * The resolved embedded-analysis policy the job was created with; null when
   * the create named none (a later manual `analyze()` does not rewrite it —
   * the job row states what the CREATE asked for, each analysis states what
   * IT ran under). Always null on a regrade job.
   */
  analyze: AnalyzeConfig | null;
  /**
   * The RESOLVED timeout multipliers this job's phases arm under — Harbor's
   * five flat JobConfig fields, echoed on every job body. The global one is
   * always a number (1.0 when the create request named none); each phase
   * field is null when not overridden, meaning the global applies.
   */
  timeout_multiplier: number;
  agent_timeout_multiplier: number | null;
  verifier_timeout_multiplier: number | null;
  agent_setup_timeout_multiplier: number | null;
  environment_build_timeout_multiplier: number | null;
  /**
   * Where this job's trials execute. Null exactly on an UPLOADED job
   * (`upload` non-null): an ingested record never executed on any platform
   * sandbox, and naming a provider would be an execution claim. Never null
   * on a job this platform ran.
   */
  sandbox_provider: EvalSandboxProvider | null;
  /** Entity cardinality only — things with no status of their own. */
  counts: { agents: number; tasks: number };
  /**
   * THE RESULTS-HONESTY LABEL of the partial-publish model: one entry per
   * dataset of this job whose selection excluded tasks that FAILED to build
   * — a whole-dataset (or glob) run over a partially built version runs the
   * READY tasks, and this field is where the job says so plainly instead of
   * silently truncating. Always present; empty when nothing was excluded
   * (every selected dataset fully built, or every failed task was already
   * outside the caller's own filters). Recorded at create and immutable;
   * derived jobs (resume/retry) answer empty — their honesty lives on the
   * source job.
   */
  build_exclusions: JobBuildExclusion[];
  n_total_trials: number;
  /** The zeros-included 8-status histogram, beside the coarser counters in `stats`. */
  trials: TrialStatusTally;
  stats: JobStats;
  /** Why the job FAILED, or null. Never the key `error` — see JobFailure. */
  failure: JobFailure | null;
  /** Empty for an original job. */
  source_jobs: SourceJob[];
  /** Derived: any source_jobs entry with action "regrade". */
  is_regrade: boolean;
  /**
   * The upload provenance echo — null for every job this platform executed,
   * non-null only on a job ingested by jobs().upload(). See UploadProvenance.
   */
  upload: UploadProvenance | null;
  /** True only on a response that replayed an existing job for an Idempotency-Key. */
  idempotent_replay: boolean;
  started_at: string;
  updated_at: string;
  /** Null while the job is live. */
  finished_at: string | null;
}

// =============================================================================
// TRIAL
// =============================================================================

/**
 * A phase's wall-clock as a start/stop pair (never a duration). Either bound
 * is null while the phase has not reached it.
 */
export interface TimingInfo {
  started_at: string | null;
  finished_at: string | null;
}

export interface ModelInfo {
  name: string;
  /** Null means "not specified", never "unknown provider". */
  provider?: string | null;
}

/**
 * The agent that ran a trial. `version` is the version actually RESOLVED and
 * used (null until resolved) — the requested pin lives on the job's
 * `agents[].version`. `reasoning_effort` is the platform's arm-identity
 * extension.
 */
export interface AgentInfo {
  name: string;
  version: string | null;
  model_info: ModelInfo;
  reasoning_effort?: string | null;
}

/**
 * What the agent phase produced and consumed. `n_input_tokens` includes cache
 * tokens. `cost_usd` is the settled spend (see `spend_source` on the trial for
 * which lane it came from, and whether it is final). `metadata` carries open
 * per-run detail:
 * the harness bundle digest and runtime, the network mode the trial ran under
 * and where that decision came from, and any harness-reported usage detail.
 */
export interface AgentResult {
  n_input_tokens?: number | null;
  n_cache_tokens?: number | null;
  n_output_tokens?: number | null;
  /** Null until the trial has executed; null never means $0. */
  cost_usd?: number | null;
  /** Reserved for token-level rollout detail; null today. */
  rollout_details?: Record<string, unknown>[] | null;
  metadata?: Record<string, unknown> | null;
}

/**
 * What the verifier phase's LLM judge consumed — the judge half of a trial's
 * model bill. A judge-enabled task's verifier holds a DISTINCT short-lived
 * gateway key (scoped to the requested credential's model family only, minted
 * at verify start, revoked after scoring; judge model selection itself is
 * Harbor-exact — the rubric names the model, or rewardkit's own library
 * default applies), and these figures are that key's spend and tokens as the platform
 * measured them at the gateway — never anything the verifier reported about
 * itself. `cost_usd` is the judge share alone; `agent_result.cost_usd` stays
 * the agent's, and the trial's whole bill is the sum. See `judge_spend_source`
 * on the trial for which lane the figure is in.
 */
export interface JudgeResult {
  n_input_tokens?: number | null;
  n_cache_tokens?: number | null;
  n_output_tokens?: number | null;
  /** Null until measured; null never means $0. */
  cost_usd?: number | null;
}

/**
 * One criterion's verdict — Harbor's QualityCheckModel verbatim (their
 * cli/quality_checker/models.py `{explanation, outcome}`).
 */
export interface AnalysisCheck {
  outcome: "pass" | "fail" | "not_applicable";
  /** The analyzer's rationale, citing trial evidence. */
  explanation: string;
}

/**
 * Why an analysis FAILED — a stored typed failure, never a silent absence and
 * never a fake pass. NOT under the key `error` for the same reason JobFailure
 * is not.
 */
export interface AnalysisFailure {
  /**
   * Which part failed: `invalid_result` (the analyzer ran but its
   * analysis.json failed validation — the message preserves every validator
   * reason, one per line), `inputs` (the trial tree or task content could not
   * be assembled), or an infrastructure stage of the analyzer run
   * (`mint_key`, `boot`, `harness_install`, `agent`, `artifact_read`,
   * `lease_expired`, ...).
   */
  phase: string;
  message: string;
}

/**
 * One trace analysis of a trial. The result half is Harbor's AnalyzeResult
 * verbatim (their analyze/models.py: `summary`, `checks` keyed by criterion,
 * `estimated_cost_usd`; the enclosing trial is Harbor's `trial_name`); the
 * rest is provenance — which model and rubric THIS analysis ran under, its
 * lifecycle status, and its typed failure when it failed.
 *
 * `estimated_cost_usd` is the analyzer agent's OWN metered spend (its sealed
 * sandbox runs on its own capped gateway key) — its own line, never part of
 * the trial's `agent_result.cost_usd` or the job's `stats.cost_usd`; the job
 * aggregate is `stats.analysis.cost_usd`. Null when nothing was measured,
 * never a fabricated 0.
 */
export interface TrialAnalysis {
  id: string;
  /**
   * Provenance: the analyzed trial, its job, and its task. Redundant on
   * `Trial.analysis` (the trial is the enclosing object) and the whole point
   * of a `analyses().list()` row, where nothing else says which run the
   * verdict judged. Harbor's `trial_name` names the same thing by directory.
   */
  trial_id: string;
  job_id: string;
  task_name: string;
  /**
   * Lifecycle of this analysis. Every non-terminal analysis reaches
   * `completed` or `failed`; a worker death mid-run is reaped to a typed
   * `failed`, never left `running` forever.
   */
  status: AnalysisStatus;
  model_name: string;
  rubric: Rubric;
  /**
   * 3–5 sentence overview of what happened during the trial (Harbor's
   * summary contract, analyze/prompts/analyze.txt). Null until completed.
   */
  summary: string | null;
  /**
   * One entry per rubric criterion, keys exactly the rubric's criterion names
   * (the frozen-criteria law). Null until completed.
   */
  checks: Record<string, AnalysisCheck> | null;
  estimated_cost_usd: number | null;
  /**
   * The analyzer's one-home usage reading — the SAME object, same keys, the
   * trial and session surfaces serve, built from the analyzer's OWN gateway
   * records. Present and ticking while the analysis runs — a mid-run reading
   * is a lagging LOWER BOUND, always `provisional: true` — and settled by
   * the same read that writes `estimated_cost_usd`, which stays Harbor's
   * word for the FINAL figure. Null = the meter never answered, never zero.
   * Absent on servers predating the field.
   */
  usage?: UsageReading | null;
  /**
   * How many analyzer attempts this analysis has made: 1, or 2 when the
   * bounded automatic re-run fired. An analyzer run that completes without
   * producing a valid analysis.json (the missing file included) is re-run
   * at most once — same model, same frozen rubric, fresh sandbox — and a
   * second failure of that class settles `failed` with phase
   * `invalid_result`, both attempts recorded. Infrastructure failures never
   * auto re-run. When the re-run fired, `estimated_cost_usd` and the token
   * totals cover BOTH attempts. Absent on servers predating the field.
   */
  attempts?: number;
  /** Non-null exactly when status is `failed`. */
  failure: AnalysisFailure | null;
  /** When this analysis was enqueued. */
  created_at: string;
  /** When it settled; null while queued or running. */
  finished_at: string | null;
}

/**
 * The verifier's rewards map. The primary-reward convention: the value under
 * the key "reward"; else, when exactly one key exists, that value; else no
 * primary reward. Zero is a reward.
 */
export interface VerifierResult {
  rewards?: Record<string, number> | null;
}

/**
 * Why a trial failed, when it did. `exception_type` is one of the platform's
 * stable failure names (ScoringError, InfrastructureError, CancelledError,
 * IncompleteTrialError) — but filter with `Trial.status`, which is the primary
 * key for failure classes; this is the detail.
 */
export interface ExceptionInfo {
  exception_type: string;
  /** Truncated to 2000 chars on list rows; full on the detail route. */
  exception_message: string;
  /** Empty when the platform recorded no traceback. */
  exception_traceback?: string;
  occurred_at: string;
}

/**
 * What ONE step of a multi-step task produced. Present on
 * `Trial.step_results`, one entry per step the trial actually RAN, in execution
 * order — a trial that stopped early (a step raised, or its `min_reward` was
 * not met) carries only the steps that ran, because the ones after an abort did
 * not happen.
 *
 * `verifier_result` null means this step produced no verifier result at all (it
 * crashed, the step aborted before reaching it, or verification was disabled);
 * a result whose `rewards` is null means the verifier ran and produced no
 * reward map. The distinction decides the trial's reward: the mean strategy
 * excludes a step with no result from its denominator, but counts a result with
 * no rewards as zero.
 *
 * `agent_result` is null when no per-step spend was measured — never a
 * per-step $0.
 */
export interface StepResult {
  step_name?: string;
  agent_result?: AgentResult | null;
  verifier_result?: VerifierResult | null;
  exception_info?: ExceptionInfo | null;
  agent_execution?: TimingInfo | null;
  verifier?: TimingInfo | null;
}

/**
 * The ONE public trial shape, shared verbatim by list rows and the detail
 * route (detail returns `exception_info.exception_message` untruncated — the
 * only documented difference). A trial id is globally addressable; `job_id` is
 * the reverse pointer.
 *
 * Execution facts (`sandbox_provider`, `verifier_environment_mode`,
 * `agent_result.cost_usd`, `spend_source`) are null until the trial has
 * actually executed: a QUEUED or CANCELLED trial never ran, so null means
 * "did not run" and never zero.
 */
export interface Trial {
  id: string;
  job_id: string;
  task_name: string;
  /** The dataset this trial's task came from. */
  source: string;
  agent_info: AgentInfo;
  /** Attempt index within the arm (1..n_attempts). */
  attempt: number;
  status: TrialStatus;
  /**
   * Convenience primary reward derived from `verifier_result.rewards` by the
   * primary-reward convention. Zero is a reward; null means the trial did not
   * score.
   */
  reward: number | null;
  verifier_result: VerifierResult | null;
  exception_info: ExceptionInfo | null;
  agent_result: AgentResult | null;
  /**
   * The judge share of the trial's bill, itemized. Null when no judge ever
   * ran — the task requested no judge credential, or the trial never reached
   * its verify phase. Null never means "$0 of judging".
   */
  judge_result?: JudgeResult | null;
  /**
   * The trial's LATEST trace analysis; null when the trial has never been
   * analyzed — never a fabricated empty object. A re-analysis (same job,
   * different rubric or model) replaces what this field serves, matching
   * Harbor, where a re-run overwrites the trial directory's analysis.json;
   * earlier analyses stay stored as the audit record.
   */
  analysis?: TrialAnalysis | null;
  environment_setup: TimingInfo | null;
  agent_setup: TimingInfo | null;
  agent_execution: TimingInfo | null;
  /**
   * The verifier COMMAND window — the graded command alone, and not the work
   * that prepared it. On a SHARED-mode trial the preparation that runs first
   * is reported beside this pair as `shared_verify_setup`. Read this pair
   * against `verifier_timeout_sec` and nothing else.
   */
  verifier: TimingInfo | null;
  /**
   * How long the trial sat claimable before a worker began it. It ends at the
   * run's beginning, which is APPROXIMATELY — not exactly — where
   * `environment_setup` starts, so never treat the two pairs as adjacent. The
   * open bound is when the row became claimable, which for a retried trial is
   * its backoff deadline rather than its creation: this never bills the
   * attempt that failed before it.
   */
  queue_wait: TimingInfo | null;
  /**
   * The harness bundle resolve, NESTED inside `environment_setup`. A miss that
   * actually BUILT also carries the publish upload back to the shared bundle
   * store, which the building caller waits out inside this window — a trial
   * that joined someone else's build, or hydrated the bytes from that store,
   * pays neither. Read with `harness_bundle_cache_hit`.
   */
  harness_bundle: TimingInfo | null;
  /**
   * The provider image/snapshot/template ensure, also NESTED inside
   * `environment_setup` and excluding the boot that follows it. Near-zero on
   * modal BY DESIGN — modal pre-builds nothing, so the real pull-and-cache
   * happens provider-side when the box is created — so never compare it across
   * providers raw.
   */
  image_prepare: TimingInfo | null;
  /**
   * What a SHARED-mode verify did BEFORE its command — the judge key mint, the
   * rewardkit bundle resolve and upload, the test-file uploads, the env write.
   * It ends exactly where `verifier` begins, and the two never overlap.
   * Null on separate-mode trials, on multi-step trials (which verify per step
   * and report no trial-level verifier window), and on anything that settled
   * before the pair was recorded — never a zero-length pair standing in for
   * "did not happen".
   */
  shared_verify_setup: TimingInfo | null;
  /**
   * True when the bundle resolve served bytes already on the worker. False
   * covers every path that had to produce them — a shared-store hydrate, a
   * builder run, or joining another trial's in-flight build. Null is
   * unrecorded (a trial older than these timers, or one whose resolve failed),
   * never "miss".
   */
  harness_bundle_cache_hit: boolean | null;
  /**
   * Per-step results for a multi-step task, in execution order. Null on every
   * single-step trial — "this trial has no steps", never "it ran zero of
   * them". A trial that stopped early carries only the steps that ran.
   */
  step_results: StepResult[] | null;
  /** Which lane `agent_result.cost_usd` came from — see SpendSource; only "measured" is final. */
  spend_source: SpendSource | null;
  /**
   * Which lane `judge_result.cost_usd` is in — the same three-lane vocabulary
   * as `spend_source`, same rules. Null exactly when `judge_result` is null:
   * no judge ever ran.
   */
  judge_spend_source?: SpendSource | null;
  /**
   * A mid-run LOWER BOUND on spend, never the trial's cost. Only ever climbs
   * while the trial runs, and is CLEARED when the trial settles — on a
   * terminal trial read `agent_result.cost_usd` and `spend_source`; those are
   * the settled truth. Null is "no reading yet", never $0.
   */
  live_spent_usd: number | null;
  /** When that reading was taken — show its age, never the figure alone. */
  live_spend_at: string | null;
  /**
   * THE ONE-HOME USAGE READING: spend so far plus the token breakdown from
   * the same gateway records, `provisional` saying whether the numbers can
   * still grow — present and ticking while the trial runs, settled once the
   * lane is `measured`. The overlapping fields (`agent_result` tokens,
   * `live_spent_usd`, `spend_source`) remain for their existing readers; this
   * is where a client reads the whole answer at once, with the same keys the
   * managed-agents session surfaces serve. Null = the meter never answered,
   * never zero. Absent on servers predating the field.
   */
  usage?: UsageReading | null;
  /**
   * The cap THIS trial's gateway key carried — history, which can differ from
   * the job's current cap for rows settled before a change.
   */
  max_trial_spend_usd: number | null;
  sandbox_provider: EvalSandboxProvider | null;
  /**
   * Present when this trial's task declared GPUs the job's stamped provider
   * could not allocate, so the trial ran on modal instead: `from` is the
   * job's request, `to` where the boxes actually ran, `reason` the refusing
   * provider's own sentence. Null on every other trial; absent on servers
   * predating the field.
   */
  sandbox_provider_degrade?: {
    from: EvalSandboxProvider;
    to: EvalSandboxProvider;
    reason: string;
  } | null;
  /**
   * GPU compute ESTIMATE — measured sandbox lifetime x the platform's
   * versioned, source-dated rate card (see TrialGpuCost). Present on settled
   * GPU trials only; null on every other trial, and never merged into
   * `agent_result.cost_usd`. Absent on servers predating the field.
   */
  gpu_cost?: TrialGpuCost | null;
  /** Provider id of the box the agent executed in; null when none booted. */
  sandbox_id: string | null;
  /** The separate verifier box; null in shared mode or when never reached. */
  verifier_sandbox_id: string | null;
  verifier_environment_mode: VerifierEnvironmentMode | null;
  /**
   * Which step a RUNNING trial is in, so a polling caller can tell a slow
   * build from a slow agent. Null when the trial is not mid-phase.
   */
  attempt_phase: AttemptPhase | null;
  /**
   * Automatic retries this trial consumed (0 = never retried). The trial
   * body always shows the LATEST attempt; `retries` holds the lineage.
   */
  n_retries: number;
  /**
   * Attempt lineage: earlier attempts whose failure was retried away, oldest
   * first. The final attempt's outcome is the trial body itself and is not
   * repeated here; a never-retried trial answers [].
   */
  retries: TrialRetry[];
  /** Reference to the agent session/trace, when recorded. */
  session_ref: string | null;
  /**
   * Provenance of an UPLOADED trial (its job's `upload` is non-null): the
   * identity and reported figures the archive's own record files carried.
   * Null for every trial this platform executed. An uploaded trial keeps
   * its execution facts (`sandbox_provider`, `agent_result`, `usage`,
   * `spend_source`) null forever — this platform's meter never saw the run;
   * the archive's own figures live under `upload.reported_agent_result` and
   * nowhere else.
   */
  upload: TrialUploadProvenance | null;
  started_at: string | null;
  finished_at: string | null;
}

/**
 * What the uploaded archive said about THIS trial: its own ids, the full
 * task name verbatim, and the uploader's own usage figures. REPORTED means
 * exactly that — `reported_agent_result` is the archive's claim, served for
 * the reader; it never populates the platform-metered fields
 * (`agent_result`, `usage`, `spend_source`), which stay null because this
 * platform's meter never saw the run.
 */
export interface TrialUploadProvenance {
  /** The archive trial result.json's own `id`; null when it stated none. */
  original_trial_id: string | null;
  /** The archive's own `trial_name` (the trial directory). */
  original_trial_name: string;
  /**
   * The archive's task name VERBATIM — possibly registry-qualified
   * (`org/name`); the trial's `task_name` serves the parsed leaf.
   */
  original_task_name: string;
  /**
   * The uploaded `agent_result`'s own token and cost figures, or null when
   * the archive carried none. Uploader-reported, never platform-measured.
   */
  reported_agent_result: {
    n_input_tokens: number | null;
    n_cache_tokens: number | null;
    n_output_tokens: number | null;
    cost_usd: number | null;
  } | null;
}

/**
 * One retired attempt of a trial — the terminal facts preserved when the
 * auto-retry scheduler put the trial back on the queue. Its `cost_usd` is
 * REAL money the job total includes; the trial's own `agent_result.cost_usd`
 * carries only the final attempt's.
 */
export interface TrialRetry {
  /** 1-based dispatch number within this trial. */
  attempt_number: number;
  exception_info: ExceptionInfo;
  /** What THIS attempt spent; null when nothing was recorded. */
  cost_usd: number | null;
  /** When the attempt was claimed. */
  started_at: string | null;
  /** When its failure settled (and the retry was scheduled). */
  settled_at: string | null;
}

/** Per-id outcome of POST /api/trials/stop; every requested id appears in exactly one list. */
export interface StopResponse {
  /** Trials killed and settled by this request, with their settled rows. */
  stopped: Trial[];
  /**
   * Trace analyses killed and settled by this request, with their settled
   * rows (`failed`, failure phase `stopped`). Always served; a separate list
   * because `stopped` is an array of Trial.
   */
  stopped_analyses: TrialAnalysis[];
  /** Ids that were already terminal; untouched. */
  already_terminal: string[];
  /** Ids that do not exist or are not the caller's. */
  not_found: string[];
}

/**
 * One parsed trace event of a trial's transcript. `seq` orders the stream and
 * is the paging cursor. `data` is the harness-native payload, deliberately
 * open.
 */
export interface TraceEvent {
  /** Monotonic sequence number (the resume position). */
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

/**
 * One page of a trial's trace — trials().trace().
 *
 * Same envelope as every other collection, and nextCursor means the same
 * thing: pass it back as { cursor } for the next page, and NULL MEANS CAUGHT
 * UP. To resume a poll later, keep the last event's `seq` and pass it as
 * { cursor } — the trace's cursor IS its position in the seq timeline.
 */
export type TraceEventPage = Page<TraceEvent>;

// =============================================================================
// COMPARE
// =============================================================================

/** How many of the trials behind an aggregate were SCORED (means cover SCORED only). */
export interface CompareCoverage {
  scored: number;
  total: number;
}

/**
 * One (task, job) cell. `status` is a TrialStatus when every trial in the cell
 * shares it, "MIXED" when they differ, "MISSING" when the job has no trials
 * for the task.
 */
export interface CompareCell {
  job_id: string;
  status: TrialStatus | "MIXED" | "MISSING";
  /** Mean reward over the cell's SCORED trials; null when none. Zero is a reward. */
  mean_reward: number | null;
  coverage: CompareCoverage;
}

/** One matrix row of jobs().compare(): a task across the compared jobs */
export interface CompareTaskRow {
  task_name: string;
  /** True when the jobs' cells differ in status or reward for this task */
  disagreement: boolean;
  /** Cells in the caller's job-id order */
  cells: CompareCell[];
}

/** Per-job aggregate of jobs().compare() */
export interface CompareJobAggregate {
  id: string;
  datasets: DatasetRef[];
  status: JobStatus;
  /** Mean reward over SCORED trials only; null when none. Zero is a reward. */
  mean_reward: number | null;
  coverage: CompareCoverage;
  cost_usd: number;
  agents: AgentArm[];
  started_at: string;
}

/**
 * Result of jobs().compare([ids]): per-job aggregates plus a per-task matrix
 * (disagreement rows first). `taskMatrix` is a frozen camelCase wire key.
 */
export interface CompareResponse {
  /** Aggregates in the caller's id order */
  jobs: CompareJobAggregate[];
  taskMatrix: CompareTaskRow[];
}

// =============================================================================
// SSE EVENTS
// =============================================================================

/** Fields every job event carries, whatever its type. */
interface JobEventBase {
  /** Monotonic sequence number (SSE id; the Last-Event-ID resume position) */
  seq: number;
}

/** The job's resolved creation inputs, echoed so a watcher that joined late knows what it is watching. */
export interface JobCreatedData {
  datasets: DatasetRef[];
  task_count: number;
  agents: AgentArm[];
  n_attempts: number;
  n_concurrent_trials: number;
  max_trial_spend_usd: number;
  sandbox_provider: EvalSandboxProvider;
  trial_count: number;
  /** The resolved auto-retry policy the job runs under. */
  retry: RetryConfig;
  /**
   * The resolved timeout multipliers (the same five flat fields the job body
   * echoes); events older than the feature replay as every phase at 1.0.
   */
  timeout_multiplier: number;
  agent_timeout_multiplier: number | null;
  verifier_timeout_multiplier: number | null;
  agent_setup_timeout_multiplier: number | null;
  environment_build_timeout_multiplier: number | null;
}

export interface JobCancellingData {
  job_id: string;
  /** Queued trials cancelled outright by the request */
  cancelled_trials: number;
  /** Trials still in flight, winding down before the job settles */
  active_trials: number;
}

export interface JobCancelledData {
  job_id: string;
  /** Total queued trials cancelled across the request and the settle */
  cancelled_trials: number;
}

export interface TrialRunningData {
  trial_id: string;
  task_name: string;
}

export interface TrialScoringData {
  trial_id: string;
  /** Bytes of agent stdout retained for the failure detail */
  captured_bytes?: number;
}

/**
 * A mid-run spend sample landed on a still-live trial. Emitted only when the
 * reading actually updated a RUNNING/SCORING row, so a poll that raced the
 * settle never fires one. The token sums come from the same ledger aggregation
 * that produced the money figure, present only when the sample carried them —
 * an older event replays without them.
 */
export interface TrialSpendData {
  trial_id: string;
  task_name: string;
  /** The same lagging lower bound as Trial.live_spent_usd — not the trial's cost */
  live_spent_usd: number;
  /** Input tokens so far; includes cache tokens */
  n_input_tokens?: number;
  /** Cached input tokens so far (a subset of n_input_tokens) */
  n_cache_tokens?: number;
  /** Output tokens so far */
  n_output_tokens?: number;
}

/**
 * A trial reached a terminal status. `reward` is present only on the scored
 * path; `exception_type` and `exception_message` only on a failure (a cancel
 * carries `exception_type` alone — see `exception_message`); `attempt_phase`
 * appears when the settle happened mid-phase (worker death), which is exactly
 * when knowing the phase is worth having.
 */
export interface TrialSettledData {
  trial_id: string;
  task_name: string;
  status: TrialStatus;
  /** Zero is a reward; absent means the trial did not score. */
  reward?: number | null;
  exception_type?: string;
  /**
   * The failure in its own words — the same text the trial's
   * `exception_info.exception_message` holds at settle time (a later
   * auto-retry verdict is appended to the trial's copy, never to this
   * frame's). Present only on a failure, beside `exception_type`. Two settled
   * frames carry `exception_type` alone: a cancel (`CancelledError` — stopped,
   * not failed; no words are stored) and an event recorded before this field
   * existed.
   */
  exception_message?: string;
  attempt_phase?: AttemptPhase | null;
}

/**
 * The auto-retry policy put a failed trial back on the queue. Follows the
 * `trial.settled` of the failure it retries — a watcher that treats
 * `trial.settled` as final must check for a following `trial.retrying` on
 * the same trial. The trial runs again no earlier than `delay_sec` from
 * this event.
 */
export interface TrialRetryingData {
  trial_id: string;
  task_name: string;
  /** Which retry this is (1-based). */
  retry: number;
  /** The policy's budget, for "retry 2/3" displays. */
  max_retries: number;
  /** The backoff applied before the trial is claimable again. */
  delay_sec: number;
  /** The exception name the adjudication ran under. */
  exception_type: string;
}

/**
 * One server-sent event from jobs().watch(), as a DISCRIMINATED UNION on
 * `type` and ONLY on `type`: several event types carry identically shaped
 * payloads (`job.running` and `job.completed` are both `{job_id}`), so payload
 * shape can never route a reader — the `type` constant does. Switching on
 * `type` narrows `data`.
 *
 * job.failed is declared terminal by the event stream and by this SDK, but NO
 * SERVER PATH EMITS IT today. It stays in the union because both consumers
 * treat it as terminal — the payload is fixed now so a client written today
 * parses it when it first appears. Treat it as RESERVED rather than expected.
 */
export type JobEvent =
  | (JobEventBase & { type: "job.created"; data: JobCreatedData })
  | (JobEventBase & { type: "job.running"; data: { job_id: string } })
  | (JobEventBase & { type: "job.cancelling"; data: JobCancellingData })
  | (JobEventBase & { type: "job.cancelled"; data: JobCancelledData })
  | (JobEventBase & { type: "job.completed"; data: { job_id: string } })
  | (JobEventBase & { type: "job.failed"; data: { job_id: string } })
  | (JobEventBase & { type: "trial.running"; data: TrialRunningData })
  | (JobEventBase & { type: "trial.scoring"; data: TrialScoringData })
  | (JobEventBase & { type: "trial.spend"; data: TrialSpendData })
  | (JobEventBase & { type: "trial.settled"; data: TrialSettledData })
  | (JobEventBase & { type: "trial.retrying"; data: TrialRetryingData });

/**
 * The handle returned by jobs().watch(). It is both:
 * - a promise for the final Job — `await client.watch(id)` resolves once
 *   the job reaches a terminal status (the original form); and
 * - an async iterable of events — `for await (const event of client.watch(id))`
 *   yields each JobEvent and completes on the terminal event.
 *
 * Pick one form per call: both drive the same underlying SSE stream, so a
 * single handle should not be awaited and iterated at once.
 */
export interface JobWatch extends Awaitable<Job>, AsyncIterable<JobEvent> {}

/** Cursor page of jobs (newest first) */
export type JobPage = Page<Job>;

/**
 * The handle returned by jobs().list(). Both:
 * - a promise for a single JobPage — `await client.list({ limit })`
 *   returns one page (the original form); and
 * - an async iterable — `for await (const item of client.list())` walks every
 *   job across cursor pages, fetching the next page for you.
 */
export interface JobList extends Awaitable<JobPage>, AsyncIterable<Job> {}

/** Cursor page of trace analyses (newest first) */
export type AnalysisPage = Page<TrialAnalysis>;

/**
 * The handle returned by analyses().list(). Both a promise for one page and
 * an async iterable across cursor pages, like every other list handle.
 */
export interface AnalysisList extends Awaitable<AnalysisPage>, AsyncIterable<TrialAnalysis> {}

/**
 * One task's rollup within a job: its trial tally, mean reward over SCORED
 * trials, and measured cost. Sits between the job body and the trial list so
 * a caller need not fetch every trial to see which tasks are dragging.
 */
export interface JobTaskRollup {
  task_name: string;
  /** The dataset the task came from. */
  source: string;
  trials: TrialStatusTally;
  /** Mean over SCORED trials only; null when none. Zero is a reward. */
  mean_reward: number | null;
  /** Measured spend across the task's settled trials. */
  cost_usd: number | null;
}

/** Cursor page of per-task rollups */
export type JobTaskRollupPage = Page<JobTaskRollup>;

/**
 * The handle returned by jobs().tasks(). Both a promise for one page and an
 * async iterable across cursor pages, like every other list handle.
 */
export interface JobTaskRollupList
  extends Awaitable<JobTaskRollupPage>,
    AsyncIterable<JobTaskRollup> {}

/** Cursor page of trials */
export type TrialPage = Page<Trial>;

/**
 * The handle returned by jobs().trials(). Both:
 * - a promise for a single TrialPage — `await client.trials(id, { limit })`
 *   returns one page (the original form); and
 * - an async iterable — `for await (const trial of client.trials(id))` walks
 *   every trial across cursor pages, fetching the next page for you.
 */
export interface TrialList extends Awaitable<TrialPage>, AsyncIterable<Trial> {}

// =============================================================================
// DATASETS
// =============================================================================

/**
 * Dataset version lifecycle state (wire values). Terminal: READY, FAILED,
 * ARCHIVED. RECEIVING sits before the walk (register-first): the corpus is
 * still uploading through its resumable session — the row exists so the
 * publish is visible from the first byte, and moves to IMPORTING when the
 * upload completes and the publish is accepted.
 */
export type DatasetVersionState =
  | "DRAFT"
  | "RECEIVING"
  | "IMPORTING"
  | "BUILDING"
  | "READY"
  | "FAILED"
  | "ARCHIVED";

/** One dataset.toml author: a name, and an email when the manifest gives one. */
export interface DatasetManifestAuthor {
  name: string;
  email: string | null;
}

/**
 * The metadata half of the Harbor dataset.toml manifest a version imported
 * under. The full manifest additionally pins per-task/per-file content
 * digests — verified server-side at import (a mismatch FAILS the import,
 * `manifest_digest_mismatch`) and readable in the retained package; the wire
 * carries identity + metadata.
 */
export interface DatasetManifestMetadata {
  /** The manifest's own dataset name, Harbor `org/name` format. */
  name: string;
  /** The manifest's `[dataset].version`; null when it declares none. */
  version: string | null;
  description: string;
  authors: DatasetManifestAuthor[];
  keywords: string[];
  /**
   * How many `[[tasks]]` refs the manifest listed (duplicates included,
   * Harbor's task_count). Null on rows stored before the count was recorded.
   */
  task_count: number | null;
}

/**
 * A version published from a git repository (`git_url` + `git_ref`): the
 * repository, the ref exactly as requested, the RESOLVED commit the clone
 * landed on (for an annotated tag, the peeled commit — never the tag
 * object), and the repository subfolder the corpus was read from.
 */
export interface DatasetVersionGitSource {
  kind: "git";
  /**
   * The repository this version was imported from, userinfo (an embedded
   * token) stripped; null only when the stored url cannot be parsed.
   */
  git_url: string | null;
  /** The ref the import was asked for, exactly as requested: a sha, a tag, or (legacy rows) a branch. */
  ref: string;
  /** The commit the corpus was actually read from — the resolved sha, peeled for an annotated tag. */
  commit: string;
  /** The repository subfolder the corpus was read from; null = repository root. */
  path: string | null;
}

/**
 * A version published from an UPLOADED archive — the multipart `archive`
 * part, which is what `publish({ source: { directory } })` and the CLI's
 * `--dir` send. No locator: the bytes came from the client.
 */
export interface DatasetVersionArchiveSource {
  kind: "archive";
  /** `sha256:<hex>` over the uploaded tarball's bytes. */
  digest: string;
}

/** A version published from a fetched tarball (`archive_url`). */
export interface DatasetVersionArchiveUrlSource {
  kind: "archive_url";
  /** The public https url the corpus tarball was fetched from, as given. */
  archive_url: string;
  /** `sha256:<hex>` over the fetched tarball's bytes. */
  digest: string;
}

/** A version published from a Harbor hub package (`hub_package`). */
export interface DatasetVersionHubSource {
  kind: "hub_package";
  /** The package reference as given — `org/name` or `org/name@ref` (Harbor's reference grammar). */
  hub_package: string;
  /**
   * `sha256:<hex>` — the hub's content hash over the task file set (Harbor's
   * recipe), the immutable hub version the import was pinned to, whatever
   * the reference's tag points at today.
   */
  digest: string;
}

/**
 * What one version was imported from — the LOCATOR the publish named (what
 * you would pass to publish the same source again) and the IDENTITY the
 * import resolved it to — one shape per publish kind, discriminated on
 * `kind` in the publish request's own vocabulary. Served on EVERY version
 * whatever its state: a version whose build FAILED can never become the
 * active version, so this is where its imported bytes stay observable.
 * Every `digest` is spelled `sha256:<hex>`; a git `commit` is a bare sha.
 */
export type DatasetVersionSource =
  | DatasetVersionGitSource
  | DatasetVersionArchiveSource
  | DatasetVersionArchiveUrlSource
  | DatasetVersionHubSource;

/**
 * One task's own terminal build state inside a published version — the
 * per-task member of the DatasetVersionState family (the partial-publish
 * model). Every task of a settled build is exactly one of these; there is no
 * per-task "building" state on the wire, because outcomes are recorded only
 * when the version settles.
 */
export type TaskBuildState = "READY" | "FAILED";

/**
 * Why one task FAILED its independent build — the ONE failure grammar for
 * every step: parse-level refusals (schema/capability) and build-level
 * failures (image build, mirror, compose resolution, image-config read,
 * skills verification) speak it identically.
 */
export interface TaskBuildFailure {
  /**
   * Typed reason. Parse refusals record `task_parse_failed`; build steps
   * record the builder's own family (`image_build_failed`,
   * `builder_unavailable`, `image_push_failed`, ...). Open set — render the
   * string; branch on `step` for coarse grouping.
   */
  code: string;
  /**
   * The build step that failed: `parse`, `image-build`, `image-config`,
   * `skills-verify`, `compose-resolve`, `image-mirror`, or `store`.
   */
  step: string;
  /** The failure sentence, naming the task's own defect. */
  message: string;
  /**
   * Bounded tail of the failing step's build log (the failing line and its
   * neighbourhood). Served by the per-task build route; list surfaces omit
   * it. Null when the step produced no log to excerpt (a parse refusal's
   * message IS the whole story).
   */
  excerpt?: string | null;
}

/**
 * One task's build outcome inside one published version — the failure-detail
 * read (datasets().getTaskBuild()). READY tasks answer too (failure and log
 * pointer null), so a poller needs no negative-space reasoning.
 */
export interface TaskBuild {
  task_name: string;
  state: TaskBuildState;
  /** The typed reason WITH the failing-step excerpt; null on READY. */
  failure: TaskBuildFailure | null;
  /**
   * Pointer to the FULL build log of the failing step
   * (`cloudwatch://<group>/<stream>` for image builds), for operators and
   * support tooling. Null when the failing step kept no separate log (parse
   * refusals), and on READY tasks.
   */
  build_log_ref: string | null;
}

/**
 * One failed task on the dataset detail's `failed_tasks` list: the compact
 * typed reason. The failing-step excerpt and build-log pointer live on the
 * per-task build route (datasets().getTaskBuild()).
 */
export interface DatasetFailedTask {
  task_name: string;
  failure: TaskBuildFailure;
}

/** One immutable version of a dataset — one shape on every surface */
export interface DatasetVersion {
  version: string;
  state: DatasetVersionState;
  created_at: string;
  /**
   * The READY (runnable) tasks of this version. Under the partial-publish
   * model this is what a whole-dataset job runs.
   */
  task_count: number;
  /**
   * Tasks of the published corpus that FAILED their independent build and
   * are therefore not runnable in this version (the partial-publish model).
   * 0 on a fully built version — and on servers that predate the field. The
   * names and reasons are on the dataset detail's `failed_tasks`; the full
   * per-task detail (excerpt + build-log pointer) answers at
   * datasets().getTaskBuild(). Fixing one is a re-publish — versions are
   * immutable.
   */
  n_failed_tasks: number;
  /**
   * The dataset.toml identity/metadata this version imported under. Null when
   * the corpus carried no manifest, and on servers that predate the field —
   * absence is "nothing to report", never a crash.
   */
  manifest: DatasetManifestMetadata | null;
  /**
   * What THIS version was imported from, per publish kind (`kind`: git /
   * archive / archive_url / hub_package). Null when the platform recorded
   * nothing readable (a seeded directory, a pre-provenance row, or a fetched
   * archive_url / hub_package row whose locator was never stored), and on
   * servers that predate the field — absence is "nothing to report", never a
   * fabricated value.
   */
  source: DatasetVersionSource | null;
}

/**
 * One provider's verdict for a task: runnable there, refused with the
 * limitation named (e.g. a multi-container task on a provider that cannot
 * host its services, or declared resources above the provider's ceiling), or
 * — GPU tasks only — runnable via a recorded DEGRADE: `ok: true` with
 * `degrades_to: "modal"` means a job stamped on this provider still runs the
 * task, on modal, and the trial records the same fact as
 * `sandbox_provider_degrade`; `reason` then carries this provider's own
 * sentence for why it could not serve the GPUs itself.
 */
export type TaskProviderVerdict =
  | { ok: true; degrades_to?: "modal"; reason?: string }
  | { ok: false; reason: string };

/**
 * A typed, non-fatal fact recorded about an ACCEPTED task — not a refusal
 * (the task imports and runs) and not a failure (nothing failed): a recorded
 * degrade the platform states where the publisher reads it.
 *
 * `tests_dockerfile_not_built`: the task ships a tests/Dockerfile the verifier
 * does not build, because upstream never would on its shape — the separate
 * verifier's effective environment pins a docker_image (Harbor boots it
 * as-is), or the verifier is shared and runs inside the agent box; a
 * dependency the recipe would install must already be in the image the
 * verifier boots. `message` is the platform's own sentence, naming the shape.
 */
export interface TaskNote {
  code: "tests_dockerfile_not_built";
  message: string;
}

/** Public task fields only — instructions, environments, and tests never leave the server */
export interface Task {
  task_name: string;
  agent_timeout_sec: number;
  verifier_timeout_sec: number;
  /**
   * GPUs the task declares (task.toml [environment] gpus — Harbor's field
   * honored verbatim). 0 = a CPU task. Absent on servers predating the field
   * — treat as 0.
   */
  gpus?: number;
  /**
   * Acceptable GPU types (e.g. ["H100"]), Harbor semantics: null means ANY
   * type is acceptable. Always null when gpus is 0.
   */
  gpu_types?: string[] | null;
  /**
   * Where the task can run, per sandbox provider. Advisory for planning a
   * job's provider choice — creating a job whose tasks include one refused on
   * the chosen provider is rejected with the same reason, so nothing is ever
   * spent on a trial that cannot execute.
   */
  providers: Record<EvalSandboxProvider, TaskProviderVerdict>;
  /**
   * Typed, non-fatal facts recorded about the task at import (TaskNote).
   * [] when there is nothing to say — every task imported before the notes
   * existed, and every task on a server predating the field.
   */
  notes: TaskNote[];
}

/**
 * The active version's git PROVENANCE — git_url + the requested ref + the
 * resolved commit + the repository subfolder — plus, for a ref that can move,
 * the WATCH: where the ref points now versus what the version was built from,
 * the data behind a "new version available" badge. Null when the active
 * version did not come from a git remote (an uploaded tarball, a seeded
 * corpus, a pre-provenance row); null is never "up to date". A version pinned
 * to a commit sha serves the provenance with the watch at rest (latest_commit
 * / checked_at / error null, moved false) — nothing checks a pin. Nothing
 * here imports anything — a new version is always a row you create (or
 * `auto_import` creates).
 */
export interface UpstreamStatus {
  /**
   * The repository the active version was imported from, with any userinfo
   * (an embedded token) stripped; null only when the stored url cannot be
   * parsed. Absent on a pre-provenance server.
   */
  git_url?: string | null;
  /** The ref the active version was imported from, exactly as requested. */
  ref: string;
  /** The commit the active version was built from (the resolved sha). */
  current_commit: string;
  /**
   * The repository subfolder the corpus was read from; null = repository
   * root. Absent on a pre-provenance server.
   */
  path?: string | null;
  /** Where the ref points upstream now; null when the last check failed. */
  latest_commit: string | null;
  /**
   * The newest commit a local version already exists for, whether or not it
   * is the active one; null before any import recorded one. Absent on an
   * older server.
   */
  acked_commit?: string | null;
  /** True when upstream has moved off the built-from commit. Branch on this. */
  moved: boolean;
  /** Reserved; always null today. */
  behind_by: number | null;
  /** When the cached answer was taken; null before the first check. */
  checked_at: string | null;
  /** Why the last check failed. Show "could not check", not "up to date". */
  error: string | null;
  /** Whether a moved upstream automatically imports a new version. */
  auto_import: boolean;
}

/**
 * A dataset in the catalog.
 *
 * list() returns the summary fields; get() additionally populates versions,
 * selected_version, tasks, created_at, and updated_at.
 */
export interface Dataset {
  name: string;
  title: string | null;
  description: string | null;
  /** The active version, or null when none is active (bare-name job refs refuse). */
  active_version: DatasetVersion | null;
  /**
   * The dataset's NEWEST version row (newest created_at first, id as the
   * tiebreak) — active or not.
   *
   * This is what makes a publish observable BEFORE it lands: a first
   * publish walks IMPORTING -> BUILDING here while `active_version` is
   * still null — the importer itself flips the finished build to READY and,
   * on an owner-stamped dataset, promotes it to the active version in the
   * same transaction. It can also hold a version that never landed (a
   * FAILED build), so it is NOT a substitute for `active_version`: a
   * bare-name job ref still resolves the active version and refuses
   * without one.
   *
   * Null when the dataset has no version rows at all — and also null when
   * talking to a server older than this field.
   */
  latest_version: DatasetVersion | null;
  /** All versions, newest first (get() only) */
  versions?: DatasetVersion[];
  /** The version whose tasks are listed below (get() only) */
  selected_version?: DatasetVersion | null;
  /**
   * One page of the selected version's tasks (get() only). Paged like every
   * other collection: a SWE-bench-scale dataset has thousands of tasks, so
   * pass { limit, cursor } to get() and follow nextCursor.
   */
  tasks?: Page<Task>;
  /**
   * The selected version's tasks that FAILED their independent build (get()
   * only; the partial-publish model). Always present on the detail body —
   * empty on a fully built version. Ordered by task name and capped at the
   * task page limit; `n_failed_tasks` on the version object is always the
   * exact count. Each entry carries the typed reason; the failing-step
   * excerpt and build-log pointer live on datasets().getTaskBuild().
   */
  failed_tasks?: DatasetFailedTask[];
  upstream: UpstreamStatus | null;
  /** get() only */
  created_at?: string;
  /** get() only */
  updated_at?: string;
}

/** Body of datasets().update() — the only settable dataset field. */
export interface DatasetPatch {
  /** Automatically import a new version when the upstream git ref moves. */
  upstream_auto_import: boolean;
}

/**
 * A dataset's active version resolved to a runnable shape.
 *
 * Unlike Dataset, `version` and `tasks` are non-optional: datasets()
 * .getActive() throws NoActiveVersionError when there is no active version,
 * so callers never branch on a missing active version.
 */
export interface ActiveDataset {
  name: string;
  title: string | null;
  description: string | null;
  /** The active version (always present) */
  active_version: DatasetVersion;
  /** The active version string (identical to active_version.version) */
  version: string;
  /** One page of the active version's tasks */
  tasks: Page<Task>;
  /** All versions, newest first */
  versions: DatasetVersion[];
  created_at: string;
  updated_at: string;
}

/** Cursor page of datasets */
export type DatasetPage = Page<Dataset>;

/** Dual-use handle from datasets().list(): await one page, or iterate them all */
export interface DatasetList extends Awaitable<DatasetPage>, AsyncIterable<Dataset> {}

// =============================================================================
// DATASET PUBLISH (async import)
// =============================================================================

/**
 * Source for datasets().publish(): a git repository pinned to a ref, a local
 * corpus directory (tarred deterministically on the client and uploaded), a
 * PUBLIC https tarball URL the server fetches itself, or a PUBLIC Harbor hub
 * package the server resolves and fetches — the last two move zero client
 * bytes.
 *
 * A UNION, not five optional fields: `{}` and two-branches-at-once are
 * compile errors rather than a 400 the caller discovers at run time, and
 * `?: never` on the absent branches' keys is what rejects the excess property
 * through a variable. `git_ref` is REQUIRED on the git branch — an unpinned
 * import is not reproducible.
 */
export type DatasetSource =
  | {
      /**
       * A git repository URL. https:// only — the import runs on a worker with
       * no ssh client, so ssh:// and git@ remotes are refused at validation.
       * For a private repository, put a token in the https url.
       */
      git_url: string;
      /**
       * A PINNED ref, required: a full 40-hex commit sha, or a tag (the
       * server resolves it to its commit at accept time, stores the sha, and
       * verifies the tag still points there at import). A branch name is
       * refused with `unpinned_git_ref` — an unpinned import is not
       * reproducible — and the refusal's details carry the commit the branch
       * points at right now, the pin to use instead.
       */
      git_ref: string;
      /**
       * Optional repository SUBFOLDER holding the corpus (POSIX path relative
       * to the repository root, e.g. "datasets/my-swe"). The server imports
       * only that folder, fetched via git sparse checkout. Ambiguity is
       * refused rather than interpreted: no absolute paths, no "." / ".." or
       * empty segments, no backslashes, whitespace, pattern characters, or
       * ".git" segments — and a path that is not a directory at the pinned
       * ref fails the import loudly instead of landing a 0-task version.
       */
      git_path?: string;
      directory?: never;
      archive_url?: never;
      hub_package?: never;
    }
  | {
      /** A local standard-layout corpus directory — tarred + gzipped and uploaded. */
      directory: string;
      git_url?: never;
      git_ref?: never;
      git_path?: never;
      archive_url?: never;
      hub_package?: never;
    }
  | {
      /**
       * A PUBLIC https URL to a gzipped corpus tarball — the SERVER fetches
       * it, so no bytes leave this machine. Public sources only: credentials
       * in the URL are refused (authenticated sources are a planned
       * follow-up) and the host must be publicly resolvable. The fetched
       * bytes pass the same validation and size caps as an uploaded archive.
       * `name` and `version` are required with this source.
       */
      archive_url: string;
      git_url?: never;
      git_ref?: never;
      git_path?: never;
      directory?: never;
      hub_package?: never;
    }
  | {
      /**
       * A PUBLIC Harbor hub package reference, `org/name[@ref]` in Harbor's
       * own grammar — no ref (or `latest`) is the latest tag, a number is a
       * revision, `sha256:<64 hex>` is a digest, anything else is a tag. The
       * server resolves it when the publish is accepted and the worker
       * fetches BY the resolved digest, so a tag moved after the 202 can
       * never deliver different bytes. A task package imports as a one-task
       * dataset; a dataset package fetches every digest-pinned member; both
       * are digest-verified against the hub's own pins. `name` defaults to
       * the package's short name and `version` to its resolved revision. A
       * missing or private package is refused `hub_package_not_found`; an
       * unreachable hub is `hub_unreachable` (502) — retry the publish.
       */
      hub_package: string;
      git_url?: never;
      git_ref?: never;
      git_path?: never;
      directory?: never;
      archive_url?: never;
    };

/** Input for datasets().preflight() — the dry-run half of publish. */
export interface PreflightDatasetInput {
  /**
   * A local standard-layout corpus directory. Only its METADATA moves: the
   * client walks the corpus shape (a single task directory, a tasks/ subdir,
   * or a root of task directories — the import's own reading), collects each
   * task's task.toml plus the optional dataset.toml manifest, and posts
   * kilobytes of JSON. The corpus bytes themselves never leave the machine.
   */
  source: { directory: string };
}

/**
 * One task's dry-run verdict. `ok: true` means no task.toml-decidable import
 * guard would refuse the task — never "this task will import"; the checks a
 * toml alone cannot decide are named in DatasetPreflight.deferred and the
 * real publish stays the authority. `ok: false` carries the importer's own
 * refusal sentence, exactly what a real import of this task would say.
 */
export interface PreflightTaskVerdict {
  /** The task directory's basename. */
  name: string;
  ok: boolean;
  /** metadata.task_id, or its directory-name fallback. */
  task_key: string;
  /** Present with ok true: the recorded Harbor schema_version. */
  schema_version?: string;
  /**
   * Present with ok true: verdict per sandbox provider over the
   * toml-declared requirements (GPU, sizing, network) — the same
   * adjudication the published dataset's task stamps use, with the
   * compose/image-command halves deferred to the import.
   */
  providers?: Record<EvalSandboxProvider, TaskProviderVerdict>;
  /**
   * Present with ok true: the typed task notes a task.toml alone decides —
   * today `tests_dockerfile_not_built` for a separate verifier whose
   * effective environment pins a docker_image (the image is booted as-is and
   * tests/ is never built, upstream semantics), worded conditionally because
   * the door never sees whether the tests tree ships a Dockerfile. [] when
   * there is nothing to say; absent on servers predating the field.
   */
  notes?: TaskNote[];
  /** Present with ok false: the importer's refusal sentence. */
  reason?: string;
}

/** An import guard the pre-flight cannot run, and what it reads instead. */
export interface PreflightDeferredCheck {
  name: string;
  reads: string;
}

/** The dataset.toml manifest's dry-run verdict (null when none was sent). */
export interface PreflightManifestVerdict {
  ok: boolean;
  /** Present with ok true: [dataset].name (Harbor org/name). */
  name?: string;
  /** Present with ok true: the catalog-facing half of the name. */
  short_name?: string;
  /** Present with ok true: [dataset].version, null when it declares none. */
  version?: string | null;
  /** Present with ok true: unique (name, digest) task entries. */
  task_count?: number;
  /** Present with ok false: the import's manifest refusal sentence. */
  reason?: string;
}

/**
 * The dry-run answer of POST /api/datasets/preflight. Nothing was written to
 * produce it: `checks` names the guards that ran, `deferred` the import
 * guards a task.toml alone cannot decide.
 */
export interface DatasetPreflight {
  /** The pinned parser revision that judged (e.g. "harbor-import/14"). */
  importer_version: string;
  checks: string[];
  deferred: PreflightDeferredCheck[];
  manifest: PreflightManifestVerdict | null;
  tasks: PreflightTaskVerdict[];
  tasks_total: number;
  tasks_ok: number;
  tasks_refused: number;
}

/** Input for datasets().publish() */
export interface PublishDatasetInput {
  source: DatasetSource;
  /**
   * Catalog dataset name the version lands under (created or extended).
   * Optional when a `directory` source carries a dataset.toml manifest — the
   * server derives the name from the manifest (the short segment of its
   * `org/name`) — and for a `hub_package` source, which defaults to the
   * package's short name. Always required for a git or `archive_url` source,
   * whose corpus the server only fetches after the publish is accepted.
   */
  name?: string;
  /**
   * Version label for the new immutable version. Optional when a `directory`
   * source's dataset.toml declares `[dataset].version` and for a
   * `hub_package` source (defaults to the resolved hub revision number);
   * required otherwise.
   */
  version?: string;
}

/** Options for datasets().publish() */
export interface PublishDatasetOptions {
  /**
   * Called as the archive's bytes go onto the wire (a `directory` source
   * only — a git source uploads nothing). `sentBytes` counts archive bytes
   * whose write the transport confirmed flushed; `totalBytes` is the
   * archive's size. Client-side by construction: the stream itself is the
   * measurement, no server call is made. Fires per flushed chunk — throttle
   * in the renderer, not here.
   */
  onUploadProgress?: (sentBytes: number, totalBytes: number) => void;
  /**
   * Register-first: called ONCE, the moment the resumable door's session
   * open pre-creates the import (before any corpus byte moves), with the
   * import id the eventual 202 will carry. A watcher may attach to it right
   * away — `datasets().watchImport(importId)`, or `evolve dataset watch`
   * from any machine. Never called on the single-request door (nothing is
   * registered: the upload IS the request), on a fetched source, or when
   * the server registered nothing (an existing name@version, or an older
   * server).
   */
  onRegistered?: (importId: string) => void;
}

/**
 * Dataset import status.
 *
 * The SAME four words a job uses, deliberately: a status chip rendering both
 * never carries a translation table. Terminal: "COMPLETED" (the corpus landed
 * as a dataset version; runnable once activated) and "FAILED".
 */
export type DatasetImportStatus = "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED";

/** Structured failure detail for a FAILED import. */
export interface DatasetImportFailure {
  /** Stable machine-readable cause; "import_failed" when none was recorded. */
  code: string;
  /** What went wrong, e.g. "2/113 task(s) failed to parse" */
  message: string;
  /** Per-task parse/validation failures, when the corpus was reachable */
  failures?: { task_name: string; error: string }[];
}

/**
 * Non-fatal but consequential import outcome. A version whose warnings include
 * `no_solutions_archived` permanently lacks its reference-solution record —
 * the record operator verification tooling reads, never a gate. The version
 * still publishes, activates, and runs; the warning makes the permanent gap
 * visible instead of silent.
 *
 * `tasks_failed_to_build` is the partial-publish model's warning: the import
 * COMPLETED (the version is READY — at least one task built) but some tasks
 * FAILED their independent build and are not runnable in this version. The
 * names and typed reasons are on the dataset detail's `failed_tasks`; fixing
 * them is a re-publish (immutable versions).
 *
 * `tests_dockerfile_not_built` names the READY tasks that ship a
 * tests/Dockerfile the verifier never builds — their verifier image is pinned,
 * or shared (upstream semantics: Harbor boots the pinned image as-is and never
 * builds tests/ on that shape). Not an absence and not a failure: a recorded
 * degrade. Each such task carries the same fact as a `tests_dockerfile_not_built`
 * note on the dataset detail (Task.notes).
 */
export interface ImportWarning {
  code:
    | "solutions_archiving_disabled"
    | "no_solutions_archived"
    | "partial_solutions_archived"
    | "tasks_failed_to_build"
    | "tests_dockerfile_not_built";
  message?: string;
}

/**
 * An asynchronous publish. Self-describing: every response names the
 * dataset@version being imported — the 202 from publish(), getImport(), and
 * listImports() all return this same shape, so a caller can render the row it
 * just created without a follow-up read.
 */
/**
 * The five phases of a publish, in the order they run (spec ImportPhaseName):
 * extracting (archive fetched and unpacked, or the git source cloned),
 * parsing (every task directory parsed, manifest gate included), building
 * (the image pool — Dockerfile build contexts and compose-service
 * resolutions), copying (upstream images mirrored into the platform
 * registry), verifying (storability census, solutions archive, the task
 * transaction, and the registry read-back before READY).
 */
export type ImportPhase =
  | "extracting"
  | "parsing"
  | "building"
  | "copying"
  | "verifying";

/** One phase of the import timeline (spec ImportPhaseProgress). */
export interface ImportPhaseProgress {
  name: ImportPhase;
  started_at: string;
  /**
   * Absent while the phase runs — and stays absent forever on the phase a
   * FAILED import died in, which is how a reader finds where it died.
   */
  completed_at?: string;
  /**
   * Units settled so far — task dirs (parsing), image-pool units (building),
   * unique images (copying), surviving tasks (verifying). Failures count as
   * settled; extracting has no unit and stays 0/0.
   */
  done: number;
  total: number;
  /**
   * Of `done`, the units whose bytes already lived in the platform registry
   * (content-addressed hit — nothing copied). Image phases only.
   */
  banked?: number;
}

/**
 * Live progress of a publish (spec DatasetImportProgress) — written by the
 * build worker at phase boundaries and coarse intervals, never per-second.
 * On a terminal import it is the settled record: all five phases with
 * wall-clock timestamps, the final image counts, and the publish's CodeBuild
 * copy-build minutes.
 */
export interface DatasetImportProgress {
  /** What the import is doing now (the last entry of `phases`). */
  phase: ImportPhase;
  /** When the claimed run began on the worker — explicit, never derived. */
  started_at: string;
  phases: ImportPhaseProgress[];
  /**
   * The publish's cumulative image economics: `built` and `mirrored` are
   * fresh pushes this publish paid for; `banked` counts images that already
   * existed in the registry.
   */
  images: { built: number; mirrored: number; banked: number };
  /**
   * The publish's promotion fan-out meter: CodeBuild copy builds started and
   * their billed minutes. 0/0 on a fully banked re-publish.
   */
  codebuild: { copy_builds: number; billed_minutes: number };
}

export interface DatasetImport {
  /** Import job id */
  id: string;
  status: DatasetImportStatus;
  /**
   * The register-first marker: true exactly while the corpus is still
   * uploading through its resumable session — the import is QUEUED and
   * cannot proceed without the client — and false from the moment the
   * publish is accepted. Absent on servers predating register-first.
   */
  receiving?: boolean;
  /** Catalog dataset name the import creates or extends */
  name: string;
  /** Version label of the imported version */
  version: string;
  /**
   * Why the import FAILED; null otherwise. Named `failure`, never `error` —
   * see JobFailure.
   */
  failure: DatasetImportFailure | null;
  /** Non-fatal but consequential outcomes — see ImportWarning. */
  warnings: ImportWarning[];
  /**
   * Live progress of the build — null until the worker's first report (a
   * QUEUED import, an older server, and every import that predates
   * progress). On a terminal import it is the settled five-phase record.
   */
  progress: DatasetImportProgress | null;
  /** Number of tasks parsed, once counted */
  task_count?: number;
  created_at?: string;
  updated_at?: string;
}

/** Cursor page of dataset imports */
export type DatasetImportPage = Page<DatasetImport>;

/** Dual-use handle from datasets().listImports(): await one page, or iterate them all */
export interface DatasetImportList
  extends Awaitable<DatasetImportPage>,
    AsyncIterable<DatasetImport> {}

// =============================================================================
// REGISTERED AGENTS (bring-your-own)
// =============================================================================

/**
 * Where a registered agent's executables came from: an install script run in a
 * throwaway builder sandbox, or a tarball uploaded from a local directory.
 * Echoed on every response; the SDK never guesses it.
 */
export type AgentSource = "install_script" | "tarball";

/**
 * A private agent registered by the caller. Once registered, its `name` is
 * usable in job `agents[].name` exactly like a built-in ("claude", "codex",
 * ...). Private to its owner: another user's name reads as `agent_not_found`,
 * never as a permission error — existence is never leaked.
 */
export interface Agent {
  /** The name to put in job agents[].name */
  name: string;
  /** How the executables were produced */
  source: AgentSource;
  /** The command run headless with `sh -c` at the task working directory */
  run_command: string;
  /**
   * Caller-declared env injected at RUN time only. It may not override the run
   * contract's own keys — the server rejects that at registration with
   * `agent_invalid_env`.
   */
  env: Record<string, string>;
  created_at: string;
  updated_at: string;
}

/**
 * The two sources a registered agent's executables can come from. A union, not
 * two optional fields — see DatasetSource for why `?: never` is load-bearing
 * rather than decorative.
 */
export type AgentSourceInput =
  | {
      /**
       * The install script itself (not a path). It runs in a throwaway builder
       * sandbox that has internet and ZERO secrets, so everything it fetches
       * must be publicly fetchable, and it must leave executables in
       * `$PREFIX/bin`.
       */
      install_script: string;
      directory?: never;
    }
  | {
      /**
       * A local directory holding the agent — tarred + gzipped and uploaded.
       * Same build rules as an install script.
       */
      directory: string;
      install_script?: never;
    };

/**
 * Input for agents().create(): a name, a run command, and EXACTLY ONE source.
 * The source half is a union, so omitting both or passing both is a compile
 * error rather than a 400 the caller discovers at run time.
 */
export type AgentInput = AgentSourceInput & {
  /** Agent name; also the value used later in job agents[].name */
  name: string;
  /** Command run headless with `sh -c` at the task working directory */
  run_command: string;
  /** Env injected at RUN time only; may not override the run contract's keys */
  env?: Record<string, string>;
};

/**
 * An agent upsert body. Same shape as AgentInput minus `name`, which the
 * upsert takes as its first argument — the name is the resource identity, not
 * a field of it.
 */
export type AgentUpsertInput = AgentSourceInput & {
  /** Command run headless with `sh -c` at the task working directory */
  run_command: string;
  /** Env injected at RUN time only; may not override the run contract's keys */
  env?: Record<string, string>;
};

/** Cursor page of registered agents */
export type AgentPage = Page<Agent>;

/** Dual-use handle from agents().list(): await one page, or iterate them all */
export interface AgentList extends Awaitable<AgentPage>, AsyncIterable<Agent> {}

// =============================================================================
// OPTIONS
// =============================================================================

/** Options for jobs().start() and resume() */
export interface StartJobOptions {
  /**
   * Idempotency-Key header value: retries with the same key return the
   * original job (idempotent_replay: true) instead of creating a new one.
   */
  idempotencyKey?: string;
}

/** Options for jobs().list() (default page 50, max 200) */
export interface ListJobsOptions extends PageOptions {
  /** Server-side free-text filter over job name and dataset names. */
  search?: string;
  /**
   * Visibility scope (Harbor's `--scope`): `my` — jobs you created, the
   * server's default; `shared` — your organizations' jobs that teammates
   * created. See JOB_LIST_SCOPES.
   */
  scope?: JobListScope;
}

/** Options for analyses().list() (default page 50, max 200) */
export interface ListAnalysesOptions extends PageOptions {
  /** Visibility scope, exactly as on jobs().list(). */
  scope?: JobListScope;
  /** Only analyses of this job's trials. */
  job?: string;
  /** Only analyses in these statuses (the object's own lowercase ladder). */
  status?: AnalysisStatus[];
}

/** Options for jobs().tasks() (default page 50, max 200) */
export interface ListJobTasksOptions extends PageOptions {}

/** Options for jobs().trials() (default page 50, max 200) */
export interface ListTrialsOptions extends PageOptions {
  /** Only trials in these statuses (e.g. the failures behind a resume decision) */
  status?: TrialStatus[];
  /** Only one dataset's trials — exact match on the trial's `source`. */
  dataset?: string;
}

/** Options for datasets().list() (default page 50, max 200) */
export interface ListDatasetsOptions extends PageOptions {
  /** Server-side free-text filter over name and description. */
  search?: string;
}

/** Options for agents().list() (default page 50, max 200) */
export interface ListAgentsOptions extends PageOptions {}

/** Options for datasets().get() / getActive(): pages the TASK list (default 200, max 500) */
export interface GetDatasetOptions extends PageOptions {}

/** Options for datasets().listImports() */
export interface ListImportsOptions extends PageOptions {
  /** Only imports in this status */
  status?: DatasetImportStatus;
  /** Only imports of this dataset name */
  dataset?: string;
}

/** Options for trials().trace() and traceEvents() */
export interface TraceOptions extends PageOptions {
  /**
   * Resume position: events with seq strictly greater than this cursor (omit =
   * from the beginning). A trace cursor IS a seq, so to resume a poll later
   * pass the last event's `seq` here as a string.
   */
  cursor?: string;
  /** Max events per page (server default: 200, max: 1000) */
  limit?: number;
  /** Only events of exactly this type. */
  type?: string;
  /**
   * Only events whose type or serialized content matches this
   * case-insensitive POSIX regex (a plain string is a plain substring —
   * grep's own grammar). An invalid pattern is the server's typed
   * `invalid_input` refusal.
   */
  grep?: string;
  /**
   * Only the last N MATCHING events — a floor on the seq timeline, after
   * which cursor paging proceeds normally, oldest-first.
   */
  tail?: number;
}

/** Options for jobs().grep() */
export interface GrepJobOptions extends PageOptions {
  /** Only search events of exactly this type. */
  type?: string;
}

/**
 * One trial's slice of a job-wide grep (jobs().grep()): the EXACT number of
 * matching events plus the first few of them — the platform caps the sample
 * (at 5), the count never truncates. The full match list of one trial is
 * trials().trace() with the same pattern as { grep }.
 */
export interface JobGrepGroup {
  trial_id: string;
  /** The trial's task, for orientation; null only when the task row is gone. */
  task_name: string | null;
  match_count: number;
  events: TraceEvent[];
}

/** One page of a job-wide grep, ordered by trial id. */
export type JobGrepPage = Page<JobGrepGroup>;

/**
 * One stored file of a trial's tree (trials().files()), named by its
 * prefix-relative path — the same path trials().file() reads.
 */
export interface TrialFile {
  path: string;
  size_bytes: number;
}

/** One page of a trial's stored file tree, sorted by path. */
export type TrialFilePage = Page<TrialFile>;

/** Options for trials().files() (default page 200, max 1000) */
export interface ListTrialFilesOptions extends PageOptions {}

/**
 * Byte range for trials().file() — inclusive positions, the wire's
 * `Range: bytes=start-end` grammar: { start } alone reads to the end,
 * { suffix } alone reads the last N bytes.
 */
export interface TrialFileRange {
  start?: number;
  end?: number;
  /** The last N bytes (mutually exclusive with start/end). */
  suffix?: number;
}

/** Options for datasets().watchImport() */
export interface WatchImportOptions {
  /** Called on every observed import status change (including the first status seen) */
  onStatus?: (datasetImport: DatasetImport) => void;
  /**
   * Called on every observed change of the import's live `progress` — a
   * phase boundary, or new counts inside a phase. The server writes progress
   * at phase boundaries and coarse intervals (never per-second), so this
   * fires at that cadence, under the same poll (and the same 429-tolerant
   * posture) as `onStatus`. Never called while `progress` is null.
   */
  onProgress?: (progress: DatasetImportProgress, datasetImport: DatasetImport) => void;
  /**
   * Called on every observed change of the imported VERSION's state during
   * the watch's settle phase — normally the single confirming READY read
   * (COMPLETED means the version is READY under build-then-READY), or the
   * walk to READY/ARCHIVED/FAILED against a mid-deploy older server.
   * `dataset` is the detail read the observation came from: its
   * `active_version` says whether the settled version is now the one a bare
   * dataset name resolves to.
   */
  onVersion?: (version: DatasetVersion, dataset: Dataset) => void;
  /** Abort the watch (rejects with the abort reason) */
  signal?: AbortSignal;
  /** Poll interval between polls (default: 2000ms) */
  pollIntervalMs?: number;
  /**
   * Backstop bound on the settle phase — how long past import COMPLETED the
   * watch may wait for the version to settle before refusing with
   * ImportSettleError("settle_timeout") (default: 30 minutes). Normally
   * unused (COMPLETED means READY); it bounds the wait against a mid-deploy
   * older server, and the error carries the last observed state.
   */
  settleTimeoutMs?: number;
}

/** Options for jobs().watchAnalysis() */
export interface WatchAnalysisOptions {
  /**
   * Called on every observed change of the job's analysis tally (including
   * the first non-null one seen), with the job body the observation came
   * from.
   */
  onStats?: (job: Job) => void;
  /** Abort the watch (rejects with the abort reason) */
  signal?: AbortSignal;
  /** Poll interval between polls (default: 2000ms) */
  pollIntervalMs?: number;
}

/** Options for jobs().watch() */
export interface WatchJobOptions {
  /** Called for every event (replayed + live) */
  onEvent?: (event: JobEvent) => void;
  /** Abort the watch (rejects with the abort reason) */
  signal?: AbortSignal;
  /** Initial reconnect backoff (default: 1000ms; doubles up to maxReconnectDelayMs) */
  reconnectDelayMs?: number;
  /** Backoff ceiling (default: 30000ms) */
  maxReconnectDelayMs?: number;
}

/** Delivery options for datasets().download() */
export interface DownloadDatasetOptions {
  /** Directory to save the package into (returns the file path) */
  to?: string;
  /** Return the raw response stream instead of a Buffer */
  stream?: boolean;
}

/** Delivery options for jobs().download() */
export interface DownloadJobOptions {
  /** Directory to save the archive into (returns the file path) */
  to?: string;
  /** Return the raw response stream instead of a Buffer */
  stream?: boolean;
}

/** Options for jobs().upload() */
export interface UploadJobOptions {
  /**
   * "name" or "name@version" of a published dataset — links the uploaded
   * trials to that version's tasks by task name (a bare name resolves to the
   * active version). Matched trials analyze against the real task content;
   * unmatched or unhinted trials analyze through the task-not-available
   * branch, exactly Harbor's fallback for a trial without a local task
   * directory.
   */
  dataset?: string;
}

// =============================================================================
// CLIENTS
// =============================================================================

/** Client for the shared dataset catalog */
export interface DatasetsClient {
  /**
   * List datasets with their active versions (cursor-paged). Await the
   * result for one page, or `for await` it to walk the whole catalog.
   */
  list(options?: ListDatasetsOptions): DatasetList;
  /**
   * Get one dataset: all versions + one page of the selected version's tasks.
   * ref is "name" (active version's tasks) or "name@version"; { limit, cursor }
   * page the tasks.
   */
  get(ref: string, options?: GetDatasetOptions): Promise<Dataset>;
  /**
   * Get a dataset's active version resolved to a runnable shape: unlike
   * get(), `version` and `tasks` are guaranteed present. Throws
   * NoActiveVersionError when the dataset has no active version. Use get()
   * for the full multi-version detail with optional fields.
   */
  getActive(name: string, options?: GetDatasetOptions): Promise<ActiveDataset>;
  /**
   * The failure-detail read of the partial-publish model: one task's own
   * build outcome inside one published version — its state (READY or
   * FAILED), the typed failure WITH the failing-step excerpt, and the full
   * build-log pointer. The dataset detail's `failed_tasks` carries the
   * compact reasons for every failed task; this call is where the excerpt
   * and the log pointer live, one task at a time.
   *
   * `ref` must pin the version: "name@version" (the outcome is a fact about
   * one immutable version, so there is no active-version reading to guess).
   * A task the build has not settled — or a name the corpus never contained
   * — answers 404 `task_not_found`.
   */
  getTaskBuild(ref: string, taskName: string): Promise<TaskBuild>;
  /**
   * Pre-flight a local corpus BEFORE publishing (dry run): collect only the
   * metadata files (each task's task.toml + the optional dataset.toml —
   * kilobytes), run the import's own toml-decidable guards and per-provider
   * capability stamps server-side, and answer per-task verdicts with the
   * importer's would-refuse sentences. Nothing is written and no corpus
   * byte moves. `evolve dataset publish --dir` runs this automatically;
   * `evolve dataset check <dir>` is the standalone verb.
   */
  preflight(input: PreflightDatasetInput): Promise<DatasetPreflight>;
  /**
   * Publish a dataset version (asynchronous server-side import) from a git
   * source pinned to a ref, or a local corpus directory. Returns immediately;
   * poll with getImport()/watchImport().
   */
  publish(input: PublishDatasetInput, options?: PublishDatasetOptions): Promise<DatasetImport>;
  /** Get an import job's status (failure, warnings, and task_count when available) */
  getImport(id: string): Promise<DatasetImport>;
  /**
   * Watch a publish to its settled end: poll getImport() until the import is
   * terminal, then confirm the version against the dataset detail. Under
   * build-then-READY, COMPLETED means the version is READY — the build
   * settled with at least one task ready (the partial-publish model; each
   * provider builds its boot artifact lazily at the first trial) and, on an
   * owner-stamped dataset,
   * already active — so the settle phase is normally the single confirming
   * read; against a mid-deploy older server it keeps polling until the
   * version reaches READY, ARCHIVED, or FAILED. A failed build rides the
   * returned import's `failure`. Throws ImportSettleError("settle_timeout")
   * when settleTimeoutMs elapses before the version settles.
   */
  watchImport(id: string, options?: WatchImportOptions): Promise<DatasetImport>;
  /**
   * List the caller's own imports, newest first (cursor-paged). This is how
   * you find an import again after losing the id publish() returned. Await
   * for one page, or `for await` to walk them all. { status } filters on the
   * import vocabulary; { dataset } narrows to one dataset name.
   */
  listImports(options?: ListImportsOptions): DatasetImportList;
  /**
   * Download the ORIGINAL corpus package one of your own dataset versions was
   * published from — the gzipped tarball you uploaded, or, for a git publish,
   * the checked-out tree packed at import time. `ref` is "name" (the active
   * version's package) or "name@version".
   *
   * OWNER ONLY. This is the one call that returns task files, and it returns
   * them only to the account that owns the dataset; a platform-curated dataset
   * has no owner, so nobody can download it. Someone else's dataset is a plain
   * not-found, never a 403.
   *
   * The server verifies the stored bytes against their recorded sha256 before
   * sending anything and echoes the digest; the client re-checks the digest
   * and the Content-Length, so a successful call is byte-identical to what was
   * published. A version published before packages were retained has none
   * (`package_not_retained`, distinct from "not found").
   *
   * Default: Buffer. { to } saves into a directory and returns the file path.
   * { stream: true } returns the raw response stream.
   */
  download(ref: string): Promise<Buffer>;
  download(ref: string, options: { to: string }): Promise<string>;
  download(ref: string, options: { stream: true }): Promise<ReadableStream<Uint8Array>>;
  download(
    ref: string,
    options?: DownloadDatasetOptions
  ): Promise<Buffer | string | ReadableStream<Uint8Array>>;
  /**
   * Update dataset settings. The only settable field is
   * `upstream_auto_import`: automatically import a new version when the
   * dataset's upstream git ref moves. Refused (upstream_not_watchable) when
   * the dataset has no moving git ref to follow, and dataset_not_owned on a
   * platform-curated dataset. Returns the updated dataset.
   */
  update(name: string, patch: DatasetPatch): Promise<Dataset>;
  /**
   * Activate a READY version you own: bare-name job references resolve to it
   * from then on. A publish activates its own version when it lands, so this
   * verb is for re-pointing the default — a rollback to an older READY
   * version, or choosing between several. Refused with `version_not_ready`
   * while the publish is still building and `version_not_activatable` for a
   * FAILED or ARCHIVED version, which can never be activated.
   */
  activate(name: string, version: string): Promise<Dataset>;
  /**
   * Delete a dataset you own, with every version, task, and archived
   * solution. Refused (dataset_in_use) while any job still references it — a
   * dataset is never deleted out from under a job that measured against it,
   * and `err.details.sampleJobIds` names the jobs blocking it. A platform
   * dataset is refused with dataset_not_owned; a name you cannot see is a
   * plain not-found.
   */
  delete(name: string): Promise<void>;
}

/** Client for the caller's own private (bring-your-own) agents */
export interface AgentsClient {
  /**
   * Register a private agent. Provide either an install script
   * (`{ install_script }`) or a local directory (`{ directory }`), never both.
   * The name is then usable in job `agents[].name` like a built-in.
   */
  create(input: AgentInput): Promise<Agent>;
  /**
   * List the caller's registered agents (cursor-paged). Await the result for
   * one page, or `for await` it to walk them all.
   */
  list(options?: ListAgentsOptions): AgentList;
  /** Get one registered agent by name */
  get(name: string): Promise<Agent>;
  /** Delete a registered agent. Past jobs keep their recorded agent. */
  delete(name: string): Promise<void>;
  /**
   * Register or replace an agent in ONE call, under the name you give.
   *
   * Use this instead of delete()+create() to change an existing registration:
   * the pair leaves a window where the agent does not exist, and anything
   * naming it in that window fails for a change that was only ever meant to be
   * an edit. This is a full replacement, not a patch — every field comes from
   * this call, and an omitted `env` becomes empty.
   */
  upsert(name: string, input: AgentUpsertInput): Promise<Agent>;
}

/**
 * One skill uploaded to the platform. Immutable content: the digest is the
 * identity (Harbor's skill digest recipe over the folder), and jobs reference
 * it as `upload:<id>` in `agents[].skills`.
 */
export interface SkillUpload {
  id: string;
  /** Folder name = the name the harness sees when mounted. */
  name: string;
  /** Content digest, "sha256:<hex>" — Harbor's recipe. */
  digest: string;
  size_bytes: number;
  /** First heading / description line lifted from SKILL.md, or null. */
  description: string | null;
  /** The `upload:<id>` reference to put in `agents[].skills`. */
  ref: string;
  created_at: string;
}

export type SkillUploadPage = Page<SkillUpload>;
export interface SkillUploadList extends Awaitable<SkillUploadPage>, AsyncIterable<SkillUpload> {}
export interface ListSkillsOptions extends PageOptions {}

/** Client for platform-stored skills (uploads referenced as `upload:<id>`). */
export interface SkillsClient {
  /**
   * Upload a local skill folder (must contain SKILL.md, or be a root whose
   * child directories each contain SKILL.md — Harbor's discovery law; a root
   * uploads each child as its own skill and resolves to the full list).
   * Re-uploading identical content under the same name answers the existing
   * record — uploads are content-addressed, never duplicated. A skill NAME
   * is a moving pointer: every upload makes its record the name's current
   * one (different content = new record, pointer moves; old records keep
   * their immutable `upload:<id>` handles), and `name:<skill-name>` in
   * `agents[].skills` resolves through it at job create.
   */
  upload(directory: string): Promise<SkillUpload[]>;
  /** List the caller's uploaded skills (cursor-paged). */
  list(options?: ListSkillsOptions): SkillUploadList;
  /**
   * Get one uploaded skill, including its SKILL.md text. Takes a record id,
   * or `name:<skill-name>` — the moving name pointer, answered with its
   * CURRENT record (unknown names are the typed `skill_name_not_found`).
   */
  get(id: string): Promise<SkillUpload & { skill_md: string | null }>;
  /**
   * Delete an uploaded skill. Refused while a non-terminal job references it;
   * finished jobs keep their recorded locks either way.
   */
  delete(id: string): Promise<void>;
}

/** Client for hosted jobs */
export interface JobsClient {
  /**
   * Start a job over one or more catalog datasets. Each dataset selector may
   * carry glob task filters; every agent arm must name a model. Supports
   * Idempotency-Key.
   */
  start(input: JobCreate, options?: StartJobOptions): Promise<Job>;
  /** Get one job */
  get(id: string): Promise<Job>;
  /**
   * List the caller's jobs, newest first (cursor-paged). Await the
   * result for one page, or `for await` it to walk every job across
   * cursor pages transparently.
   */
  list(options?: ListJobsOptions): JobList;
  /**
   * List a job's trials (cursor-paged; { status } filters, e.g. to
   * the failed trials). Await the result for one page, or `for await` it to
   * walk every trial across cursor pages transparently.
   */
  trials(id: string, options?: ListTrialsOptions): TrialList;
  /**
   * Per-task rollup of a job (cursor-paged): one row per distinct task with
   * its trial tally, mean reward, and cost. Sits between the job body and
   * the trial list so a caller need not fetch every trial to see which
   * tasks are dragging.
   */
  tasks(id: string, options?: ListJobTasksOptions): JobTaskRollupList;
  /**
   * Watch a job's event stream (SSE). Replays from the beginning,
   * resumes with Last-Event-ID on reconnect (exponential backoff), and
   * finishes on the terminal event.
   *
   * The returned handle is dual-use: `await client.watch(id)` resolves with the
   * final Job, or `for await (const event of client.watch(id))` iterates
   * the events. The `onEvent` callback still fires in both forms.
   */
  watch(id: string, options?: WatchJobOptions): JobWatch;
  /** Request cancellation. Idempotent; a terminal job is a no-op. */
  cancel(id: string): Promise<Job>;
  /**
   * Resume a terminal job: a NEW linked job holding fresh trials for the
   * source's failed and stopped work (`source_jobs` records
   * `action: "resume"`); the source is never mutated.
   * `request.filter_error_types` selects which failures to resume by
   * `exception_info.exception_type`; omitted, the default set includes
   * stopped trials. Supports Idempotency-Key.
   */
  resume(id: string, request?: ResumeRequest, options?: StartJobOptions): Promise<Job>;
  /**
   * MANUAL retry: a NEW linked job holding fresh trials for caller-SELECTED
   * trials of the source (`source_jobs` records `action: "retry"`); the
   * source is never mutated. The request selects — `trial_ids` XOR
   * `failed_only`, omitted = every trial of the (terminal) job. Retry
   * differs from resume on purpose: resume answers "finish what broke",
   * retry answers "run THESE again" — a scored trial is a legitimate target.
   * In trial_ids mode the job may still be running; each named trial must be
   * settled. Supports Idempotency-Key (fingerprint over the RESOLVED
   * selection, namespaced to this verb).
   */
  retry(id: string, request?: RetryRequest, options?: StartJobOptions): Promise<Job>;
  /**
   * Regrade a terminal job: re-run the verifier of every REGRADABLE trial
   * against its recorded inputs, in fresh separate verifier boxes. The agent
   * phase is never re-run and the source trials are never modified. THE
   * RESPONSE IS A JOB — a regrade is an ordinary job whose `source_jobs`
   * records `action: "regrade"` and whose `is_regrade` is true; view it with
   * get(). `request` narrows the set by statuses and/or task.
   */
  regrade(id: string, request?: RegradeRequest): Promise<Job>;
  /**
   * Analyze a terminal job's trial traces (rubric-driven, Harbor's `harbor
   * analyze`), server-side: for each trial the analyzer agent reads the
   * trial's Harbor-shape tree plus its original task and rules every rubric
   * criterion, storing the result on the trial (`Trial.analysis`) and the
   * aggregate on the job (`stats.analysis`). THE RESPONSE IS THE JOB, its
   * analyses enqueued — analyses are not a separate resource; follow them
   * with watchAnalysis(), or poll the job's trials. This is also the
   * RE-analysis path: calling again (same job, different rubric or model)
   * runs a fresh wave once the previous one has settled. `request` omitted
   * (or `{}`) means the defaults: glm-5.3-flash over Harbor's default
   * rubric. CANCELLED trials are never analyzed.
   */
  analyze(id: string, request?: AnalyzeConfigInput): Promise<Job>;
  /**
   * Follow a job's analysis wave to its settled end: polls the job until
   * `stats.analysis` reports nothing pending, and resolves with the final
   * Job. `onStats` fires on every observed change of the analysis tally
   * (including the first one seen). Per-trial results then ride the job's
   * trials (`Trial.analysis`). A null tally is tolerated and watched
   * through — it is the enqueue race right after an accepted analyze() —
   * so on a job that was NEVER analyzed this polls indefinitely: call it
   * after analyze(), as the CLI always does. It is the MANUAL wave's
   * companion, not the embedded trigger's: on a still-RUNNING job created
   * with `analyze`, `n_pending` can touch 0 between trial settles, so the
   * watch can return before every trial has been analyzed.
   */
  watchAnalysis(id: string, options?: WatchAnalysisOptions): Promise<Job>;
  /**
   * Side-by-side comparison of 2-10 owned jobs: per-job
   * aggregates plus a per-task matrix with disagreement rows first.
   */
  compare(ids: string[]): Promise<CompareResponse>;
  /**
   * Download a terminal job's results as one .tar.gz in the standard
   * job-directory layout (deterministic bytes): extracts to `job-<id>/` with
   * config.json, lock.json, result.json (stats incl. pass_at_k) and job.log,
   * and per trial its config.json, lock.json, result.json (step_results on
   * multi-step trials), trial.log, agent/trajectory.json (the normalized
   * ATIF trajectory), agent/{stdout,stderr}.log, agent/sessions/,
   * verifier/test-stdout.txt, verifier/reward.json, the raw
   * verifier/reward.txt (only when the grader wrote one),
   * steps/<name>/verifier/reward.json (multi-step trials only),
   * exception.txt, and artifacts/ with its always-present manifest.json —
   * absent artifacts are absent files. Default: Buffer — verified against
   * the response's Content-Length and, when the server states one, its
   * digest. { to } saves to a directory (temp-then-rename, same
   * verification) and returns the file path. { stream: true } returns the
   * raw response stream, the one shape the caller must verify themselves.
   */
  download(id: string): Promise<Buffer>;
  download(id: string, options: { to: string }): Promise<string>;
  download(id: string, options: { stream: true }): Promise<ReadableStream<Uint8Array>>;
  download(
    id: string,
    options?: DownloadJobOptions
  ): Promise<Buffer | string | ReadableStream<Uint8Array>>;
  /**
   * Upload a Harbor job directory as a first-class TERMINAL job — Harbor's
   * `harbor upload` in reverse, taking their CLI's own input (a `job_dir`
   * with result.json + config.json at its root, one subdirectory per trial;
   * the same gate applies here, client-side, with their refusal sentences).
   * `dirOrArchive` is that directory — packed into a gzipped tar with the
   * same deterministic packer every upload route here uses — or a
   * ready-packed `.tar.gz` of one, uploaded byte-for-byte: the platform's own
   * download() produces exactly this format, so a downloaded job re-uploads
   * as-is, and any real `harbor run` job dir works the same way.
   *
   * Trial facts land verbatim: rewards are never re-scored, a trial without a
   * verdict lands INDETERMINATE, exceptions are carried, and the trajectory /
   * raw streams / verifier log / reward.txt are stored byte-for-byte in the
   * native trial slots. THE RESPONSE IS THE JOB — COMPLETED on creation, with
   * `upload` carrying the provenance echo. It is a record, not a run: resume,
   * retry and regrade refuse it (`job_uploaded`); analyze() works on it
   * unchanged. `{ dataset }` links the uploaded trials to a published dataset
   * version by task name. The caps live on `GET /api/meta` under
   * `limits.uploads` (`job_archive_bytes`, `job_trials`,
   * `job_trial_file_bytes`, `job_trial_session_bytes`).
   */
  upload(dirOrArchive: string, options?: UploadJobOptions): Promise<Job>;
  /**
   * Permanently delete one of your jobs — trials, trace events, analyses and
   * every stored trace object included (Harbor's `harbor hub job delete`:
   * "Permanently delete Hub jobs you own, including their trials"). Works on
   * uploaded and native jobs alike; deleting an uploaded job frees its
   * duplicate lock, so delete-then-reupload is the replace path.
   *
   * CREATOR-ONLY: org members may operate a job (cancel, retry), never
   * destroy its record — a member who did not create it is refused
   * (`org_forbidden`, 403). TERMINAL ONLY — never a delete under a live
   * worker: a QUEUED/RUNNING/CANCELLING job refuses `job_not_terminal`
   * (409; cancel first), a queued or running analysis wave refuses
   * `analysis_already_running` (409), and a live regrade derived from this
   * job refuses `job_not_terminal` with the regrade jobs to wait for in
   * `details.regrade_job_ids`. A regrade job id is itself not deletable
   * here (`job_not_found`, 404) — a regrade's results are deleted from the
   * traces surface. What stays: regrade JOB rows and `source_jobs` history,
   * which keep naming the deleted id; the model gateway's own ledger
   * remains the billing truth.
   *
   * The response is the receipt: what was destroyed, counted.
   */
  delete(id: string): Promise<JobDeleteResult>;
  /**
   * Grep the parsed trace of EVERY trial of the job in one server-side pass.
   * `q` is the trace filter's grammar: a case-insensitive POSIX regex over
   * each event's type and serialized content, where a plain string is a
   * plain substring. Items are per-trial groups (exact count + the first few
   * matching events), ordered by trial id; page with { cursor }. An empty
   * page means no matches anywhere — a normal answer.
   */
  grep(id: string, q: string, options?: GrepJobOptions): Promise<JobGrepPage>;
}

/**
 * The trace route's `?stream=` selectors, in the contract's own order —
 * `trace-parsed` (the parsed event trace, the same answer as omitting
 * `stream`) followed by the raw-artifact vocabulary. `trace-atif` is the
 * SERVED normalized trajectory (Harbor's ATIF v1.7); `trajectory` is a
 * DIFFERENT artifact — the harness's own native session file, in the
 * vocabulary ahead of its server wave (the server answers not-found for it
 * until that wave lands). A runtime value (not only a type) so a drift gate
 * can hold it to the spec's enum, and the CLI can build its `--stream`
 * validation from the same list instead of a second copy.
 */
export const TRIAL_ARTIFACT_STREAMS = [
  "trace-parsed",
  "verifier",
  "trace-stdout",
  "trace-stderr",
  "trace-atif",
  "trajectory",
  "agent-home",
] as const;

/** One `?stream=` selector on the trace route. */
export type TrialArtifactStream = (typeof TRIAL_ARTIFACT_STREAMS)[number];

/** Client for globally addressable trials — no job id in any signature */
export interface TrialsClient {
  /**
   * Get one trial by its globally addressable id. The body carries `job_id`
   * as the reverse pointer; `exception_info.exception_message` is untruncated
   * here, unlike list rows.
   */
  get(trialId: string): Promise<Trial>;
  /** Get one page of a trial's trace; resume with { cursor: page.nextCursor } */
  trace(trialId: string, options?: TraceOptions): Promise<TraceEventPage>;
  /**
   * Iterate a trial's trace events, fetching pages under the hood until
   * the currently available trace is drained. Resume later by passing the
   * last seen seq as { cursor }.
   */
  traceEvents(trialId: string, options?: TraceOptions): AsyncIterableIterator<TraceEvent>;
  /**
   * One RAW trace artifact, by the trace route's ?stream= selector.
   * "verifier" | "trace-stdout" | "trace-stderr" answer the log text;
   * "trace-atif" answers the normalized trajectory — Harbor's ATIF v1.7
   * document as JSON text, built server-side from the stored parsed trace
   * (the same document jobs.download() places at Harbor's own path
   * agent/trajectory.json); "trajectory" is the reserved harness-native
   * session file, refused not-found by the server until its wave lands;
   * "agent-home" answers the CLI's whole home folder (subagent transcripts
   * included), keyed by sandbox path. Null = never stored
   * (a normal answer, not an error). "trace-parsed" is not an
   * artifact — the parsed event trace rides trace()/traceEvents().
   */
  artifact(
    trialId: string,
    stream: Exclude<TrialArtifactStream, "trace-parsed" | "agent-home">
  ): Promise<string | null>;
  artifact(trialId: string, stream: "agent-home"): Promise<Record<string, string> | null>;
  /**
   * Regrade one settled trial: re-run its verifier against its recorded
   * inputs in a fresh separate verifier box. Refused
   * (regrade_source_ineligible) for shared-mode or pre-persistence trials.
   * THE RESPONSE IS A JOB — a one-trial regrade job with `source_jobs`
   * recording the provenance.
   */
  regrade(trialId: string): Promise<Job>;
  /**
   * Run ONE settled trial again. THE RESPONSE IS A JOB — a one-trial retry
   * job inheriting the source job's config, with `source_jobs` recording
   * `action: "retry"`; the source trial is immutable. The same operation as
   * jobs.retry(jobId, {trial_ids: [trialId]}) — one selection rule, one
   * fingerprint — kept as its own door because the trial is what you are
   * holding. The source JOB may still be running; the trial must be settled
   * (`trial_not_settled` otherwise). Supports Idempotency-Key.
   */
  retry(trialId: string, options?: StartJobOptions): Promise<Job>;
  /**
   * Stop selected in-flight trials without cancelling their job: each trial's
   * sandbox is killed and the trial is settled with its spend read from the
   * gateway. Ids may be eval trials and trace analyses, freely mixed — what
   * each id is gets resolved server-side; a stopped analysis settles `failed`
   * (failure phase `stopped`) and is reported under `stopped_analyses`. Only
   * the caller's own work; ids belonging to someone else are reported in
   * `not_found` (existence is never leaked). Idempotent — already-terminal
   * ids are reported as such and left untouched.
   */
  stop(trialIds: string[]): Promise<StopResponse>;
  /**
   * List the trial's ENTIRE stored file tree — the read-only-filesystem law:
   * session files, verifier log, raw agent streams, live chunks, everything
   * the platform stored, as {path, size_bytes} rows sorted by path. Read any
   * row with file(). An empty page is a normal answer.
   */
  files(trialId: string, options?: ListTrialFilesOptions): Promise<TrialFilePage>;
  /**
   * RAW BYTES of one stored file, by the path files() names — byte fidelity,
   * no translation. `range` reads a slice ({ start, end } inclusive,
   * { start } to the end, or { suffix } for the last N bytes) so a huge log
   * tails without shipping whole. A path the tree does not hold surfaces as
   * the API's typed 404.
   */
  file(trialId: string, path: string, range?: TrialFileRange): Promise<Buffer>;
}

// =============================================================================
// ANALYSES (the analyzer's own runs, read off the dashboard's traces feed)
// =============================================================================

/**
 * The stored artifacts an analysis run OWNS under its own id — the analyzer's
 * raw process streams and its session home (the executor stores exactly these
 * three at settle). A runtime value like TRIAL_ARTIFACT_STREAMS, for the same
 * reason: the CLI builds its `--stream` validation from this list instead of
 * a second copy. `verifier` and `trace-atif` are deliberately NOT members: an
 * analysis never has them, and the server refuses them typed rather than
 * answering a null that would read as "not stored".
 */
export const ANALYSIS_ARTIFACT_STREAMS = [
  "trace-stdout",
  "trace-stderr",
  "agent-home",
] as const;

/** One stored-artifact selector of an analysis run. */
export type AnalysisArtifactStream = (typeof ANALYSIS_ARTIFACT_STREAMS)[number];

/** Options for analyses().transcript(). */
export interface AnalysisTranscriptOptions {
  /**
   * Skip the first N events — the feed's own resume grammar ("everything
   * after the N events I already hold"). An analysis's seqs are allocated
   * densely from 0, so N is also the seq the returned events start at.
   * A non-negative integer; anything else is refused client-side.
   */
  since?: number;
}

/**
 * One analysis run's transcript: the ANALYZER's own parsed events — never the
 * analyzed trial's agent trace — plus the identity facts the feed serves
 * around them. Unlike a trial's trace there is no server-side paging: one
 * read answers everything after `since`, and `total` counts ALL stored rows,
 * so `events.length < total` with `since: 0` can only mean rows arrived
 * between count and read (a live analysis).
 */
export interface AnalysisTranscript {
  id: string;
  /** The trial this analysis read — the walk back to the analyzed work. */
  analyzed_trial_id: string | null;
  /** The analyzed trial's job. */
  job_id: string | null;
  /** The analyzed task's key. */
  task_name: string | null;
  /** The model the analyzer ran. */
  model_name: string | null;
  /** Where the ANALYZER's own box ran — never the analyzed arm's. */
  sandbox_provider: string | null;
  sandbox_id: string | null;
  /** True once the analysis has settled (completed or failed). */
  is_ended: boolean;
  /** ALL stored rows for this analysis, independent of `since`. */
  total: number;
  /**
   * The events after `since`, in TraceEvent shape. The feed serves the bare
   * parsed payloads; `seq` is synthesized as since+index (sound because seqs
   * are dense from 0) and `type` by the viewer's own one extraction.
   */
  events: TraceEvent[];
}

/**
 * Client for analysis runs — the analyzer's own transcript, verdict document,
 * and stored artifacts, all globally addressable by analysis id.
 *
 * DELIBERATELY OFF-CONTRACT: these three reads ride the dashboard's traces
 * feed (`/api/traces/trials/{id}/events` and `…/artifacts`), which is NOT in
 * spec/openapi.yaml — `traces` is outside the prefixes the platform's drift
 * gate walks (swarm_dashboard `__tests__/api/spec-drift-gate.test.ts`
 * CONTRACT_PREFIXES), and the one precedent for a transcript door living
 * off-contract is that gate's RUNTIME_INTERNAL_ROUTES: `api/sessions/[id]/
 * events`, the dashboard UI's own session transcript view, is enumerated
 * there as a route no SDK client calls. RECORDED TENSION: that gate names the
 * excluded planes "planes no SDK client calls" — this client is the first to
 * call one, so whether the feed joins the contract (spec + both SDK shadows)
 * is an open ruling, not something settled here. The contract-side verdict
 * stays where it always was — `Trial.analysis` on the trial body; this client
 * adds the reads the contract does not carry today.
 */
export interface AnalysesClient {
  /**
   * Every analysis you may read, newest first (cursor-paged) — the catalog
   * of trace-analysis runs, `GET /api/analyses`. Each row is the wire's
   * TrialAnalysis carrying the trial, job, and task it judged, so a
   * headless round is list → get each. `{ scope, job, status }` narrow it;
   * await the handle for one page, or `for await` it to walk every page.
   * One boundary under `scope: "shared"` today: those rows list, but `get`,
   * `transcript` and `artifact` refuse them (404 `Trial not found`) — the
   * feed doors they ride open only to the job's creator (owner ruling on
   * aligning those doors pending); `my` rows resolve on every read.
   */
  list(options?: ListAnalysesOptions): AnalysisList;
  /**
   * The verdict document — the wire's TrialAnalysis, statuses and typed
   * failure included, for EVERY analysis (not only completed ones). The same
   * object the analyzed trial serves as `Trial.analysis` when this analysis
   * is its latest; this door answers for earlier analyses too.
   */
  get(analysisId: string): Promise<TrialAnalysis>;
  /**
   * The analyzer's own transcript (see AnalysisTranscript). An id the feed
   * resolves to a trial or a regrade — the route answers those first —
   * refuses with an error naming the species rather than handing back the
   * wrong run's events.
   */
  transcript(analysisId: string, options?: AnalysisTranscriptOptions): Promise<AnalysisTranscript>;
  /**
   * One stored artifact by selector: the analyzer's raw stdout/stderr answer
   * the text, "agent-home" the sandbox-path → text map of its session home.
   * Null = never stored (a normal answer, not an error): a QUEUED analysis,
   * or one whose box died before the settle stored anything. Like
   * transcript(), an id the feed resolves to a trial or a regrade refuses
   * with an error — the feed's stored selectors would answer for either
   * species, so the analysis-only ?what=analysis door is resolved first and
   * the wrong run's bytes are never served.
   */
  artifact(
    analysisId: string,
    stream: Exclude<AnalysisArtifactStream, "agent-home">
  ): Promise<string | null>;
  artifact(analysisId: string, stream: "agent-home"): Promise<Record<string, string> | null>;
}

/** A key descriptor. The secret is never returned. */
export interface ApiKey {
  id: string;
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

/** Who the caller is and the key they used. */
export interface AuthStatus {
  user_id: string;
  email: string | null;
  key: ApiKey;
}

/** Client for caller identity. */
export interface AuthClient {
  /** Identify the caller and the API key in use. */
  status(): Promise<AuthStatus>;
}

// =============================================================================
// ORGANIZATIONS (team accounts) — the read pair the CLI's `auth org` speaks
// =============================================================================

/** The caller's role in an organization: owner manages, member reads and runs. */
export type OrgRole = "owner" | "member";

/** An organization the caller belongs to (`GET /api/orgs` item; Harbor's `auth org list` row). */
export interface Organization {
  org_id: string;
  /** URL-safe handle, globally unique — the `<slug>` every org verb takes. */
  slug: string;
  display_name: string;
  /** True for the auto-created personal org — the invisible default owner of everything created without naming an org. */
  personal: boolean;
  /** The CALLER'S role; present when the read implies membership. */
  role?: OrgRole;
  created_at: string;
}

/**
 * An organization's ceilings, every one EFFECTIVE — the value the platform
 * administrator set, else the fleet default. `0` means paused: creates are
 * refused `quota_exceeded`, queued work waits. Set only from the platform
 * administrator's dashboard session; the SDK reads them.
 */
export interface OrgQuota {
  /** Trials running at once (RUNNING or SCORING); work beyond it waits. */
  max_concurrent_trials: number;
  /** Trials waiting in the queue — the one refusal (`quota_exceeded`) on job create. */
  max_queued_trials: number;
  /** Dataset imports a worker holds at once; further imports wait. */
  max_concurrent_imports: number;
  /** Trace analyses running at once; further analyses wait. */
  max_concurrent_analyses: number;
  /** Managed-agent sessions open at once (recorded and read back; not yet enforced by the box-create doors). */
  max_concurrent_sessions: number;
  /** Model spend allowed this calendar month, USD; null = no monthly budget. */
  monthly_budget_usd: number | null;
  /** Sandboxes of this organization in flight on e2b at once — trials, trace analyses, regrade verifiers and managed sessions together; work beyond it waits; 0 pauses the organization on that provider; fleet default = the platform's own e2b ceiling. */
  max_concurrent_sandboxes_e2b: number;
  /** The same ceiling on daytona: the organization's sandboxes in flight there at once; work beyond it waits; 0 pauses the organization on daytona; fleet default = the platform's own daytona ceiling. */
  max_concurrent_sandboxes_daytona: number;
  /** The same ceiling on modal: the organization's sandboxes in flight there at once; work beyond it waits; 0 pauses the organization on modal; fleet default = the platform's own modal ceiling. */
  max_concurrent_sandboxes_modal: number;
}

/** The live load beside the ceilings — what `evolve auth org show` prints as N/M. */
export interface OrgUsage {
  in_flight_trials: number;
  queued_trials: number;
  in_flight_imports: number;
  in_flight_analyses: number;
  /** Sessions not yet ended; always 0 on a shared org (sessions carry no organization). */
  active_sessions: number;
  /** Recorded model spend since the first of the current calendar month (UTC). */
  month_spend_usd: number;
}

/** One organization in depth (`GET /api/orgs/{org}`): the row, the member count, its quota and usage. */
export interface OrganizationDetail extends Organization {
  member_count: number;
  quota: OrgQuota;
  usage: OrgUsage;
}

/**
 * Client for the caller's organizations — the read pair. Creating, renaming,
 * deleting, members and invite links are served by the API and stay outside
 * the SDK until a wave asks for them; quotas are set only from the platform
 * administrator's dashboard session, so no SDK method could ever set one.
 */
export interface OrgsClient {
  /** Every organization the caller belongs to, personal first (`GET /api/orgs`). */
  list(): Promise<Organization[]>;
  /** One organization by slug (or id): role, member count, quota, usage (`GET /api/orgs/{org}`). */
  get(org: string): Promise<OrganizationDetail>;
}

// =============================================================================
// ERROR VOCABULARY
// =============================================================================

/**
 * Every error code the hosted API can return, as a closed list.
 *
 * This exists so a typo cannot compile. `err.code === "insufficient_creidts"`
 * used to typecheck (code was `string`) and then silently never match, which is
 * the worst shape a bug can take: the branch looks handled and never runs.
 *
 * It mirrors the ErrorCode enum in spec/openapi.yaml and is published verbatim
 * at GET /api/meta as `error_codes`. A server newer than this SDK may send a
 * code that is not listed here — `EvolveApiError.code` widens to string for
 * exactly that case, so an unknown code is still readable, just not narrowable.
 *
 * Held to the spec by hosted-error-codes.json at the package root, the
 * checked-in copy both SDKs assert against; the list drifted silently before
 * that file existed. Adding a code means editing the spec, that file, this
 * list, and the Python pair.
 */
export const HOSTED_ERROR_CODES = [
  "missing_authorization",
  "invalid_api_key",
  // A valid key created read-only, presented to a mutating route (403).
  "read_only_key",
  "credential_service_unavailable",
  "rate_limited",
  "insufficient_credits",
  // The owning organization's queued-trial ceiling would be crossed by
  // this create (429, no Retry-After — the wait is not a known number).
  // Harbor's hosted refusal: the message starts `hosted quota exceeded:`;
  // details carry {quota, limit, used, requested, org}.
  "quota_exceeded",
  "invalid_json",
  "invalid_input",
  "invalid_limit",
  "invalid_status",
  "invalid_visibility",
  "invalid_cursor",
  "invalid_after",
  "invalid_format",
  "invalid_ids",
  "invalid_multipart",
  "idempotency_key_reused",
  "dataset_not_found",
  "dataset_version_not_found",
  "dataset_name_taken",
  "dataset_in_use",
  "dataset_not_owned",
  // The visibility flip while a version is still importing (409): the import
  // decides which registry its images land in from the dataset's visibility
  // at import start, so a mid-import flip is refused — `details` names the
  // live version and its import status; flip again once the import settles.
  "dataset_import_in_progress",
  "upstream_not_watchable",
  "no_active_version",
  "version_not_ready",
  "version_not_activatable",
  "unknown_task_names",
  "no_tasks",
  // Partial publish: the failure-detail read of a task name with no recorded
  // build outcome in the version, and a job create that NAMES a task whose
  // build FAILED (refused typed, quoting the build failure — never a silent
  // skip of an explicitly requested task; `details.failed_tasks` carries
  // every named one with its reason).
  "task_not_found",
  "task_failed_to_build",
  // Resumable corpus uploads (the chunked publish door datasets().publish()
  // switches to automatically above the threshold — hosted/resumable.ts).
  "upload_session_not_found",
  "upload_offset_mismatch",
  "upload_chunk_digest_mismatch",
  "upload_incomplete",
  "upload_archive_digest_mismatch",
  "upload_session_failed",
  "too_many_concurrent_upload_chunks",
  "agent_not_found",
  "agent_name_taken",
  "agent_name_reserved",
  "agent_invalid_name",
  "agent_source_required",
  "agent_source_conflict",
  "agent_invalid_env",
  "agent_too_large",
  "agent_limit_reached",
  "skill_not_found",
  "skill_name_not_found",
  "skill_ref_invalid",
  "skill_unresolvable",
  "skill_invalid",
  "skill_in_use",
  "skill_too_large",
  "skill_limit_reached",
  // The server is already processing its bound of concurrent skill uploads
  // on POST /api/skills (429; details carry max_concurrent) — each in-flight
  // upload owns up to its tarball plus its extracted tree of server disk
  // while the request is in flight. Refused before the first uploaded byte
  // is read; retry
  // when an in-flight upload finishes. The skill-door sibling of
  // too_many_concurrent_job_uploads / too_many_concurrent_imports below, and
  // distinct from rate_limited for the same reason: nothing was rate-counted
  // and there is no Retry-After — the server's disk is busy.
  "too_many_concurrent_skill_uploads",
  "secret_not_found",
  "secret_ambiguous",
  "secret_brokered_unsupported",
  "secret_exists",
  // A selected task's environment.env asks for a `${VAR}` the job attaches
  // no secret for, and the declaration states no default — refused at job
  // create (attach-is-consent). Not secret_not_found: the row usually exists
  // in the owner's vault; the remedy is to attach it to the job.
  "secret_not_attached",
  "agent_version_not_found",
  "agent_version_unresolvable",
  "agent_kwarg_unsupported",
  "agent_config_unsupported",
  "agent_config_key_refused",
  "agent_preset_unsupported",
  "job_too_large",
  "provider_unsupported",
  "job_not_found",
  "job_not_terminal",
  "no_failed_trials",
  "trial_not_found",
  "trial_not_settled",
  "concurrent_update",
  "regrade_source_ineligible",
  "no_regradable_trials",
  // Analyze: a rubric that cannot rule an analysis (unknown keys, empty or
  // duplicate criteria, bounds exceeded); one wave at a time (re-analysis is
  // legal once the previous wave settles); a terminal job with no analyzable
  // trial (every trial CANCELLED).
  "invalid_rubric",
  "analysis_already_running",
  "no_analyzable_trials",
  // Job upload (POST /api/jobs/upload): the archive is not a Harbor job
  // directory (no result.json / config.json at its root, or they do not
  // parse); one trial directory that cannot be ingested (the refusal names
  // the trial and the reason, 422); the archive over the byte cap (413,
  // distinct from import_too_large — that one belongs to dataset corpora);
  // and a run-lifecycle verb (resume / retry / regrade) on an UPLOADED job —
  // a terminal record of a run that happened elsewhere, never runnable here
  // (409; analyze is deliberately not among the refusers).
  "not_a_job_dir",
  "invalid_trial",
  "upload_too_large",
  "job_uploaded",
  // Re-uploading an archive whose job this caller already uploaded (409),
  // detected by (uploading user, the archive result.json's own job id);
  // details name the existing job. Deliberately NOT Harbor's update-in-place:
  // our trial rows carry analyses and analysis history — silently replacing
  // trials would destroy them; Harbor's hub rows have no such children.
  "job_already_uploaded",
  // The server is already spooling its bound of concurrent job-archive
  // uploads on POST /api/jobs/upload (429; details carry max_concurrent).
  // Refused before the first uploaded byte lands; retry when an in-flight
  // upload finishes. The jobs-door twin of too_many_concurrent_imports
  // below, and distinct from rate_limited for the same reason: nothing was
  // rate-counted and there is no Retry-After — the server's disk is busy.
  "too_many_concurrent_job_uploads",
  "import_not_found",
  "import_too_large",
  // The server is already spooling its bound of concurrent corpus uploads
  // (429; details carry max_concurrent). Refused before the first uploaded
  // byte lands; retry when an in-flight upload finishes. Distinct from
  // rate_limited: nothing was rate-counted and there is no Retry-After —
  // the server's disk is busy.
  "too_many_concurrent_imports",
  "invalid_archive",
  "unpinned_git_ref",
  // A hub_package publish naming a package the Harbor hub does not show the
  // server: it does not exist, or it is private (anonymous reads cannot see
  // private packages, and authenticated hub sources are not supported yet —
  // the refusal says both). 400; details carry `hub_package`.
  "hub_package_not_found",
  // The Harbor hub could not be asked while accepting a hub_package publish
  // (network/timeout/5xx). Refused rather than accepted unpinned — a hub ref
  // is pinned by resolving it at accept time — so retry the publish. 502.
  "hub_unreachable",
  "package_not_retained",
  "package_corrupt",
  "package_missing",
  // The server is already serving its bound of concurrent package downloads
  // on GET /api/datasets/{name}/download (429; details carry max_concurrent)
  // — each in-flight download holds up to a full operator archive cap of
  // server disk from the store fetch through the digest pre-read and the
  // entire client download. Refused before the first fetched byte; retry
  // when an in-flight download finishes. The download twin of the three
  // too_many_concurrent_* upload codes above, and distinct from rate_limited
  // for the same reason: nothing was rate-counted and there is no
  // Retry-After — the server's disk is busy.
  "too_many_concurrent_package_downloads",
  // Team accounts (orgs, members, invite links)
  "org_not_found",
  "org_slug_taken",
  "org_forbidden",
  "org_personal_immutable",
  "org_last_owner",
  "org_in_use",
  "org_member_not_found",
  "invite_not_found",
  "invite_invalid",
  "internal_error",
] as const;

/** One of the API's stable error codes. */
export type HostedErrorCode = (typeof HOSTED_ERROR_CODES)[number];

/** True when `value` is a code this SDK version knows about (narrowing guard). */
export function isHostedErrorCode(value: unknown): value is HostedErrorCode {
  return (
    typeof value === "string" && (HOSTED_ERROR_CODES as readonly string[]).includes(value)
  );
}

// =============================================================================
// CAPABILITY DOCUMENT (GET /api/meta)
// =============================================================================

/** A closed vocabulary a client renders, with the members that end it. */
export interface StatusVocabulary {
  values: string[];
  /** Members after which nothing more happens — a watcher may stop here. */
  terminal: string[];
}

/**
 * The `effort_support` vocabulary, published as a runtime list so the drift
 * gate can hold this union to the contract's enum — and so a client can
 * narrow an unknown string. The server serves exactly these members.
 */
export const AGENT_EFFORT_SUPPORT_VALUES = ["level", "binary", "none"] as const;

/** What an agent does with `agents[].reasoning_effort` — see AgentCapability. */
export type AgentEffortSupport = (typeof AGENT_EFFORT_SUPPORT_VALUES)[number];

/** One model alias an agent offers, for a picker's option list. */
export interface AgentModelOption {
  alias: string;
  model_id: string;
  description: string | null;
}

/** One built-in agent's declared capabilities. */
export interface AgentCapability {
  name: string;
  /** false = registered but the agent phase must refuse it, with `reason` set. */
  runnable: boolean;
  /** Why not, when `runnable` is false. Null otherwise. */
  reason: string | null;
  /**
   * What the evolve SDK runs when no model is named. This API REQUIRES an
   * explicit model (limits.job.model_required), so treat it as the sensible
   * pre-selection for a picker — the server never fills it in for you.
   */
  default_model: string | null;
  /** Known model aliases for this agent — the picker's option list. */
  models: AgentModelOption[];
  /**
   * What this agent does with `agents[].reasoning_effort`:
   *   'level'   the value reaches the agent CLI as a level
   *   'binary'  thinking on/off only — a level outside
   *             limits.job.binary_effort_values is refused at create
   *   'none'    no effort input at all; naming one is refused at create
   * Published so a builder greys the control out instead of discovering the
   * refusal after a POST.
   */
  effort_support: AgentEffortSupport;
  /** The pinned default stored when a create request omits the effort; null for 'none'. */
  default_effort: string | null;
  /** Whether job agents[].version may pin this agent. */
  version_pinnable: boolean;
  /**
   * Whether job `agents[].kwargs.config` reaches this agent — native
   * agent-settings support (Harbor's SUPPORTS_CONFIG). Declaring a config for
   * an agent without it is refused `agent_config_unsupported`.
   */
  supports_config?: boolean;
  /**
   * The named settings presets this agent can guarantee (`no-internet`,
   * `pinned-context`). Declaring `agents[].preset` outside this list is
   * refused `agent_preset_unsupported`. Absent on older servers = none
   * advertised.
   */
  presets?: string[];
  /**
   * Newest published version, for a "your pin is out of date" badge. Null
   * means "not known right now", never "up to date".
   */
  latest_version?: string | null;
}

/** One sandbox provider, its ceilings, and what it refuses. */
export interface ProviderCapability {
  name: string;
  default: boolean;
  sizing: {
    max_cpus: number;
    max_memory_mb: number;
    max_storage_mb: number;
    storage: "sized" | "fixed";
  };
  /**
   * GPU capability of this provider for eval boxes right now. When
   * `supported` is false, `degrades_to` names where a GPU job stamped here
   * actually runs (modal) and `reason` is the same sentence the trial
   * records; daytona's answer comes from a live org-quota probe that fails
   * closed, and `source` says whether it was measured ('live-quota') or is
   * the conservative fallback. Absent on servers predating the field.
   */
  gpus?: {
    supported: boolean;
    /** Per-container allocation ceiling; import refuses tasks above it. */
    max_gpus: number;
    degrades_to?: "modal";
    reason?: string;
    source?: "live-quota" | "fallback" | "provider-constant";
  };
  refuses: { capability: string; reason: string }[];
}

/**
 * One managed sandbox door and whether this deployment serves it — a
 * different question from ProviderCapability, which is about the eval lane.
 * A managed sandbox is one the caller drives directly holding nothing but an
 * Evolve key.
 */
export interface ManagedProviderCapability {
  name: string;
  /**
   * The operator config this door reads is present. NOT a health check: it
   * says nothing about whether the pass-through behind the door is deployed
   * or the credential behind it is valid.
   */
  configured: boolean;
  /** Config this door reads, so an operator sees what to set. */
  requires_config: string[];
  /** The subset of `requires_config` missing right now — empty when configured. */
  missing_config: string[];
  /** A full SDK agent session can run on this door. */
  agent_sessions: boolean;
  /** Why not, when `agent_sessions` is false. Null otherwise. */
  agent_sessions_reason: string | null;
}

/**
 * The capability document: everything a client would otherwise hardcode.
 *
 * Public and cacheable — no API key needed, so a signed-out page can populate
 * its own agent picker. `schema_version` bumps when a FIELD changes meaning,
 * never when a value changes.
 */
export interface CapabilityDocument {
  schema_version: number;
  /** Built-in agents and their declared capabilities. */
  agents: AgentCapability[];
  /** Rules a bring-your-own agent registration must satisfy. */
  agent_registration: {
    name_pattern: string;
    max_name_length: number;
    max_run_command_length: number;
    max_install_script_length: number;
    max_env_entries: number;
    max_per_user: number;
    max_upload_bytes: number;
    /** Built-in names a registration may not reuse. */
    reserved_names: string[];
    /** Env keys the platform owns; declaring one is refused at registration. */
    reserved_env_keys: string[];
  };
  sandbox_providers: ProviderCapability[];
  /**
   * Fleet-wide cap on concurrently in-flight trials of GPU-declaring tasks
   * (platform-paid GPU compute). Queued GPU trials past the cap wait for a
   * slot. Absent on servers predating the field.
   */
  gpu_concurrency_cap?: number;
  /** The managed doors this deployment serves, and what each can carry. */
  managed_providers: ManagedProviderCapability[];
  /** Constraints that hold on EVERY provider. */
  platform_constraints: { capability: string; reason: string }[];
  network_modes: string[];
  /** Every status vocabulary on the surface, with terminal members. */
  statuses: {
    job: StatusVocabulary;
    trial: StatusVocabulary;
    import: StatusVocabulary;
    dataset_version: StatusVocabulary;
  };
  limits: {
    job: {
      max_n_attempts: number;
      max_agents: number;
      max_trials: number;
      n_concurrent_trials: { default: number; max: number };
      default_max_trial_spend_usd: number;
      /**
       * Applied to retry.max_retries when a create request omits it — the
       * auto-retry fleet default (Harbor's local default is 0; here
       * infrastructure errors retry automatically).
       */
      default_max_retries: number;
      /** The most retries a request may ask for. */
      max_retries_ceiling: number;
      default_sandbox_provider: string;
      default_sizing: { cpus: number; memory_mb: number; storage_mb: number };
      /** Every agent must name a model; the server applies no default. */
      model_required: boolean;
      /**
       * Phase wall-clocks a task INHERITS when its own config declares none —
       * a task that declares its own always wins, so these fill in rather than
       * cap. Published because nothing else here says how long a trial may run.
       */
      default_agent_timeout_sec: number;
      default_verifier_timeout_sec: number;
      /** Values agents[].reasoning_effort accepts, and the one an omitted effort takes. */
      reasoning_efforts: string[];
      default_reasoning_effort: string;
    };
    compare: { min_ids: number; max_ids: number };
    pagination: {
      collections: { default: number; max: number };
      dataset_tasks: { default: number; max: number };
      trace_events: { default: number; max: number };
    };
    uploads: {
      dataset_archive_bytes: number;
      agent_tarball_bytes: number;
      /** Compressed cap on one uploaded skill tarball (`skill_too_large` past it). */
      skill_archive_bytes: number;
      /** Uploaded-skill records one caller may hold (`skill_limit_reached` past it). */
      skill_uploads_per_user: number;
      /** Compressed cap on one uploaded job archive (`upload_too_large` past it). */
      job_archive_bytes: number;
      /** Most trials one uploaded job archive may carry (`job_too_large` past it). */
      job_trials: number;
      /** Per-file cap on the trial artifacts an upload stores (`invalid_trial` past it). */
      job_trial_file_bytes: number;
      /** Total cap on one trial's `agent/sessions/` tree (`invalid_trial` past it). */
      job_trial_session_bytes: number;
    };
    dataset_names: {
      pattern: string;
      max_name_length: number;
      max_version_length: number;
      max_git_url_length: number;
      max_git_ref_length: number;
      max_git_path_length: number;
    };
    /** How many items an error MESSAGE names before "and N more". */
    max_items_named_in_error_message: number;
  };
  /** The ImportWarning codes the platform can attach to an import. */
  import_warning_codes: string[];
  /** The closed error-code union, enumerated at runtime. */
  error_codes: string[];
}
