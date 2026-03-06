# Sessions Client Design

**Date**: 2026-03-05
**Branch**: `feat/sessions-client`
**Status**: Approved

## Problem

The SDK can query cost and manage checkpoints for the *current* session, but users cannot programmatically list past sessions, download traces, or inspect historical session data. The dashboard has all this data but its list/events endpoints only accept NextAuth (browser) auth, not API key auth.

A user requested an SDK API to download full agent traces from past sessions, including ended ones.

## Design Decisions

1. **Standalone `sessions()` factory** — parallel to `storage()`, not an extension of it.
   - `storage()` owns checkpoints (tar.gz archives of workspace state)
   - `sessions()` owns remote trace history (JSONL event streams, metadata, cost)
   - `evolve.status()` remains live runtime only

2. **Gateway-only** — remote traces live in the dashboard/session store. In direct/BYOK mode, traces are only local files under `~/.evolve/observability/sessions/`, not a durable indexed service. Mixing those would be incoherent.

3. **No speculative methods** — no `downloadAll()`, no `latest()`, no historical `status()` API.
   - "Last one" is `list({ limit: 1 })`
   - "Download all" is paging + loop
   - Historical status is a field on each session

4. **Separate download from events** — `events()` returns parsed JSON (like the dashboard trace viewer), `download()` streams raw JSONL (for bulk export). Different performance profiles, different use cases.

## TypeScript API

```ts
import { sessions } from "@evolvingmachines/sdk";

const s = sessions();   // uses EVOLVE_API_KEY from env

// List sessions
const page = await s.list({ limit: 20, state: "ended" });

// Get single session
const meta = await s.get(page.items[0].id);

// Get parsed events
const events = await s.events(page.items[0].id);

// Download raw JSONL file
const filePath = await s.download(page.items[0].id, { to: "./traces" });
```

### Factory

```ts
function sessions(config?: { apiKey?: string }): SessionsClient
```

- `apiKey` defaults to `process.env.EVOLVE_API_KEY`
- Throws if no API key (gateway-only)

### SessionsClient

```ts
interface SessionsClient {
  list(options?: ListSessionsOptions): Promise<SessionPage>
  get(id: string): Promise<SessionInfo>
  events(id: string, options?: { since?: number }): Promise<SessionEvent[]>
  download(id: string, options?: { to?: string }): Promise<string>
}
```

### Types

```ts
interface ListSessionsOptions {
  limit?: number              // default 20, max 200
  cursor?: string             // cursor-based pagination
  state?: "live" | "ended" | "all"  // default "all"
  agent?: string              // filter by agent type
  tagPrefix?: string          // filter by tag prefix
  sort?: "newest" | "oldest" | "cost"  // default "newest"
}

interface SessionPage {
  items: SessionInfo[]
  nextCursor: string | null
  hasMore: boolean
}

interface SessionInfo {
  id: string
  tag: string
  agent: string
  model: string | null
  provider: string
  sandboxId: string | null
  state: "live" | "ended"
  runtimeStatus: "alive" | "dead" | "unknown"
  cost: number | null
  createdAt: string           // ISO 8601
  endedAt: string | null      // ISO 8601
  stepCount: number
  toolStats: Record<string, number> | null
}

// Raw parsed JSONL objects — no imposed schema
type SessionEvent = Record<string, unknown>
```

### Field Semantics

- **`state`**: Computed from `isEnded` — ergonomic SDK field (`isEnded ? "ended" : "live"`)
- **`runtimeStatus`**: Preserved from dashboard (`"alive" | "dead" | "unknown"`) — important truth the backend tracks
- **`cost`**: `null` when not synced yet. Eventually consistent for recently ended sessions. For live sessions, current accumulated total, not final.

## Python API

```python
from evolve import sessions

s = sessions()  # uses EVOLVE_API_KEY from env

page = await s.list(limit=20, state="ended")
meta = await s.get(page.items[0].id)
events = await s.events(page.items[0].id)
path = await s.download(page.items[0].id, to="./traces")
```

Python mirrors TypeScript 1:1 via the JSON-RPC bridge, following the existing pattern for `storage()`.

## Dashboard Backend Changes

The dashboard needs narrow changes — no schema rethink, no new data model.

### 1. Add API key auth to `GET /api/sessions` (list)

Currently NextAuth only (`getServerSession`). Add a second auth path: if `Authorization: Bearer` header present, use `verifyApiKey()` from `lib/auth-api-key.ts` (same pattern as `/ingest` and `/spend`).

### 2. Add API key auth to `GET /api/sessions/[id]/events` (parsed events)

Same dual-auth approach. Scope results to sessions owned by the API key's user.

### 3. New route: `GET /api/sessions/[id]/download` (raw JSONL stream)

The existing events route reads the entire file into memory (50MB cap), parses it, returns JSON. That's fine for the trace viewer but wrong for bulk export.

New endpoint that either:
- **(Preferred)** Generates an S3 presigned URL and redirects (302) — offloads bandwidth from ECS
- **(Fallback)** Streams the S3 object through with `Transfer-Encoding: chunked`

Auth: API key (Bearer token). Scoped to user's own sessions.

### 4. No new routes for list or get

`list` reuses the existing `GET /api/sessions` with API key auth added.
`get` reuses `GET /api/sessions` with `?id=X` filter, or we add a simple `GET /api/sessions/[id]` route (the `[id]` folder already exists for events/costs/stop).

## SDK Implementation

### File Layout

```
packages/sdk-ts/src/
  sessions/
    index.ts        # SessionsClient class + sessions() factory
    types.ts        # SessionInfo, SessionPage, ListSessionsOptions, SessionEvent
  index.ts          # Add: export { sessions, SessionsClient, ... }
```

### Implementation Notes

- `sessions()` factory resolves API key from config or `EVOLVE_API_KEY` env var
- All methods call `fetch()` against `DEFAULT_DASHBOARD_URL` (same as session-logger.ts)
- Auth: `Authorization: Bearer {apiKey}` header
- `list()`: `GET /api/sessions?paginationMode=cursor&pageSize={limit}&cursor={cursor}&...`
- `get()`: `GET /api/sessions/{id}`
- `events()`: `GET /api/sessions/{id}/events?since={since}`
- `download()`: `GET /api/sessions/{id}/download` → follow redirect to presigned URL → write to disk

### Python Bridge

Add `sessions` command to the JSON-RPC bridge protocol. Python `SessionsClient` class sends `sessions.list`, `sessions.get`, `sessions.events`, `sessions.download` messages, same pattern as `StorageClient`.

## Non-Goals

- No `downloadAll()` or `latest()` convenience methods
- No local/BYOK trace reading (gateway-only)
- No historical status API beyond `runtimeStatus` field on `SessionInfo`
- No schema changes to the dashboard database
- No changes to the ingest pipeline
