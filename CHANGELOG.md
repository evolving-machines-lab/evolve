# Changelog

## v0.0.42 - 2026-06-03

### Highlights

- Added managed integrations in gateway mode with `withIntegrations()` / `IntegrationsSetup`.
- Added SDK helpers for auth links and account management: `Evolve.integrations.auth()`, `accounts.list()`, `accounts.update()`, and `accounts.delete()`.
- Agents now receive an Evolve-scoped MCP proxy for integration tools; provider credentials stay server-side.
- Added app, tool, account, custom auth config, and API-key filters for integration runs.
- Renamed the old Composio-specific docs/cookbooks to generic managed integrations.

### Fixes

- Removed the sandbox-scoped runtime gateway key flow from the SDK and Dashboard.
- Restored the pre-release `EVOLVE_API_KEY` gateway behavior for sandbox/runtime setup.

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
- Added encrypted password storage, browser-auth runtime, and run-scoped MCP grant tokens.
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
