# Changelog

## Unreleased

### Highlights

- Adopted Harbor's vocabulary across the whole hosted surface: dataset, task, job, trial, agent, reward. `evaluations()` is now `jobs()`, task runs are trials, and scores are rewards.
- Made the hosted API uniform: one `Job` shape from every call, one `{ items, nextCursor, hasMore }` page on every collection, one error envelope carrying `param` and `details`, and `multipart/form-data` for both upload lanes.
- Published `GET /api/meta`, an unauthenticated, ETag'd capability document naming every harness, status enum, limit, and error code the platform enforces — so a client stops hardcoding them.
- Added regrades as a real resource, dataset deletion, agent upsert, import listing, and upstream version awareness.
- Settled the budget model on one per-trial cap: `maxTrialSpendUsd` optional ($200 server default, echoed resolved), `worstCaseSpendUsd` on job views, `402 insufficient_credits` at zero balance, and no credit draw for managed BYO provider key runs.
- De-scoped the agent-side eval-composition primitives from the docs chapters; the APIs keep their JSDoc but are no longer advertised.

### SDK

- Added the `orgs()` client (TypeScript and Python) and `hosted().orgs` — the read pair: `list()` is Harbor's `harbor auth org list` shape (the organizations you belong to, your role in each), `get(slug)` is the hosted extension — one organization with `member_count`, its effective `quota` (`OrgQuota`: five ceilings and `monthly_budget_usd`; `0` = paused, a `null` / `None` budget = no monthly budget) and its live `usage` (`OrgUsage`). Types `Organization`, `OrganizationDetail`, `OrgQuota`, `OrgUsage` exported in both languages, `OrgRole` in TypeScript. Quotas are set only from the platform administrator's dashboard session — no SDK method sets one. The error-code vocabulary gains `quota_exceeded` (429, no `Retry-After`, `details {quota, limit, used, requested, org}`, message prefix `hosted quota exceeded:` — Harbor's own refusal shape) plus `read_only_key`, `secret_not_attached` and the nine org/invite codes the server already answered (`org_not_found`, `org_slug_taken`, `org_forbidden`, `org_personal_immutable`, `org_last_owner`, `org_in_use`, `org_member_not_found`, `invite_not_found`, `invite_invalid`); the spec-lag lanes that tolerated their absence are retired.
- `DatasetVersion.source` now says where EVERY version came from, not only a git one: one shape per publish kind, discriminated on `kind` in the publish request's own words — `DatasetVersionGitSource` (`git`: `git_url`, `ref`, `commit`, `path`), `DatasetVersionArchiveSource` (`archive`, an uploaded directory: `digest`), `DatasetVersionArchiveUrlSource` (`archive_url`: the url as given + `digest`), `DatasetVersionHubSource` (`hub_package`: the reference as given + the hub content hash the import was pinned to). Every digest is spelled `sha256:<hex>`. Previously a hub, fetched-tarball or directory publish answered `source: null`. Both SDKs map a `kind`-less git object from an older server as git and any unknown kind to `null` / `None`.
- TypeScript `TrialSettledData.exception_message?`; Python reads it by key on `JobEvent.data`.
- Added the Daytona boot-progress hook to `@evolvingmachines/daytona`: `createSandboxObserved(client, params, { onProgress, signal })` runs the raw SDK create with its wall clock off and reports what the provider is doing beside it — every sandbox state change (found by a fresh `evolve_boot` label from the moment the row exists) and every build-log line — as `DaytonaBootProgress` events carrying the phase (`image_pull` while the runner is still materializing the image, `boot` otherwise); aborting the signal deletes the half-made box and rejects with `DaytonaBootAbortedError` naming phase, state and id. The hosted eval worker uses it to bound a boot by progress instead of a fixed wall, so a cold multi-GB image pull that is moving is no longer killed at ten minutes.
- FIXED the chunked (resumable) publish dying on a rate limit: a `429`/`503` on any request of the upload session — the open, a chunk, the offset probe, the finalize — is now waited out (the server's Retry-After, floored at Harbor's backoff, capped at 60 s per wait, at most three waits per request) and the same request re-sent from the same offset; only a limit still standing after those waits surfaces, as the typed error it always was. An 8 GB publish previously died on ONE `429 rate_limited` (`retryAfterSec: 9`) mid-stream. Both SDKs, one set of numbers. `dataset publish --json --watch` gains a piped-consumer test pinning that every NDJSON event reaches a piped stdout the moment it is emitted, never at exit.
- `Trial.gpu_cost` now records the device's provenance: `declared_gpu_types`, `resolved_gpu_types` and `attached_gpu_type` replace `declared_gpu_type`; `gpu_type` is the device actually priced — the provider-reported pin, else the one type the create request carried — and a request that let the provider choose is unpriced with the candidates named, never priced under the task's first spelling. Records priced under `rate_card.version` 1 keep their single spelling. The CLI's priced sentence names `gpu_type`.
- Added Harbor's `--scope my|shared` (`harbor hub job list --scope`) to `jobs().list({ scope })` / `jobs().list(scope=)`, and the `analyses().list()` catalog (`GET /api/analyses`: `scope`, `job`, `status`, cursor-paged) — TypeScript's `analyses()` gains `list()`, Python gains the `analyses()` client and `hosted().analyses` — with the runtime vocabularies `JOB_LIST_SCOPES` / `ANALYSIS_STATUSES` (`JobListScope` / `AnalysisStatus`) and provenance `trial_id` / `job_id` / `task_name` on every `TrialAnalysis`. Harbor's `all` is refused — nothing hosted is public.
- Added typed task notes: `Task.notes` (always present, `[]` when there is nothing to say), `PreflightTaskVerdict.notes`, and the `tests_dockerfile_not_built` code on `TaskNote` and `ImportWarning` — a `separate` verifier pinning a `docker_image`, or a `shared` verifier, boots its image as-is and never builds `tests/Dockerfile` (Harbor's `should_use_prebuilt_docker_image`, environments/definition.py:26-36); the trivial-recipe refusal is gone.
- Made corpus packing skip recompressing already-compressed entries: the packer now writes incompressible files as stored gzip segments (both SDKs, one identical layout), cutting publish CPU on media- and binary-heavy corpora. The output stays one standard gzip member — plain gunzip reads it — but the archive's bytes, and so its digest, change once with this version for the same corpus.
- Added register-first publishing on the resumable upload door: `publish(..., { onRegistered })` / `on_registered=` hands the caller the pre-created import id before the first byte moves, imports carry `receiving` while the corpus is still uploading, and `RECEIVING` joined the dataset-version states — so a watcher can attach mid-upload, from any machine.
- FIXED gateway mode with your own sandbox key (E2B / Daytona / Modal): every run died at boot with "Failed to bind provider runtime token to sandbox", because the bind only accepted platform-created sandboxes. The SDK now declares the sandbox's provider on bind for a box it created on your account, and the platform binds it with a real 24-hour token expiry in place of managed-liveness revocation.
- Added the one-home `usage` reading to trials and sessions in both SDKs: `{ provisional, spent_usd, input_tokens, cached_input_tokens, output_tokens, as_of }`, identical keys on `Trial.usage` and the sessions client's `SessionInfo.usage` — live provisional numbers that tick while a run is metered, replaced by the settled figures at completion; `null`/`None` means the meter never answered. The CLI folds it in: `evolve trial show` gains a `tokens` row, the trial list gains an opt-in `TOKENS` column, and the `SPENT` column states a running trial's live floor as `at least $X` (`trialSpendNow` exported beside the other money-lane rules). Session spend (`getSessionCost`/`getRunCost` and `/api/sessions/spend`) now itemizes the `cached` token share beside `prompt`/`completion`.
- REMOVED the legacy activation-gate surface from the wire and both SDKs: `DatasetVersion.gate`, `Task.gate`, and the `DatasetVersionGate` / `DatasetVersionGateFailedTask` / `DatasetVersionGateUnproven` / `TaskGate` types are gone (the verification gate no longer exists server-side), and `VALIDATING` left `DatasetVersionState`. `READY` now means "every task image is in the platform registry"; each sandbox provider builds its own boot artifact at the first trial on it, cached provider-side — nothing per-provider is built at publish. The CLI's `dataset show` drops its GATE column accordingly.
- FIXED the `AgentCapability.effort_support` type: the server serves the three-value vocabulary `'level' | 'binary' | 'none'`, but the spec and both SDKs typed it as a boolean — Python's `is True` coercion reported every agent as no-effort-support, and the only correct TypeScript check was a compile error. Both SDKs now carry the enum (`AGENT_EFFORT_SUPPORT_VALUES` / `EFFORT_SUPPORT_VALUES` exported), fail CLOSED to `'none'` on an unknown value, and every drift gate (spec, TS, Python, server) pins the vocabulary so this class cannot recur silently.
- Added the five `AgentCapability` fields the server always served but the SDKs dropped: `runnable`, `reason`, `default_model`, `models` (the picker's option list, `AgentModelOption`), and `default_effort`.
- Published the skill-upload ceilings beside their siblings in `meta().limits.uploads`: `skill_archive_bytes` and `skill_uploads_per_user` — previously enforced (`skill_too_large`, `skill_limit_reached`) but stated nowhere.
- Declared the managed-agents SDK-runtime surface (sessions, checkpoints, managed/provider secrets, browser doors, integrations, managed passthroughs) in `spec/openapi.yaml` as `x-plane: sdk-runtime` operations, and put it under the drift gates on both sides — it was previously excluded wholesale.
- Documented the job-archive extension keys (`x_evolve`, `x_reasoning_effort`, `x_preset`) and the `artifacts/manifest.json` entry shape as contract schemas; a user reconciling costs now has `x_evolve.spentUsd`/`spendSource` stated in the open contract.
- Landed the ATIF trajectory contract at `spec/atif/trajectory.schema.json` — a language-neutral JSON Schema generated from Harbor's own Pydantic trajectory models (pinned Harbor commit in the file and `spec/atif/README.md`), shipped with the package and mirrored byte-identically server-side, where the emitter is validated against it.
- Renamed the hosted client to Harbor's nouns: `jobs()` replaces `evaluations()`, `trials()` / `trial()` replace the task-run collection, `agents` replaces agent systems, and `reward` replaces score. `maxTrialSpendUsd` is the per-trial cap; the job-level pot is gone.
- Added `hosted()`, one door that builds `datasets`, `agents` and `jobs` from a single configuration, and `meta()`, which reads the public capability document with no API key.
- Added the `agents()` client (TypeScript and Python): register your own CLI by install script or uploaded directory, and use its name in `agents[].harness` exactly like a built-in. `upsert()` replaces a registration without a window where the name does not exist — `201` with `Location` when it creates, `200` when it replaces.
- Unified every job response on one serializer: `run()`, `get()`, `list()`, `cancel()` and `rerunFailed()` return the same fields, including `trials: { total, byStatus }` with every status present at zero and `failure` — never a top-level `error` on a `200`.
- Paged every collection the same way: `{ items, nextCursor, hasMore }` with `?cursor=&limit=`, including collections that previously had no paging at all, and every list handle is awaitable for one page or iterable for all of them.
- Widened the error object: `code` (a closed union, with `HOSTED_ERROR_CODES` / `isHostedErrorCode()` exported), `param` naming the offending input, `details` that never truncates, plus `requestId` and `retryAfterSec`. A client no longer parses English.
- Added regrades as a resource: `getRegrade()` / `get_regrade()` reads by the **regrade's** id (the one `regrade()` returns and the `202`'s `Location` names), and `listRegrades()` / `list_regrades()` finds them by `jobId`. This replaces `regradeJob()` / `regrade_job()`, which took a job id, compiled, and 404'd.
- Made illegal states uncompilable: dataset-import and agent sources are discriminated unions, so passing both a git URL and a directory — or neither — is a type error in TypeScript and a `ValueError` before the request leaves the process in Python.
- Published `JobEvent` as a discriminated union: switching on `type` narrows `data`, so `trial.settled` payload fields are typed with no cast.
- Added `spentUsd` and `spendSource` to `Trial` — spend is a column now, not a key in the `modelUsage` blob — and `worstCaseSpendUsd` to `Job`.
- Added `listImports()` / `list_imports()` (filter by `status` and `dataset`), `datasets().delete()`, and upstream version awareness on `Dataset.upstream`: what the ref points at now versus what the active version was built from. Nothing is ever auto-imported.
- Import statuses are now the job vocabulary — `QUEUED → RUNNING → COMPLETED | FAILED` — replacing the private `IMPORTING`/`IMPORTED` spelling, and the import failure field is `failure`, not `error`.
- Moved both upload lanes to `multipart/form-data`: run commands and environment values no longer travel in query strings.
- Fingerprinted idempotency keys: reusing a key with a different body is refused with `409 idempotency_key_reused` instead of silently replaying the earlier job.
- Added the local-directory dataset import lane alongside git, both feeding the same parse → build → activate pipeline.
- Dataset imports no longer require an admin role: any authenticated key imports into its own private catalog. Foreign private datasets read as `404 dataset_not_found`; importing a name owned by anyone else refuses with `409 dataset_name_taken`.

### API

- `GET /api/orgs/{org}` serves `quota` (every ceiling effective — the platform administrator's value, else the fleet default) and `usage` to any member; `PATCH /api/orgs/{org}` takes a `{quota: {...}}` body from the platform administrator's dashboard session only (every API key refused `403 org_forbidden`, an admin-owned one included; a value past its column's bounds refused `400 invalid_input` naming `quota.<field>`); `POST /api/jobs` and the derived doors — `POST /api/jobs/{id}/resume`, `POST /api/jobs/{id}/retry`, `POST /api/trials/{trialId}/retry` — answer `429 quota_exceeded` when the job's trials would cross the owning organization's `max_queued_trials` (`0` = paused).
- Added `GET /api/meta` — public, unauthenticated, `ETag`'d with `Cache-Control: public, max-age=300, stale-while-revalidate=300` and a `304` on a matching `If-None-Match`. It publishes harnesses and their defaults, sandbox providers and their refusals, the network modes, every status enum, the platform limits, and the error vocabulary, each derived from the module that enforces it.
- Added `GET /api/datasets/imports`, `DELETE /api/datasets/[name]` (`409 dataset_in_use` when a job references it, `dataset_not_owned` for a curated one), `PUT /api/agents/[name]`, `GET /api/regrades/[id]` and `GET /api/regrades?jobId=`.
- Managed traces now serve from the database, the same way eval trials do.
- `trial.settled` carries `exception_message` — the failure in its own words, the text the trial's `exception_info.exception_message` holds at settle time — beside `exception_type` on every failure frame; a cancel (`CancelledError`) carries the type alone. `trial.retry_circuit_broken` carries it too.
- `DatasetVersion.source` is a `kind`-discriminated union (`DatasetVersionSource`: `DatasetVersionGitSource` / `DatasetVersionArchiveSource` / `DatasetVersionArchiveUrlSource` / `DatasetVersionHubSource`) served for every publish kind — the locator the publish named plus the identity it resolved to; `null` only when nothing readable was recorded. Previously only git imports carried a `source`.
- FIXED `archive_url` publishes refusing a tarball wrapped in one top-level directory — the shape every GitHub/GitLab archive URL and `tar -czf <dir>` produce. The benchmark-template archive URL failed typed `all_tasks_failed_to_build … benchmark-template-<sha> (missing task.toml)` because the wrapper directory was read as a task; the platform now reads inside a lone wrapper directory, once.

### CLI

- Added `evolve auth org list` — Harbor's `harbor auth org list` with its flag set (`--search`, `--columns`, `-q`, `--no-trunc`, `--no-headers`, `--json`; columns slug, display name, role, created, plus an opt-in personal column — the wire carries no membership date, so a row is dated by the organization's own creation) — and `evolve auth org show <slug>`, the hosted extension: your role, the member count, and every ceiling as `used/limit` beside its live count. A job the owning organization's queue cannot take prints `Launch quota exceeded: hosted quota exceeded: …` and exits 2, as Harbor's CLI does; under `--json` the error envelope rides stdout as well.
- `evolve dataset show` renders the shown version's source for every publish kind — `source: hub:org/name (sha256:…)` for a hub package (the `--from` spelling), `source: https://… (sha256:…)` for a fetched tarball, `source: uploaded archive (sha256:…)` for a directory — beside the git line it already rendered; the versions table's `COMMIT` column became `SOURCE`, carrying each version's resolved commit or digest.
- Added `evolve analysis list` (`--scope`, `--job <id|prefix>`, `--status`), `evolve session list` (`--state live|ended`, `--agent`, `--tag-prefix`), `evolve session show <id>`, and `--scope my|shared` on `evolve job list`; the job-id prefix index walks the scope the verb names. `dataset show` gains a NOTES column plus a `Task notes:` block, and the pre-flight (`dataset check` / `dataset publish`) prints `<task> NOTE <code>: <sentence>`.
- Added `evolve dataset watch <import-id|name>` — re-attach to a running publish and render the same follow `dataset publish --watch` renders (everything from the 202 on), after the CLI exited or from another machine. `dataset publish` over the resumable door prints the import id up front (`Registered import <id> — re-attach anytime...`), and `--watch --json` opens its NDJSON stream with `kind: import.registered`.
- Added `upload.progress` to the `dataset publish --watch --json` NDJSON stream: the CLI's own upload counter — the same 10 %-step cadence human mode prints as `upload M/N (P%)` — now also rides the machine stream as `{kind: "upload.progress", sent_bytes, total_bytes, elapsed_sec}`, at most eleven lines per publish, all before `import.created`, so a piped consumer sees a multi-GB corpus move instead of one line and then silence until the 202 (an 8 GB publish printed nothing for 20 minutes on 2026-09-01). Non-watch `--json` stays one document. Harbor's `harbor upload` renders M-of-N and elapsed in a live terminal display with no machine stream — the event is the recorded deviation (`--json` on every verb).
- Renamed the binary to `evolve`. `evolve-evals` is gone with no alias — pre-launch, it had no external users — and the CLI source moved from `src/hosted/cli.ts` to `src/cli/index.ts` (built to `dist/cli/index.js`). Nothing about the grammar or the flags changed with the name.
- Made `run` a first-class top-level command instead of a spelling rewritten to `job start`. It carries the same flags and the same handler, but `evolve run --help` documents `evolve run`, and a usage error raised inside it names `run` rather than a command the caller never typed.
- Reserved `agents` instead of aliasing it. `job`, `trial` and `dataset` still answer to their plurals; `agents` belongs to the managed-agents CLI shipping after launch, so it refuses by name and points at `evolve agent`.
- Renamed `task-runs` to `trials` and added `--agent harness:model[:version]`, `--max-trial-spend`, and `--status` filtering.
- Added `evolve regrade <id> [trial-id]` (whole-job filters `--status` / `--task`), `evolve regrade-job <id>`, `agents` (`add` / `get` / `remove`), and `--dir` on `import`.

### Documentation And Skills

- Swept both SDK chapters into Harbor's vocabulary and documented the capability document, the error envelope, the paging envelope, the per-trial budget model, the new verbs, upstream version awareness, and the run contract for registered agents.
- Corrected the managed BYO provider key surface: keys can be saved for Anthropic and OpenAI. The seven-provider list is what the gateway can route to, which is a different thing.
- Corrected the network-mode default: a task that declares nothing gets `public`, not `no-network` — which is exactly when the per-trial spend cap stops being a hard boundary.
- Corrected the concurrency default (4) and the Swarm registry model defaults (`opus` for claude, `gpt-5.4` for codex).
- Corrected the `n_concurrent_trials` maximum everywhere it is documented: the chapters said 16, the platform has always enforced 150. A user reading the docs was capping a job at a ninth of the parallelism they were entitled to.
- Moved the API contract out of this repo. `spec/openapi.yaml` now has one canonical home, in the private platform repo, so the two copies can no longer drift apart. The npm package still ships the contract, the released SDKs are unchanged, and the tests that read the spec say SKIP instead of failing when it is absent — set `EVOLVE_OPENAPI_SPEC_PATH` to run them against a local copy.
- Removed the eval-composition primitives from the docs chapters — `task` workspace mode, `prepareSandbox()`, `sealCredentials()`, `collectArtifacts()`, and `externalGateway` — while keeping the table-stakes sandbox options (image, resources, network policy) documented.

## v0.0.52 - 2026-07-22

Published to npm as `@evolvingmachines/sdk@0.0.52` and to PyPI as `evolve-sdk 0.0.52`. The publish workflow owns versioning; a manual bump to `0.0.53` was made and reverted, and no `0.0.53` was ever released.

### Highlights

- Added agent-side eval enablers: `task` workspace mode, provider-neutral sandbox create options with outbound network policy, `prepareSandbox()`, `sealCredentials()`, and `collectArtifacts()`.
- Added sandbox `user`/`homeDir` support (including E2B run-as-root) and the `externalGateway` credential mode for caller-minted, spend-capped, revocable gateway keys.
- Added the hosted evals client — standalone `benchmarks()` and `evaluations()` in TypeScript and Python — and the `evolve-evals` CLI. Both were renamed in the release after this one; see Unreleased.

### SDK

- Added `workspaceMode: "task"`: Evolve leaves the task-owned working directory untouched (no folders, prompt files, or uploads) and rejects conflicting inputs (`context`, `files`, `systemPrompt`, `schema`).
- Added `.withSandboxCreateOptions()` / `sandbox_create_options` for fresh sandbox creation: image, envs, metadata, timeout, working directory, and an outbound network policy (`open`/`blocked` + allowed destinations) that providers must reject when they cannot enforce.
- Added sandbox `user` and `homeDir` options; agent config, skills, session state, and spend-tracking paths now resolve against the configured home. Enforced only on fresh creates; storage and managed browser features require the default `/home/user` home.
- Added `prepareSandbox()` / `prepare_sandbox()` to create and fully initialize the sandbox before any agent command, so orchestrators can persist the sandbox ID first.
- Added `sealCredentials()` / `seal_credentials()`: irreversibly revokes the sandbox's model credential (gateway runtime token, or the caller's `revoke()` in external gateway mode). Fail-closed hardening: sealing throws without a revocable token, on revocation failure, or when the configuration placed other credentials in the sandbox.
- Added `collectArtifacts()` / `collect_artifacts()`: collects declared files/directories only after sealing, with path validation, size/count limits, and loud failures for missing or unreadable roots.
- Added `externalGateway` agent-config mode (TypeScript): caller-minted OpenAI-compatible gateway key injected like a direct-mode key, mutually exclusive with gateway and direct modes, revoked via the caller's `revoke()` on seal; Codex is routed at the external gateway with its wire API pinned.
- Added the hosted evals client: `benchmarks()` (catalog list/get, git-source benchmark import with import polling/watch) and `evaluations()` (run with the six-input contract plus optional per-task-run spend cap, get, list, task runs, single-task-run detail, seq-paged trace, side-by-side compare, cancel, rerun-failed, export incl. Harbor bundle format, Idempotency-Key support). TypeScript `watch()` streams SSE with Last-Event-ID resume and terminal drain; the Python mirror polls.
- Brought the Modal and Daytona sandbox providers to full capability: outbound network-policy enforcement (block-all and allowlists, with typed rejections for ports, IPv6, wildcards, invalid IPv4, and oversized lists), per-provider root/user execution semantics, private-registry image paths (AWS ECR / GCP Artifact Registry via a Modal Secret; Daytona pre-registered Registries), and honest lifecycle limits (Modal's hard 24h cap; Daytona's DNS-pinned IPv4-CIDR allowlist).
- Closed the remaining harness gaps for eval and external-gateway runs: the `claude` harness declares `IS_SANDBOX` so `--dangerously-skip-permissions` works under root, and the `gemini` harness boots with workspace trust and file-based auth settings so it runs headless without the untrusted-workspace refusal.

### CLI

- Added the `evolve-evals` binary to `@evolvingmachines/sdk`: `run` (with `--watch` event streaming), `list`, `get`, `task-runs`, `cancel`, `rerun-failed`, `export` (`--format harbor`), and `benchmarks` catalog commands, with `--json` machine-readable output.
- Added the `evolve-evals import` command: start a git-source benchmark import, poll it to terminal with `--watch`, and inspect one job with `import status <id>`.

### Documentation And Skills

- Added Hosted Evals chapters (TypeScript and Python) covering both clients, the evaluation inputs, status tables, the quickstart, and the CLI.
- Documented sandbox create options, workspace modes, external gateway mode, and the task-sandbox credential lifecycle (capped key → run → seal-revokes → collect-after-seal); synced the Evolve skill references.
- Documented the import → validation lifecycle (imports land at `VALIDATING` and are promoted to `READY` only after validation passes; only `READY` versions accept evaluations), the multi-provider sandbox story (E2B/Daytona/Modal capability parity, selected per evaluation via the optional `sandboxProvider` input / `--provider` CLI flag, default `e2b`), per-harness model constraints, and the eval spend read-back caveat.

## v0.0.51 - 2026-06-30

### Highlights

- Added Dashboard-managed BYO Provider Keys for Claude and Codex gateway sessions.
- Preserved Direct Provider Key Mode for local BYOK users.
- Published TypeScript and Python packages at `0.0.51`.

### SDK

- Managed BYO provider keys: your raw provider key and `EVOLVE_API_KEY` never enter the sandbox for that provider route; credentials are short-lived and revoked when the sandbox ends.
- Keeps the existing gateway fallback path when managed provider keys are disabled or unavailable.

### Documentation And Skills

- Clarified the two BYO paths: Managed BYO Provider Keys vs Direct Provider Key Mode.
- Synced TypeScript, Python, and Evolve skill references for the updated authentication model.

## v0.0.50 - 2026-06-15

### Highlights

- Updated the Kimi agent integration from legacy `kimi-cli` assumptions to Kimi Code.
- Published TypeScript and Python packages at `0.0.50`.

### SDK

- Installed Kimi Code in the Docker and E2B runtime templates and switched SDK-managed Kimi files to `~/.kimi-code`.
- Added Kimi Code TOML config generation for provider, model, thinking, MCP, and spend tracking setup while preserving a narrow legacy fallback for old sandboxes.
- Updated Kimi stream parsing for Kimi Code `stream-json` assistant messages and tool calls.
- Mapped SDK thinking/no-thinking setup to Kimi Code thinking mode configuration.
- Kept checkpoint archives from capturing Kimi Code config secrets.

### Documentation And Skills

- Updated public docs and mirrored Evolve skill references for Kimi Code naming, config paths, and CLI behavior.

## v0.0.49 - 2026-06-09

### Highlights

- Fixed gateway-mode sandbox creation on fresh installs with the latest upstream `e2b` client.
- Published TypeScript and Python packages at `0.0.49`.

### SDK

- Wrapped the Evolve gateway key as an `e2b`-shaped key for the managed E2B route, satisfying the upstream `e2b` client's new API-key format validation. BYOK E2B usage is unchanged.

## v0.0.48 - 2026-06-09

### Highlights

- Added Claude Fable 5 model support for Claude Code via `model: "fable"` / `model='fable'`.
- Added Claude Fable 5 via OpenCode/OpenRouter as `openrouter/anthropic/claude-fable-5`.
- Published TypeScript and Python packages at `0.0.48`.

### SDK

- Added `fable -> claude-fable-5` to the Claude model registry while keeping Claude's default model as `opus`.
- Added `openrouter/anthropic/claude-fable-5` to the OpenCode model registry.

### Documentation And Skills

- Updated TypeScript and Python Agent Reference tables and examples for Claude Fable 5.
- Synced Evolve skill reference docs from the updated public docs.

## v0.0.47 - 2026-06-09

### Highlights

- Added first-class managed browser profile support for reusable authenticated browser state.
- Added `.withBrowser({ profile: "..." })` in TypeScript for managed remote `agent-browser` runs.
- Added browser profile clients for TypeScript and Python so users can list and delete reusable browser profiles from the SDK.
- Published TypeScript and Python packages at `0.0.47`.

### SDK

- Added `Evolve.browserProfiles().list()` and `Evolve.browserProfiles().delete({ profile })` in TypeScript.
- Added Python browser profile helpers via `evolve.browser_profiles`.
- Enforced that browser profiles are available only in managed remote browser mode.
- Kept browser profile metadata scoped to the authenticated Evolve user and free of provider internals.

### Documentation And Skills

- Documented managed browser profile usage in the TypeScript and Python browser automation sections.
- Synced Evolve skill reference docs from the updated public docs.

## v0.0.46 - 2026-06-04

### Highlights

- Added Droid reasoning parsing for `droid exec --output-format stream-json` `reasoning` events.
- Kept Droid `stream-jsonrpc` `thinking_text_delta` parsing aligned with the Factory SDK protocol.
- Published TypeScript and Python packages at `0.0.46`.

### Fixes

- Deduplicated consecutive identical Droid reasoning chunks so dashboard traces do not show duplicate Thinking blocks when Droid emits the same raw reasoning event twice.
- Updated Claude agent docs to show `opus` as the default in both Gateway and BYOK modes.
- Synced the Evolve skill reference docs with the public docs.
- Refreshed `package-lock.json` after the release dependency bump to `0.0.46`.

### Notes

- Droid reasoning dedupe only drops exact consecutive duplicate thought chunks; distinct thinking chunks and later repeated thoughts still pass through.

## v0.0.45 - 2026-06-03

### Highlights

- Added the `kimi-k2.6-turbo` gateway-mode Kimi model.
- Kept the managed gateway route and public SDK model name aligned as `kimi-k2.6-turbo`.
- Published TypeScript and Python packages at `0.0.45`.

### Fixes

- Removed the stale non-turbo Kimi SDK/docs alias.

### Notes

- Use `kimi-k2.6-turbo` with `EVOLVE_API_KEY` in gateway mode.

## v0.0.42 - 2026-06-03

### Highlights

- Added managed integrations in gateway mode with `withIntegrations()` / `IntegrationsSetup`.
- Added SDK helpers for auth links and account management: `Evolve.integrations.auth()`, `accounts.list()`, `accounts.update()`, and `accounts.delete()`.
- Agents now receive an Evolve-scoped MCP proxy for integration tools; provider credentials stay server-side.
- Added app, tool, account, custom auth config, and API-key filters for integration runs.
- Renamed the old Composio-specific docs/cookbooks to generic managed integrations.

### Fixes

- Gateway setup again uses `EVOLVE_API_KEY` directly, matching pre-release behavior.

### Available Apps

- `gmail` - Gmail.
- `agent_mail` - Agent Mail.
- `slack` - Slack.
- `github` - GitHub.
- `googlecalendar` - Google Calendar.
- `notion` - Notion.
- `linear` - Linear.

### Breaking Changes

- Removed the old Composio-specific SDK modules and public naming.
- Use `withIntegrations(...)` and `Evolve.integrations...` instead of any previous Composio-specific setup.
- Managed integrations require gateway mode with `EVOLVE_API_KEY`.

## v0.0.40 - 2026-05-28

### Highlights

- Added managed browser credentials for remote `agent-browser` runs.
- Added `.withBrowserCredentials()` to attach a run-scoped `browser-login` MCP server.
- Added browser credential clients for TypeScript and Python so users can create, list, and delete saved browser logins without exposing passwords.
- Published TypeScript and Python packages at `0.0.40`.

### Browser Login Tools

- `browser_list_logins` returns available website/account-label/email metadata only.
- `browser_login` fills and submits a saved password login on the current sign-in tab without returning the password.
- `browser_complete_signup` completes password-based signup after the agent fills non-secret fields, then saves the generated login for future runs.

### Dashboard

- Added a Secrets page for browser credentials.
- Encrypted stored passwords; they are never returned to the agent.
- Fixed trace analytics rendering when spend data is not available yet.

### Documentation And Skills

- Documented browser credential setup for TypeScript and Python.
- Synced Evolve skill references from the updated docs.

### Notes

- Browser credentials require Gateway mode and managed remote `agent-browser`.
- Passwords are never returned to the agent by the browser-login tools.

## v0.0.39 - 2026-05-25

### Highlights

- Changed `.withBrowser()` to default to remote managed `agent-browser` for browser automation.
- Kept explicit provider overrides available for users that need a different browser backend.
- Published TypeScript and Python packages at `0.0.39`.

### Documentation And Skills

- Consolidated browser automation guidance around the default `.withBrowser()` path.
- Clarified `remote: true` as the Evolve-managed cloud browser mode with dashboard live view and replay.
- Documented browser replay metadata fields: `suggestedStartSeconds`, `sizeBytes`, and `readyAt` in TypeScript, plus Python equivalents.
- Synced Evolve skill references from the updated docs.

### Notes

- Existing code that passes an explicit browser provider is unchanged.
- Code that calls `.withBrowser()` with no arguments now uses the recommended managed `agent-browser` path by default.

## v0.0.38 - 2026-05-24

### Highlights

- Added managed browser replay support for remote managed browser sessions.
- Added `sessions().browserReplay()` in TypeScript and `sessions().browser_replay()` in Python to wait for replay readiness and return Dashboard-owned replay/download URLs.
- Exposed managed browser runtime metadata on lifecycle events and run results, including live view URL, dashboard session ID, and browser session tag.
- Added replay metadata fields such as `suggestedStartSeconds`, `sizeBytes`, and `readyAt`.
- Updated TypeScript and Python sessions clients so historical traces, parsed events, trace downloads, and browser replays share the same gateway-authenticated API surface.
- Updated Composio core dependency.

### Documentation And Skills

- Documented browser replay usage in TypeScript and Python runtime docs.
- Clarified remote managed browser live-view handling in TypeScript and Python streaming docs.
- Synced Evolve skill references from the updated docs.

### Tests

- Added TypeScript sessions-client coverage for browser replay polling and downloads.
- Added Python sessions-client API coverage for browser replay metadata.
- Updated browser config and session runtime coverage for managed browser metadata.

## v0.0.37 - 2026-05-22

### Highlights

- Added remote managed `agent-browser` as the recommended browser automation path.
- Updated browser automation config around `remote: true`, with `.withBrowser()` defaulting to remote managed browser automation in TypeScript.
- Added immediate browser live-view metadata for remote managed browser runs.
- Routed managed E2B sandbox operations through Dashboard-managed APIs in Gateway mode.
- Added E2B `apiUrl` support for managed gateway routing.
- Added Gemini 3.5 Flash models and fixed Gemini gateway passthrough routing.
- Improved sandbox/browser reliability by detaching the browser daemon in Docker and E2B assets.

### Documentation And Skills

- Refreshed browser automation docs for TypeScript, Python, streaming, and skill references.
- Refreshed the `agent-browser` skill.
- Clarified remote managed browser lifecycle events.

### Tests

- Expanded TypeScript auth, browser config, and session runtime coverage.
- Added Python auth config coverage for the managed provider routing path.
