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
