# Sessions Client Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a `sessions()` factory to the Evolve SDK that lets users list, inspect, and download traces from past agent sessions via the dashboard API.

**Architecture:** Gateway-only `SessionsClient` that calls dashboard REST endpoints with API key auth. Dashboard needs dual-auth (NextAuth + API key) on existing routes plus one new download route. SDK types in `sessions/types.ts`, client in `sessions/index.ts`, exports from `index.ts`.

**Tech Stack:** TypeScript SDK (fetch), Next.js API routes (dashboard), Python bridge (JSON-RPC), S3 presigned URLs

**Design doc:** `docs/plans/2026-03-05-sessions-client-design.md`

---

## Task 1: Dashboard — Dual auth helper

Extract a reusable dual-auth function so routes can accept either NextAuth session or API key.

**Files:**
- Create: `swarm_dashboard/lib/auth-dual.ts`

**Step 1: Write the dual-auth helper**

```ts
// swarm_dashboard/lib/auth-dual.ts
import { NextRequest } from 'next/server'
import { getServerSession } from 'next-auth'
import { authOptions } from '@/lib/auth'
import { extractBearerToken, verifyApiKey } from '@/lib/auth-api-key'

export interface AuthResult {
  userId: string
  isAdmin: boolean
  source: 'session' | 'apikey'
}

/**
 * Authenticate via NextAuth session OR Bearer API key.
 * Returns null if neither succeeds.
 */
export async function authenticateRequest(request: NextRequest): Promise<AuthResult | null> {
  // Try API key first (cheaper — in-memory cache)
  const token = extractBearerToken(request)
  if (token) {
    const userId = await verifyApiKey(token)
    if (userId) return { userId, isAdmin: false, source: 'apikey' }
    return null // explicit Bearer token but invalid — fail fast
  }

  // Fall back to NextAuth session
  const session = await getServerSession(authOptions)
  if (session?.user?.id) {
    return {
      userId: session.user.id,
      isAdmin: session.user.role === 'ADMIN',
      source: 'session',
    }
  }
  return null
}
```

**Step 2: Commit**

```bash
cd /Users/ildebrandomagnani/SWARMAPP/swarm_dashboard
git add lib/auth-dual.ts
git commit -m "feat: dual auth helper for NextAuth + API key routes"
```

---

## Task 2: Dashboard — Add API key auth to GET /api/sessions (list)

Replace the NextAuth-only auth in the sessions list route with the dual-auth helper. API key users get their own sessions only (no admin mode).

**Files:**
- Modify: `swarm_dashboard/app/api/sessions/route.ts:138-170`

**Step 1: Update the GET handler auth block**

Replace lines 138-170 (the auth + rate limit block) with:

```ts
// At top of file, add import:
import { authenticateRequest } from '@/lib/auth-dual'

// In GET handler, replace getServerSession block:
export async function GET(request: NextRequest) {
  try {
    const auth = await authenticateRequest(request)
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const rateLimit = await rateLimiter.check(
      `api:sessions:${auth.userId}`,
      RateLimits.API.limit,
      RateLimits.API.windowMs
    )
    if (!rateLimit.allowed) {
      const resetDate = new Date(rateLimit.resetTime)
      return NextResponse.json(
        { error: 'Rate limit exceeded', resetAt: resetDate.toISOString() },
        { status: 429, headers: { 'X-RateLimit-Limit': RateLimits.API.limit.toString(), 'X-RateLimit-Remaining': '0', 'X-RateLimit-Reset': resetDate.toISOString() } }
      )
    }

    const searchParams = request.nextUrl.searchParams
    const isAdminRequest = searchParams.get('admin') === 'true'

    // API key users cannot use admin mode
    if (isAdminRequest) {
      if (auth.source === 'apikey') {
        return NextResponse.json({ error: 'Admin mode not available via API key' }, { status: 403 })
      }
      if (!auth.isAdmin) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
      }
      // ... rest of admin block unchanged
```

Also replace all `session.user.id` references with `auth.userId` and `session.user.role` with `auth.isAdmin`.

**Step 2: Add SDK-friendly query params**

In the non-admin cursor pagination block (around line 314), add support for `state` and `agent` filters that map to Prisma `where`:

```ts
// After existing where construction:
const stateFilter = searchParams.get('state')
if (stateFilter === 'live') where.isEnded = false
else if (stateFilter === 'ended') where.isEnded = true

const agentFilter = searchParams.get('agent')
if (agentFilter) where.agent = agentFilter

const tagPrefixFilter = searchParams.get('tagPrefix')
if (tagPrefixFilter) where.tag = { startsWith: tagPrefixFilter }
```

**Step 3: Build and verify**

```bash
cd /Users/ildebrandomagnani/SWARMAPP/swarm_dashboard
npm run build
```

**Step 4: Commit**

```bash
git add app/api/sessions/route.ts
git commit -m "feat: add API key auth and SDK filters to sessions list endpoint"
```

---

## Task 3: Dashboard — Add GET /api/sessions/[id] (single session)

The `[id]` folder exists but only has DELETE and sub-routes. Add a GET handler for single session metadata.

**Files:**
- Modify: `swarm_dashboard/app/api/sessions/[id]/route.ts`

**Step 1: Add GET handler**

Add to the existing file (which only has DELETE):

```ts
import { authenticateRequest } from '@/lib/auth-dual'
import { resolveSessionRuntimeStatus } from '@/lib/session-runtime'

// GET /api/sessions/[id] - Get single session metadata
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await authenticateRequest(request)
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const rateLimit = await rateLimiter.check(
      `api:sessions:${auth.userId}`,
      RateLimits.API.limit,
      RateLimits.API.windowMs
    )
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { error: 'Rate limit exceeded' },
        { status: 429 }
      )
    }

    const { id } = await params
    const where: any = { id }
    if (!auth.isAdmin) where.userId = auth.userId

    const session = await prisma.session.findFirst({ where })
    if (!session) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    return NextResponse.json({
      ...session,
      runtimeStatus: resolveSessionRuntimeStatus(session.runtimeStatus, session.isEnded),
    }, {
      headers: { 'Cache-Control': 'private, max-age=15' }
    })
  } catch (error) {
    console.error('Error fetching session:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

**Step 2: Build and verify**

```bash
npm run build
```

**Step 3: Commit**

```bash
git add app/api/sessions/[id]/route.ts
git commit -m "feat: add GET /api/sessions/[id] with dual auth"
```

---

## Task 4: Dashboard — Add API key auth to GET /api/sessions/[id]/events

**Files:**
- Modify: `swarm_dashboard/app/api/sessions/[id]/events/route.ts:13-29`

**Step 1: Replace auth block with dual auth**

Replace the NextAuth-only auth at lines 13-29 with the dual-auth pattern (same as Task 2). Replace `session.user.id` with `auth.userId`, and scope the session ownership check:

```ts
import { authenticateRequest } from '@/lib/auth-dual'

// In GET handler:
const auth = await authenticateRequest(request)
if (!auth) {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

// ... rate limit using auth.userId ...

// Session ownership: non-admin users can only see their own
const where: any = { id: sessionId }
if (!auth.isAdmin) where.userId = auth.userId
const dbSession = await prisma.session.findFirst({ where })
```

**Step 2: Build and verify**

```bash
npm run build
```

**Step 3: Commit**

```bash
git add app/api/sessions/[id]/events/route.ts
git commit -m "feat: add API key auth to session events endpoint"
```

---

## Task 5: Dashboard — New GET /api/sessions/[id]/download route

Presigned URL redirect for raw JSONL download. No memory buffering, no parsing.

**Files:**
- Create: `swarm_dashboard/app/api/sessions/[id]/download/route.ts`

**Step 1: Write the download route**

```ts
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { s3Client, S3_BUCKET, STORAGE_MODE } from '@/lib/s3'
import { readFile } from 'fs/promises'
import { authenticateRequest } from '@/lib/auth-dual'
import rateLimiter, { RateLimits } from '@/lib/rate-limit'

export const dynamic = 'force-dynamic'

// GET /api/sessions/[id]/download — raw JSONL download
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = await authenticateRequest(request)
    if (!auth) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const rateLimit = await rateLimiter.check(
      `api:sessions-download:${auth.userId}`,
      RateLimits.API.limit,
      RateLimits.API.windowMs
    )
    if (!rateLimit.allowed) {
      return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 })
    }

    const { id } = await params
    const where: any = { id }
    if (!auth.isAdmin) where.userId = auth.userId

    const session = await prisma.session.findFirst({
      where,
      select: { id: true, tag: true, filePath: true },
    })
    if (!session) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }
    if (!session.filePath) {
      return NextResponse.json({ error: 'No trace file' }, { status: 404 })
    }

    // S3 mode: presigned URL redirect
    if (session.filePath.startsWith('s3://') && s3Client) {
      const s3Key = session.filePath.replace(`s3://${S3_BUCKET}/`, '')
      const command = new GetObjectCommand({ Bucket: S3_BUCKET, Key: s3Key })
      const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 })
      return NextResponse.redirect(url, 302)
    }

    // Local mode: stream file
    const content = await readFile(session.filePath, 'utf-8')
    return new NextResponse(content, {
      headers: {
        'Content-Type': 'application/x-ndjson',
        'Content-Disposition': `attachment; filename="${session.tag}.jsonl"`,
      },
    })
  } catch (error) {
    console.error('Error downloading session:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
```

**Step 2: Build and verify**

```bash
npm run build
```

**Step 3: Commit**

```bash
git add app/api/sessions/[id]/download/route.ts
git commit -m "feat: add session download endpoint with S3 presigned URL redirect"
```

---

## Task 6: Dashboard — Build, test manually, deploy

**Step 1: Build**

```bash
cd /Users/ildebrandomagnani/SWARMAPP/swarm_dashboard
npm run build
```

**Step 2: Test locally with curl**

```bash
# Test list with API key
export $(grep -v '^#' /Users/ildebrandomagnani/SWARMAPP/evolve/.env | grep EVOLVE_API_KEY | xargs)
curl -s "https://dashboard.evolvingmachines.ai/api/sessions?paginationMode=cursor&pageSize=3&state=ended" \
  -H "Authorization: Bearer $EVOLVE_API_KEY" | python3 -m json.tool | head -30
```

**Step 3: Deploy**

```bash
export AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export AWS_REGION=us-west-2
./deploy/quick-deploy.sh
```

**Step 4: Test deployed endpoints**

```bash
# List
curl -s "https://dashboard.evolvingmachines.ai/api/sessions?paginationMode=cursor&pageSize=2&state=ended" \
  -H "Authorization: Bearer $EVOLVE_API_KEY" | python3 -m json.tool | head -20

# Get single session (use an ID from list response)
curl -s "https://dashboard.evolvingmachines.ai/api/sessions/SESSION_ID" \
  -H "Authorization: Bearer $EVOLVE_API_KEY" | python3 -m json.tool

# Events
curl -s "https://dashboard.evolvingmachines.ai/api/sessions/SESSION_ID/events" \
  -H "Authorization: Bearer $EVOLVE_API_KEY" | python3 -m json.tool | head -20

# Download (should redirect to S3)
curl -sL "https://dashboard.evolvingmachines.ai/api/sessions/SESSION_ID/download" \
  -H "Authorization: Bearer $EVOLVE_API_KEY" | head -5
```

**Step 5: Commit any fixes and redeploy if needed**

---

## Task 7: SDK — Types

Define the public types for the sessions client in the SDK.

**Files:**
- Create: `evolve/packages/sdk-ts/src/sessions/types.ts`

**Step 1: Write types**

```ts
// packages/sdk-ts/src/sessions/types.ts

/** Options for listing sessions */
export interface ListSessionsOptions {
  /** Max items per page (default: 20, max: 200) */
  limit?: number;
  /** Cursor for pagination (from SessionPage.nextCursor) */
  cursor?: string;
  /** Filter by session state */
  state?: "live" | "ended" | "all";
  /** Filter by agent type (e.g., "claude", "codex") */
  agent?: string;
  /** Filter by tag prefix */
  tagPrefix?: string;
  /** Sort order (default: "newest") */
  sort?: "newest" | "oldest" | "cost";
}

/** Paginated list of sessions */
export interface SessionPage {
  items: SessionInfo[];
  nextCursor: string | null;
  hasMore: boolean;
}

/** Session metadata */
export interface SessionInfo {
  id: string;
  tag: string;
  agent: string;
  model: string | null;
  provider: string;
  sandboxId: string | null;
  /** Ergonomic state: "live" (still running) or "ended" */
  state: "live" | "ended";
  /** Granular runtime status from dashboard */
  runtimeStatus: "alive" | "dead" | "unknown";
  /** Cost in USD. null if not synced yet. Eventually consistent. */
  cost: number | null;
  createdAt: string;
  endedAt: string | null;
  stepCount: number;
  toolStats: Record<string, number> | null;
}

/** Raw parsed JSONL event — no imposed schema */
export type SessionEvent = Record<string, unknown>;

/** Options for downloading a session trace */
export interface DownloadSessionOptions {
  /** Directory to save the JSONL file (default: cwd) */
  to?: string;
}

/** Options for fetching parsed events */
export interface GetEventsOptions {
  /** Return only events after this index (delta fetching) */
  since?: number;
}

/** Configuration for sessions() factory */
export interface SessionsConfig {
  /** API key (default: process.env.EVOLVE_API_KEY) */
  apiKey?: string;
  /** Dashboard URL override (default: DEFAULT_DASHBOARD_URL) */
  dashboardUrl?: string;
}

/** Sessions client for querying past sessions and downloading traces */
export interface SessionsClient {
  /** List sessions with optional filtering and pagination */
  list(options?: ListSessionsOptions): Promise<SessionPage>;
  /** Get a single session by ID */
  get(id: string): Promise<SessionInfo>;
  /** Get parsed JSONL events for a session */
  events(id: string, options?: GetEventsOptions): Promise<SessionEvent[]>;
  /** Download raw JSONL trace file. Returns the file path. */
  download(id: string, options?: DownloadSessionOptions): Promise<string>;
}
```

**Step 2: Commit**

```bash
cd /Users/ildebrandomagnani/SWARMAPP/evolve/.worktrees/feat-sessions-client
git add packages/sdk-ts/src/sessions/types.ts
git commit -m "feat: sessions client types"
```

---

## Task 8: SDK — SessionsClient implementation

**Files:**
- Create: `evolve/packages/sdk-ts/src/sessions/index.ts`

**Step 1: Write the client**

```ts
// packages/sdk-ts/src/sessions/index.ts

import { writeFile, mkdir } from "fs/promises";
import { join, basename } from "path";
import { DEFAULT_DASHBOARD_URL, ENV_EVOLVE_API_KEY } from "../constants";
import type {
  SessionsClient,
  SessionsConfig,
  ListSessionsOptions,
  SessionPage,
  SessionInfo,
  SessionEvent,
  GetEventsOptions,
  DownloadSessionOptions,
} from "./types";

export type {
  SessionsClient,
  SessionsConfig,
  ListSessionsOptions,
  SessionPage,
  SessionInfo,
  SessionEvent,
  GetEventsOptions,
  DownloadSessionOptions,
} from "./types";

/**
 * Create a SessionsClient for querying past sessions and downloading traces.
 *
 * Gateway-only — requires EVOLVE_API_KEY.
 *
 * @example
 * ```ts
 * import { sessions } from "@evolvingmachines/sdk";
 *
 * const s = sessions();
 * const page = await s.list({ limit: 20, state: "ended" });
 * const events = await s.events(page.items[0].id);
 * await s.download(page.items[0].id, { to: "./traces" });
 * ```
 */
export function sessions(config?: SessionsConfig): SessionsClient {
  const apiKey = config?.apiKey || process.env[ENV_EVOLVE_API_KEY];
  if (!apiKey) {
    throw new Error(
      `sessions() requires an API key. Set ${ENV_EVOLVE_API_KEY} or pass { apiKey } in config.`
    );
  }
  const dashboardUrl = config?.dashboardUrl || DEFAULT_DASHBOARD_URL;

  async function request(path: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(`${dashboardUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...init?.headers,
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Dashboard API error (${res.status}): ${text || res.statusText}`);
    }
    return res;
  }

  function mapSessionInfo(raw: Record<string, unknown>): SessionInfo {
    return {
      id: raw.id as string,
      tag: raw.tag as string,
      agent: raw.agent as string,
      model: (raw.model as string) || null,
      provider: raw.provider as string,
      sandboxId: (raw.sandboxId as string) || null,
      state: raw.isEnded ? "ended" : "live",
      runtimeStatus: (raw.runtimeStatus as "alive" | "dead" | "unknown") || "unknown",
      cost: typeof raw.cost === "number" ? raw.cost : null,
      createdAt: raw.createdAt as string,
      endedAt: (raw.endedAt as string) || null,
      stepCount: (raw.stepCount as number) || 0,
      toolStats: (raw.toolStats as Record<string, number>) || null,
    };
  }

  return {
    async list(options?: ListSessionsOptions): Promise<SessionPage> {
      const params = new URLSearchParams({
        paginationMode: "cursor",
        pageSize: String(Math.min(options?.limit ?? 20, 200)),
        paginated: "true",
      });
      if (options?.cursor) params.set("cursor", options.cursor);
      if (options?.state && options.state !== "all") params.set("state", options.state);
      if (options?.agent) params.set("agent", options.agent);
      if (options?.tagPrefix) params.set("tagPrefix", options.tagPrefix);
      if (options?.sort) {
        const sortMap = { newest: "desc", oldest: "asc", cost: "desc" } as const;
        params.set("sortDirection", sortMap[options.sort]);
        if (options.sort === "cost") params.set("sortField", "cost");
        else params.set("sortField", "timestamp");
      }

      const res = await request(`/api/sessions?${params}`);
      const data = await res.json();
      return {
        items: (data.items || []).map(mapSessionInfo),
        nextCursor: data.nextCursor || null,
        hasMore: Boolean(data.hasMore),
      };
    },

    async get(id: string): Promise<SessionInfo> {
      const res = await request(`/api/sessions/${encodeURIComponent(id)}`);
      const data = await res.json();
      return mapSessionInfo(data);
    },

    async events(id: string, options?: GetEventsOptions): Promise<SessionEvent[]> {
      const params = new URLSearchParams();
      if (options?.since != null) params.set("since", String(options.since));
      const qs = params.toString();
      const res = await request(`/api/sessions/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ""}`);
      const data = await res.json();
      return data.events || [];
    },

    async download(id: string, options?: DownloadSessionOptions): Promise<string> {
      // First get session metadata for the filename
      const meta = await request(`/api/sessions/${encodeURIComponent(id)}`);
      const session = await meta.json();
      const tag = session.tag || id;

      const res = await fetch(
        `${dashboardUrl}/api/sessions/${encodeURIComponent(id)}/download`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          redirect: "follow",
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Download failed (${res.status}): ${text || res.statusText}`);
      }

      const dir = options?.to || process.cwd();
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, `${tag}.jsonl`);
      const content = await res.text();
      await writeFile(filePath, content, "utf-8");
      return filePath;
    },
  };
}
```

**Step 2: Commit**

```bash
git add packages/sdk-ts/src/sessions/index.ts
git commit -m "feat: sessions client implementation"
```

---

## Task 9: SDK — Export from index.ts

**Files:**
- Modify: `evolve/packages/sdk-ts/src/index.ts`

**Step 1: Add sessions exports**

Add at the bottom of `index.ts`, after the `STORAGE` section:

```ts
// =============================================================================
// SESSIONS
// =============================================================================

export {
  sessions,
  type SessionsClient,
  type SessionsConfig,
  type ListSessionsOptions,
  type SessionPage,
  type SessionInfo,
  type SessionEvent,
  type GetEventsOptions,
  type DownloadSessionOptions,
} from "./sessions";
```

**Step 2: Build**

```bash
cd /Users/ildebrandomagnani/SWARMAPP/evolve/.worktrees/feat-sessions-client
npm run build --workspace=packages/sdk-ts
```

**Step 3: Commit**

```bash
git add packages/sdk-ts/src/index.ts
git commit -m "feat: export sessions client from SDK"
```

---

## Task 10: SDK — Build and integration test

**Step 1: Build the full SDK dist**

```bash
cd /Users/ildebrandomagnani/SWARMAPP/evolve/.worktrees/feat-sessions-client
npm run build --workspace=packages/sdk-ts
```

**Step 2: Write integration test script**

```ts
// test-sessions-client.ts (temporary, in worktree root)
import { sessions } from "@evolvingmachines/sdk";

async function main() {
  const s = sessions();

  // List ended sessions
  console.log("Listing ended sessions...");
  const page = await s.list({ limit: 5, state: "ended" });
  console.log(`Found ${page.items.length} sessions, hasMore: ${page.hasMore}`);
  for (const item of page.items) {
    console.log(`  ${item.tag} — ${item.state} — ${item.runtimeStatus} — $${item.cost ?? "?"}`);
  }

  if (page.items.length > 0) {
    const first = page.items[0];

    // Get single session
    console.log(`\nGetting session ${first.id}...`);
    const meta = await s.get(first.id);
    console.log(`  tag: ${meta.tag}, agent: ${meta.agent}, cost: $${meta.cost}`);

    // Get events
    console.log(`\nFetching events...`);
    const events = await s.events(first.id);
    console.log(`  ${events.length} events`);

    // Download
    console.log(`\nDownloading trace...`);
    const path = await s.download(first.id, { to: "/tmp/traces" });
    console.log(`  Saved to: ${path}`);
  }

  console.log("\nAll tests passed!");
}

main().catch((e) => { console.error(e); process.exit(1); });
```

**Step 3: Run integration test**

```bash
export $(grep -v '^#' .env | grep EVOLVE_API_KEY | xargs)
npx tsx test-sessions-client.ts
```

**Step 4: Clean up and commit**

```bash
rm test-sessions-client.ts
git add -A
git commit -m "feat: build sessions client dist"
```

---

## Task 11: Python SDK — SessionsClient

**Files:**
- Create: `evolve/packages/sdk-py/evolve/sessions_client.py`
- Modify: `evolve/packages/sdk-py/evolve/__init__.py`

**Step 1: Write Python SessionsClient**

```python
# packages/sdk-py/evolve/sessions_client.py
"""SessionsClient for querying past sessions and downloading traces."""

from dataclasses import dataclass
from typing import Any, Awaitable, Callable, Dict, List, Optional

from .utils import _filter_none


@dataclass
class SessionInfo:
    """Session metadata."""
    id: str
    tag: str
    agent: str
    model: Optional[str]
    provider: str
    sandbox_id: Optional[str]
    state: str  # "live" | "ended"
    runtime_status: str  # "alive" | "dead" | "unknown"
    cost: Optional[float]
    created_at: str
    ended_at: Optional[str]
    step_count: int
    tool_stats: Optional[Dict[str, int]]


@dataclass
class SessionPage:
    """Paginated list of sessions."""
    items: List[SessionInfo]
    next_cursor: Optional[str]
    has_more: bool


def _parse_session_info(data: Dict[str, Any]) -> SessionInfo:
    return SessionInfo(
        id=data["id"],
        tag=data["tag"],
        agent=data["agent"],
        model=data.get("model"),
        provider=data["provider"],
        sandbox_id=data.get("sandboxId"),
        state=data.get("state", "ended"),
        runtime_status=data.get("runtimeStatus", "unknown"),
        cost=data.get("cost"),
        created_at=data["createdAt"],
        ended_at=data.get("endedAt"),
        step_count=data.get("stepCount", 0),
        tool_stats=data.get("toolStats"),
    )


class SessionsClient:
    """Client for querying past sessions and downloading traces.

    Created via the standalone ``sessions()`` factory.
    Wraps bridge JSON-RPC calls to the TypeScript SDK's SessionsClient.

    Example::

        from evolve import sessions

        async with sessions() as s:
            page = await s.list(limit=20, state="ended")
            events = await s.events(page.items[0].id)
            path = await s.download(page.items[0].id, to="./traces")
    """

    def __init__(
        self,
        bridge_call: Callable[..., Awaitable[Any]],
        config: Optional[Dict[str, Any]] = None,
    ):
        self._bridge = bridge_call
        self._config = config or {}

    async def list(
        self,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        state: Optional[str] = None,
        agent: Optional[str] = None,
        tag_prefix: Optional[str] = None,
        sort: Optional[str] = None,
    ) -> SessionPage:
        params = _filter_none(
            config=self._config,
            limit=limit,
            cursor=cursor,
            state=state,
            agent=agent,
            tagPrefix=tag_prefix,
            sort=sort,
        )
        response = await self._bridge("sessions_list", params)
        return SessionPage(
            items=[_parse_session_info(item) for item in response["items"]],
            next_cursor=response.get("nextCursor"),
            has_more=response.get("hasMore", False),
        )

    async def get(self, id: str) -> SessionInfo:
        params = _filter_none(config=self._config, id=id)
        response = await self._bridge("sessions_get", params)
        return _parse_session_info(response)

    async def events(
        self,
        id: str,
        since: Optional[int] = None,
    ) -> List[Dict[str, Any]]:
        params = _filter_none(config=self._config, id=id, since=since)
        response = await self._bridge("sessions_events", params)
        return response

    async def download(
        self,
        id: str,
        to: Optional[str] = None,
    ) -> str:
        params = _filter_none(config=self._config, id=id, to=to)
        response = await self._bridge("sessions_download", params)
        return response["path"]

    async def close(self) -> None:
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        await self.close()
```

**Step 2: Add `sessions()` factory to `__init__.py`**

Add to `packages/sdk-py/evolve/__init__.py` (parallel to `storage()`):

```python
from .sessions_client import SessionsClient, SessionInfo, SessionPage

def sessions(*, api_key: Optional[str] = None) -> SessionsClient:
    """Create a SessionsClient for querying past sessions and downloading traces.

    Gateway-only — requires EVOLVE_API_KEY.

    Example::

        from evolve import sessions

        async with sessions() as s:
            page = await s.list(limit=20, state="ended")
            await s.download(page.items[0].id, to="./traces")
    """
    config: Dict[str, Any] = {}
    if api_key:
        config["apiKey"] = api_key
    bridge = _create_bridge(config)
    return SessionsClient(bridge_call=bridge.call, config=config)
```

**Step 3: Commit**

```bash
git add packages/sdk-py/evolve/sessions_client.py packages/sdk-py/evolve/__init__.py
git commit -m "feat: Python sessions client"
```

---

## Task 12: Python bridge — Add sessions commands

**Files:**
- Modify: `evolve/packages/sdk-py/bridge/` (the bundled bridge.mjs handles JSON-RPC commands)

Note: The bridge is a pre-bundled `bridge.mjs` that routes JSON-RPC method names to TypeScript SDK functions. Add handlers for `sessions_list`, `sessions_get`, `sessions_events`, `sessions_download`.

**Step 1: Check current bridge command registration**

```bash
grep -n 'storage_list\|register\|method.*=>' packages/sdk-py/bridge/bridge.mjs | head -20
```

Follow the existing pattern to add sessions commands. The bridge maps method names to SDK function calls.

**Step 2: Add sessions commands to bridge source and rebuild**

This depends on the bridge bundling setup. Follow the pattern used for `storage_list_checkpoints` → `storage().listCheckpoints()`.

**Step 3: Rebuild bridge bundle**

```bash
npm run build --workspace=packages/sdk-py
```

**Step 4: Commit**

```bash
git add packages/sdk-py/bridge/
git commit -m "feat: add sessions commands to Python bridge"
```

---

## Task 13: Final build, test, and push

**Step 1: Full monorepo build**

```bash
cd /Users/ildebrandomagnani/SWARMAPP/evolve/.worktrees/feat-sessions-client
npm run build
```

**Step 2: Run integration test again from worktree**

```bash
export $(grep -v '^#' .env | grep EVOLVE_API_KEY | xargs)
# Write quick inline test
node -e "
const { sessions } = require('./packages/sdk-ts/dist');
(async () => {
  const s = sessions();
  const page = await s.list({ limit: 3, state: 'ended' });
  console.log('Sessions:', page.items.length, 'hasMore:', page.hasMore);
  if (page.items.length) {
    console.log('First:', page.items[0].tag, page.items[0].state, '$' + page.items[0].cost);
  }
  console.log('PASS');
})().catch(e => { console.error(e); process.exit(1); });
"
```

**Step 3: Push branch**

```bash
git push -u origin feat/sessions-client
```

**Step 4: Create PR**

```bash
gh pr create --title "feat: sessions client for remote trace history" \
  --body "Adds \`sessions()\` factory to the SDK for listing, inspecting, and downloading traces from past agent sessions.

## Changes

### Dashboard (swarm_dashboard)
- Dual auth helper (\`lib/auth-dual.ts\`) — routes accept NextAuth OR API key
- \`GET /api/sessions\` — now accepts API key auth + state/agent/tagPrefix filters
- \`GET /api/sessions/[id]\` — new single-session metadata endpoint
- \`GET /api/sessions/[id]/events\` — now accepts API key auth
- \`GET /api/sessions/[id]/download\` — new raw JSONL download via S3 presigned URL

### SDK (TypeScript)
- \`sessions/types.ts\` — SessionsClient, SessionInfo, SessionPage, etc.
- \`sessions/index.ts\` — Factory + client implementation
- Exported from \`@evolvingmachines/sdk\`

### SDK (Python)
- \`sessions_client.py\` — Mirrors TypeScript API via bridge
- \`sessions()\` factory in \`__init__.py\`

## Usage
\`\`\`ts
import { sessions } from '@evolvingmachines/sdk';
const s = sessions();
const page = await s.list({ limit: 20, state: 'ended' });
const events = await s.events(page.items[0].id);
await s.download(page.items[0].id, { to: './traces' });
\`\`\`

Design: \`docs/plans/2026-03-05-sessions-client-design.md\`"
```

---

## Task Summary

| Task | Repo | Description |
|------|------|-------------|
| 1 | Dashboard | Dual auth helper |
| 2 | Dashboard | API key auth + filters on list endpoint |
| 3 | Dashboard | GET /api/sessions/[id] |
| 4 | Dashboard | API key auth on events endpoint |
| 5 | Dashboard | Download endpoint (presigned URL) |
| 6 | Dashboard | Build, deploy, manual test |
| 7 | SDK TS | Types |
| 8 | SDK TS | Client implementation |
| 9 | SDK TS | Export from index.ts |
| 10 | SDK TS | Build + integration test |
| 11 | SDK Py | Python SessionsClient |
| 12 | SDK Py | Bridge commands |
| 13 | All | Final build, test, push, PR |
