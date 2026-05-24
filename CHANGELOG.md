# Changelog

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
