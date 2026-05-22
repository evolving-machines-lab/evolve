# Changelog

## v0.0.37 - 2026-05-22

### Highlights

- Added remote managed `agent-browser` as a browser automation option alongside Actionbook.
- Updated browser automation config around `remote: true`, with `.withBrowser()` still defaulting to remote managed Actionbook in TypeScript.
- Added immediate browser live-view metadata for remote managed Actionbook and agent-browser runs.
- Routed managed E2B sandbox operations through Dashboard-managed APIs in Gateway mode.
- Added E2B `apiUrl` support for managed gateway routing.
- Added Gemini 3.5 Flash models and fixed Gemini gateway passthrough routing.
- Improved sandbox/browser reliability by detaching the Actionbook daemon in Docker and E2B assets.

### Documentation And Skills

- Refreshed browser automation docs for TypeScript, Python, streaming, and skill references.
- Refreshed the `agent-browser` skill.
- Clarified browser-use MCP parsing separately from remote managed browser lifecycle events.

### Tests

- Expanded TypeScript auth, browser config, and session runtime coverage.
- Added Python auth config coverage for the managed provider routing path.
