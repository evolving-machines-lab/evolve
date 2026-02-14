# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.0.24] - 2025-02-14

### Added

- **Daytona `snapshotName` config** — custom snapshot support via `DaytonaProvider({ snapshotName })` (Python: `DaytonaProvider(snapshot_name=...)`)
- **Modal `imageName` config** — custom image support via `ModalProvider({ imageName })` (Python: `ModalProvider(image_name=...)`)
- **Modal eager image build** — `images.fromRegistry().build(app)` called upfront so first-run image pull is cached (~150ms subsequent)
- **Provider parity test** — compile-time + runtime verification that all sandbox providers (E2B, Daytona, Modal) implement the same `SandboxProvider` API surface
- **`evolve-dev` skill** — install/update instructions, git clone for first-time setup, model freshness warning

### Fixed

- **Daytona snapshot creation now blocking** — first run creates a named snapshot from Docker image, then creates sandbox from it. Previous behavior could race between snapshot creation and sandbox use
- **Docker image tags** — stripped `:latest` from `evolve-all` image references across Daytona and Modal (registries default to latest, explicit tag can cause pull issues)
- **Python bridge I/O timeouts** — `initialize`, `upload_context`, `upload_files`, `get_output_files`, `checkpoint`, `list_checkpoints` now use sandbox-scaled timeout instead of default 60s (fixes timeouts on slow sandbox operations)
- **Workspace-compatible dependency ranges** — provider packages (`@evolvingmachines/e2b`, `daytona`, `modal`) now use `*` range in SDK package.json for monorepo compatibility

### Documentation

- Updated TypeScript and Python SDK docs with new provider config options
- Added `snapshot_name` to Python `DaytonaProvider` docs

## [0.0.23] - 2025-02-13

### Added

- **Kimi CLI agent support** (`type: "kimi"`)
  - Parser for Kosong Messages format (`--print --output-format stream-json`)
  - Wire Protocol fallback for future compatibility
  - Models: `moonshot/kimi-k2.5`, `moonshot/kimi-k2-turbo-preview`
  - MCP config at `~/.kimi/mcp.json`

- **OpenCode agent support** (`type: "opencode"`)
  - Parser for JSONL stream format (`--format json`)
  - Multi-provider model routing (`openai/`, `anthropic/`, `google/` prefixes)
  - Models: `openai/gpt-5.2`, `anthropic/claude-sonnet-4-5`, `anthropic/claude-opus-4-6`, `google/gemini-3-pro-preview`
  - MCP config at `./opencode.json` (project-level)

- **`checkpointDirs` registry field** for agents with non-standard state directories
  - OpenCode uses XDG Base Directory spec: `~/.local/share/opencode/`, `~/.config/opencode/`, `~/.local/state/opencode/`
  - `buildTarCommand()` includes all checkpoint dirs in tar archive

- **Python SDK type surface** updated with `'kimi'` and `'opencode'` in `AgentType` literal

### Fixed

- **OpenCode multi-provider BYOK env resolution** — `resolveAgentConfig()` now checks `providerEnvMap` (model-specific key) before generic `apiKeyEnv`, so `anthropic/...` models resolve to `ANTHROPIC_API_KEY` instead of incorrectly using `OPENAI_API_KEY`
- **Kimi parser Kosong format** — rewrote from Wire Protocol to actual Kosong Messages format (role-based `assistant`/`tool` messages with content arrays)
- **Kimi single-TextPart serialization** — handle Kosong edge case where single TextPart is serialized as plain string instead of array

## [0.0.22] - 2025-02-10

### Added

- **Storage & Checkpointing** (BYOK + Gateway modes)
  - `kit.withStorage({ url: "s3://..." })` for BYOK S3-compatible storage
  - Gateway mode via `EVOLVE_API_KEY` (Evolve-managed storage)
  - Auto-checkpoint after every successful `run()`
  - Content-addressed dedup (SHA-256 hash, skip upload on match)
  - Restore via `kit.run({ from: checkpointId })` or `from: "latest"`
  - Explicit save points via `kit.checkpoint({ comment })`
  - `kit.listCheckpoints({ limit, tag })` for checkpoint discovery
  - Standalone `listCheckpoints(storageConfig)` without Evolve instance
  - Lineage tracking with `parentId` across runs and restores

- **Python SDK parity** for all storage/checkpointing features

### Fixed

- BYOK restore error differentiation (not-found vs network errors)
- `s3ListCheckpoints` limit+tag ordering bug
- Path traversal protection in `normalizeAgentDir()` and `normalizeWorkspaceDir()`
- Daytona provider reliability and cross-provider test isolation

## [0.0.21] - 2025-02-06

### Added

- **TypeScript SDK session runtime control plane**
  - `status()` runtime snapshot API with sandbox/agent state, activeProcessId, hasRun, timestamp
  - `interrupt()` to stop active processes without killing the sandbox
  - `lifecycle` event stream with typed `LifecycleEvent` / `LifecycleReason`
  - Runtime guards for concurrent operation rejection

- **Python SDK parity for session runtime control plane**
  - Async `status()` and `interrupt()` APIs
  - Lifecycle event forwarding through Python bridge

### Changed

- **Provider coherence (Daytona / Modal)**
  - `image` defaults to `"evolve-all"` for parity with E2B
  - Daytona `connect()` now starts stopped sandboxes
  - Daytona timeout/interruption behavior aligned with SDK expectations

### Fixed

- Claude `model="opus"` gateway routing (temporary `anthropic/` prefix)
- Qwen Code `--auth-type openai` for non-interactive mode

## [0.0.14] - 2025-01-28

### Fixed

- **Claude parser: include Bash/Edit/Write tool results** - Previously discarded successful output for these tools, only showing content on errors. Now all tool results are included in `tool_call_update` events, consistent with Codex/Gemini/Qwen parsers. Fixes empty result display in dashboard trace viewer.

## [0.0.12] - 2025-01-28

### Fixed

- **ModalProvider inside Modal containers** ([#8](https://github.com/evolving-machines-lab/evolve/issues/8))
  - Added `EVOLVE_MODAL_TOKEN_ID` / `EVOLVE_MODAL_TOKEN_SECRET` env var support
  - Modal strips `MODAL_TOKEN_*` inside containers for security; use `EVOLVE_MODAL_TOKEN_*` via Modal Secrets
  - Added `tokenId` / `tokenSecret` to `ModalConfig` for programmatic credential passing

## [0.0.11] - 2025-01-28

### Added

- **Codex OAuth support** - File-based OAuth using `CODEX_OAUTH_FILE_PATH=~/.codex/auth.json`
- **Gemini OAuth support** - File-based OAuth using `GEMINI_OAUTH_FILE_PATH=~/.gemini/oauth_creds.json`
  - Automatically sets `GOOGLE_GENAI_USE_GCA=true` activation env var
- Registry-driven OAuth architecture with new fields:
  - `oauthFileName` - credentials file name (e.g., `auth.json`, `oauth_creds.json`)
  - `oauthActivationEnv` - optional env var to activate OAuth mode

## [0.0.7] - 2025-01-27

### Added

- **Daytona sandbox provider** (`@evolvingmachines/daytona`)
  - Full API parity with E2B provider
  - Snapshot caching with Docker image fallback
  - Resource configuration (CPU, memory, disk)
  - Auto-resolution from `DAYTONA_API_KEY` environment variable

- **Modal sandbox provider** (`@evolvingmachines/modal`)
  - GPU-enabled cloud sandboxes
  - User switching for Claude CLI compatibility (`su user -c` with base64 encoding)
  - Batch file uploads via tar streaming
  - Auto-resolution from `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` environment variables

- **Python SDK support for all providers**
  - `DaytonaProvider` and `ModalProvider` classes
  - Updated bridge to support all three providers

- **Provider auto-resolution priority**
  1. `E2B_API_KEY` → E2B direct
  2. `DAYTONA_API_KEY` → Daytona direct
  3. `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` → Modal direct
  4. `EVOLVE_API_KEY` → Gateway fallback

### Changed

- Renamed `templateId` to `image` in sandbox interfaces (provider-agnostic)
- Renamed `pid` to `processId` in process handles (string IDs for Modal compatibility)
- `getHost()` now returns `Promise<string>` (async for Daytona/Modal)
- Aligned all provider packages to identical structure (package.json, tsup.config.ts, LICENSE, README)

### Fixed

- **Modal default resources**: Now sets 4 CPU, 4GB memory at sandbox creation (matches E2B defaults)
- Bridge `types.ts` now correctly includes all provider types (was only `'e2b'`)
- **Daytona sandbox timeout**: Now correctly maps `defaultTimeoutMs` to inactivity-based `autoStopInterval` (in minutes, min 1 minute) for parity with E2B/Modal fixed-lifetime behavior
- **Modal operation timeout**: Properly detects timeout via `exitCode === -1` (Modal returns -1 instead of throwing like E2B)
- **Integration test 17**: Handles different timeout semantics across all 3 providers (all now pass 14/14 checks)

### Documentation

- Added Modal and Daytona providers to Python SDK docs (was E2B only)
- Added missing provider config options: Modal `appName`, Daytona `apiUrl`/`target`
- Clarified that `.withSandbox()`/`sandbox=` is optional when env vars are set (SDK auto-resolves)
- Added First Time Setup column to provider table with links to `assets/README.md`
- Added Auto-Resolution section with env examples for all providers
