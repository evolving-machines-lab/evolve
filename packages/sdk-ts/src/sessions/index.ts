import { gatewayUsageOf, mapStoredAt, mapUsageReading, type GatewayUsageEvent } from "../hosted/types";
import { createWriteStream } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { DEFAULT_DASHBOARD_URL, ENV_EVOLVE_API_KEY } from "../constants";
import type {
  SessionsClient,
  SessionsConfig,
  ListSessionsOptions,
  SessionPage,
  SessionInfo,
  SessionEvent,
  SessionTranscript,
  GetEventsOptions,
  DownloadSessionOptions,
  BrowserReplay,
  BrowserReplayOptions,
} from "./types";

export type {
  SessionsClient,
  SessionsConfig,
  ListSessionsOptions,
  SessionPage,
  SessionInfo,
  SessionEvent,
  SessionTranscript,
  GetEventsOptions,
  DownloadSessionOptions,
  BrowserReplay,
  BrowserReplayOptions,
} from "./types";

const DEFAULT_BROWSER_REPLAY_TIMEOUT_MS = 600_000;
const DEFAULT_BROWSER_REPLAY_INTERVAL_MS = 5_000;

function positiveNumber(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return resolved;
}

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
 * const { gatewayCalls } = await s.transcript(page.items[0].id); // the gateway's per-call tokens + cost
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
      throw new Error(
        `Dashboard API error (${res.status}): ${text || res.statusText}`
      );
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
      runtimeStatus:
        (raw.runtimeStatus as "alive" | "dead" | "unknown") || "unknown",
      cost: typeof raw.cost === "number" ? raw.cost : null,
      // The one-home usage reading, by the one shared parsing rule — a
      // malformed or absent object reads null ("the meter never answered").
      usage: mapUsageReading(raw.usage),
      createdAt: raw.createdAt as string,
      endedAt: (raw.endedAt as string) || null,
      stepCount: (raw.stepCount as number) || 0,
      toolStats: (raw.toolStats as Record<string, number>) || null,
    };
  }

  function mapBrowserReplay(raw: Record<string, unknown>, id: string): BrowserReplay {
    if (raw.status !== "ready") {
      throw new Error(`Browser replay is not ready (status: ${String(raw.status || "unknown")})`);
    }
    if (typeof raw.replayUrl !== "string" || typeof raw.downloadUrl !== "string") {
      throw new Error("Browser replay response missing replayUrl or downloadUrl");
    }
    return {
      sessionId: (raw.sessionId as string) || id,
      status: "ready",
      replayUrl: raw.replayUrl,
      downloadUrl: raw.downloadUrl,
      suggestedStartSeconds: typeof raw.suggestedStartSeconds === "number" ? raw.suggestedStartSeconds : undefined,
      sizeBytes: typeof raw.sizeBytes === "number" ? raw.sizeBytes : undefined,
      readyAt: typeof raw.readyAt === "string" ? raw.readyAt : undefined,
    };
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * The feed's `gatewayCalls` as the typed lines they claim to be. A row that
   * is not the gateway's usage shape (gatewayUsageOf — the ONE test a
   * renderer applies before it shows tokens or money) is refused by index,
   * never shown as a $0 call; a feed without the field (a server predating
   * the push meter) reads as no calls.
   */
  function mapGatewayCalls(raw: unknown): GatewayUsageEvent[] {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) {
      throw new Error("Session transcript response gatewayCalls is not a list");
    }
    return raw.map((row, i) => {
      const data = row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : null;
      if (!data || gatewayUsageOf({ data }) === null) {
        throw new Error(`Session transcript response gatewayCalls[${i}] is not a gateway usage event`);
      }
      return data as unknown as GatewayUsageEvent;
    });
  }

  // The one read of the transcript feed; events() is its `events` projection.
  async function transcript(id: string, options?: GetEventsOptions): Promise<SessionTranscript> {
    const params = new URLSearchParams();
    if (options?.since != null) params.set("since", String(options.since));
    const qs = params.toString();
    const res = await request(
      `/api/sessions/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ""}`
    );
    const data = (await res.json()) as Record<string, unknown>;
    const session = data.session;
    if (!session || typeof session !== "object" || Array.isArray(session)) {
      throw new Error("Session transcript response missing session");
    }
    const events = (data.events as SessionEvent[]) || [];
    return {
      session: mapSessionInfo(session as Record<string, unknown>),
      events,
      // The feed states the stored count; a server predating the field can
      // only be read as "what this page reached" (since + rows served).
      total: typeof data.total === "number" ? data.total : (options?.since ?? 0) + events.length,
      gatewayCalls: mapGatewayCalls(data.gatewayCalls),
      storedAt: mapStoredAt(data.storedAt, events.length, "Session transcript response"),
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
      if (options?.state && options.state !== "all")
        params.set("state", options.state);
      if (options?.agent) params.set("agent", options.agent);
      if (options?.tagPrefix) params.set("tagPrefix", options.tagPrefix);
      if (options?.sort) {
        const sortMap = {
          newest: "desc",
          oldest: "asc",
          cost: "desc",
        } as const;
        params.set("sortDirection", sortMap[options.sort]);
        if (options.sort === "cost") params.set("sortField", "cost");
        else params.set("sortField", "timestamp");
      }

      const res = await request(`/api/sessions?${params}`);
      const data = await res.json();
      return {
        items: ((data.items as Record<string, unknown>[]) || []).map(
          mapSessionInfo
        ),
        nextCursor: (data.nextCursor as string) || null,
        hasMore: Boolean(data.hasMore),
      };
    },

    async get(id: string): Promise<SessionInfo> {
      const res = await request(
        `/api/sessions/${encodeURIComponent(id)}`
      );
      const data = await res.json();
      return mapSessionInfo(data as Record<string, unknown>);
    },

    async events(
      id: string,
      options?: GetEventsOptions
    ): Promise<SessionEvent[]> {
      return (await transcript(id, options)).events;
    },

    transcript,

    async download(
      id: string,
      options?: DownloadSessionOptions
    ): Promise<string> {
      // Get session metadata for filename
      const meta = await request(
        `/api/sessions/${encodeURIComponent(id)}`
      );
      const session = (await meta.json()) as Record<string, unknown>;
      const tag = (session.tag as string) || id;

      // Download raw JSONL (follows presigned URL redirect)
      const res = await fetch(
        `${dashboardUrl}/api/sessions/${encodeURIComponent(id)}/download`,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          redirect: "follow",
        }
      );
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          `Download failed (${res.status}): ${text || res.statusText}`
        );
      }

      const dir = options?.to || process.cwd();
      await mkdir(dir, { recursive: true });
      const filePath = join(dir, `${tag}.jsonl`);
      if (!res.body) {
        throw new Error("Download response has no body");
      }
      const nodeStream = Readable.fromWeb(res.body as import("stream/web").ReadableStream);
      await pipeline(nodeStream, createWriteStream(filePath));
      return filePath;
    },

    async browserReplay(
      id: string,
      options?: BrowserReplayOptions
    ): Promise<BrowserReplay> {
      const timeoutMs = positiveNumber("timeoutMs", options?.timeoutMs, DEFAULT_BROWSER_REPLAY_TIMEOUT_MS);
      const intervalMs = positiveNumber("intervalMs", options?.intervalMs, DEFAULT_BROWSER_REPLAY_INTERVAL_MS);
      const deadline = Date.now() + timeoutMs;
      const path = `/api/sessions/${encodeURIComponent(id)}/browser-replay`;

      while (true) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error(`Browser replay timed out after ${timeoutMs}ms`);
        }

        let res: Response;
        try {
          res = await fetch(`${dashboardUrl}${path}`, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              accept: "application/json",
            },
            signal: AbortSignal.timeout(Math.max(1, remainingMs)),
          });
        } catch (error) {
          const name = (error as { name?: string }).name;
          if (name === "AbortError" || name === "TimeoutError") {
            throw new Error(`Browser replay timed out after ${timeoutMs}ms`);
          }
          throw error;
        }

        let data: Record<string, unknown> = {};
        if (!res.ok) {
          const text = await res.text().catch(() => "");
          throw new Error(
            `Dashboard API error (${res.status}): ${text || res.statusText}`
          );
        } else {
          data = await res.json() as Record<string, unknown>;
        }

        if (data.status === "ready") return mapBrowserReplay(data, id);
        if (data.status === "failed") {
          const error = typeof data.error === "string" ? data.error : "unknown error";
          throw new Error(`Browser replay failed: ${error}`);
        }

        if (Date.now() >= deadline) {
          throw new Error(`Browser replay timed out after ${timeoutMs}ms`);
        }
        await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
      }
    },
  };
}
