# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.4] - 2025-01-27

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

- Bridge `types.ts` now correctly includes all provider types (was only `'e2b'`)
