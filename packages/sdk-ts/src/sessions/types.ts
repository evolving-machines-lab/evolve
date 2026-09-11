import type { GatewayUsageEvent, UsageReading } from "../hosted/types";

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
  /**
   * THE ONE-HOME USAGE READING: spend so far plus the token breakdown from
   * the same gateway records, `provisional` saying whether the numbers can
   * still grow — live sessions tick as the gateway's spend logs batch in;
   * an ended session settles once its sync runs past the flush window. The
   * SAME object, same keys, a trial serves — one renderer covers both. Null
   * = the meter never answered (and on servers predating the field).
   */
  usage: UsageReading | null;
  createdAt: string;
  endedAt: string | null;
  stepCount: number;
  toolStats: Record<string, number> | null;
}

/** Raw parsed JSONL event — no imposed schema */
export type SessionEvent = Record<string, unknown>;

/**
 * One read of a session's transcript feed (`GET /api/sessions/{id}/events`):
 * the parsed events after `since` plus the facts the feed serves around them.
 * Unlike a trial's trace there is no server-side paging — one read answers
 * everything after `since`, and `total` counts ALL stored events, so the next
 * delta read passes `since: total`.
 */
export interface SessionTranscript {
  /** The session as the feed served it — the same shape `get()` returns, so `usage` / `cost` is the run's total. */
  session: SessionInfo;
  /** The events after `since`: what `events()` returns alone. */
  events: SessionEvent[];
  /** ALL stored events, independent of `since`. */
  total: number;
  /**
   * THE GATEWAY METER's per-call lines for this session (spec
   * GatewayUsageEvent), in time order: one model call as the LiteLLM gateway
   * priced it — prompt / completion / cached tokens and `costUsd`, the same
   * line a trial's trace carries in its gateway band. Served whole on every
   * read and beside `events`, never inside them: a session's `since` is an
   * event COUNT, so a call line in the list would corrupt every delta
   * poller's cursor. The ONLY per-call tokens and money a client may show
   * (a harness's own `usage` line stays a raw record).
   */
  gatewayCalls: GatewayUsageEvent[];
}

/** Options for downloading a session trace */
export interface DownloadSessionOptions {
  /** Directory to save the JSONL file (default: cwd) */
  to?: string;
}

/** Options for waiting on browser replay readiness */
export interface BrowserReplayOptions {
  /** Max time to wait for replay readiness (default: 600000ms) */
  timeoutMs?: number;
  /** Poll interval while replay is processing (default: 5000ms) */
  intervalMs?: number;
}

/** Browser replay metadata and access URLs */
export interface BrowserReplay {
  sessionId: string;
  status: "ready";
  replayUrl: string;
  downloadUrl: string;
  suggestedStartSeconds?: number;
  sizeBytes?: number;
  readyAt?: string;
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
  /** Get parsed JSONL events for a session (the transcript's `events` alone) */
  events(id: string, options?: GetEventsOptions): Promise<SessionEvent[]>;
  /**
   * The transcript feed in one read: the `session`, its `events` after
   * `since`, the `total` stored, and the gateway meter's per-call
   * `gatewayCalls` (see SessionTranscript).
   */
  transcript(id: string, options?: GetEventsOptions): Promise<SessionTranscript>;
  /** Download raw JSONL trace file. Returns the file path. */
  download(id: string, options?: DownloadSessionOptions): Promise<string>;
  /** Wait for browser replay and return Dashboard-owned replay/download URLs. */
  browserReplay(id: string, options?: BrowserReplayOptions): Promise<BrowserReplay>;
}
