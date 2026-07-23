# Changelog

## v0.0.53 - 2026-07-22

### Highlights

- Added agent-side eval enablers: `task` workspace mode, provider-neutral sandbox create options with outbound network policy, `prepareSandbox()`, `sealCredentials()`, and `collectArtifacts()`.
- Added sandbox `user`/`homeDir` support (including E2B run-as-root) and the `externalGateway` credential mode for caller-minted, spend-capped, revocable gateway keys.
- Added the hosted evals client — standalone `benchmarks()` and `evaluations()` in TypeScript and Python — and the `evolve-evals` CLI.
- Bumped the TypeScript package to `0.0.53`.

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
