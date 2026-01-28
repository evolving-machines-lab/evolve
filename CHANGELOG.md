# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
