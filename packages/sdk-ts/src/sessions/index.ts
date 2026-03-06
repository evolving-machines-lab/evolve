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
      const params = new URLSearchParams();
      if (options?.since != null) params.set("since", String(options.since));
      const qs = params.toString();
      const res = await request(
        `/api/sessions/${encodeURIComponent(id)}/events${qs ? `?${qs}` : ""}`
      );
      const data = await res.json();
      return (data.events as SessionEvent[]) || [];
    },

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
  };
}
