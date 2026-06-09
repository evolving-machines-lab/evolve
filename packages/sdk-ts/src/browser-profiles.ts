import { DEFAULT_DASHBOARD_URL } from "./constants";

export interface BrowserProfileMetadata {
  id: string;
  profile: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface BrowserProfilesClientConfig {
  apiKey?: string;
  dashboardUrl?: string;
}

export interface BrowserProfileDeleteInput {
  profile: string;
}

type BrowserProfileApiMetadata = Omit<BrowserProfileMetadata, "profile" | "lastUsedAt" | "createdAt" | "updatedAt"> & {
  profile: string;
  provider?: string;
  createdAt?: string;
  created_at?: string;
  updatedAt?: string;
  updated_at?: string;
  lastUsedAt?: string | null;
  last_used_at?: string | null;
};

function dashboardBaseUrl(url?: string): string {
  return (url || process.env.EVOLVE_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/$/, "");
}

function resolveApiKey(apiKey?: string): string {
  const resolved = apiKey || process.env.EVOLVE_API_KEY;
  if (!resolved) throw new Error("Browser profiles require EVOLVE_API_KEY or an explicit apiKey");
  return resolved;
}

async function readError(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

async function requestJson<T>(
  config: BrowserProfilesClientConfig | undefined,
  path: string,
  init: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${dashboardBaseUrl(config?.dashboardUrl)}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${resolveApiKey(config?.apiKey)}`,
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`Browser profiles request failed (${response.status}): ${await readError(response)}`);
  }
  if (response.status === 204) return {} as T;
  return await response.json() as T;
}

export class BrowserProfilesClient {
  constructor(private readonly config: BrowserProfilesClientConfig = {}) {}

  private toMetadata(profile: BrowserProfileApiMetadata): BrowserProfileMetadata {
    return {
      id: profile.id,
      profile: profile.profile,
      createdAt: profile.createdAt || profile.created_at || "",
      updatedAt: profile.updatedAt || profile.updated_at || "",
      lastUsedAt: profile.lastUsedAt ?? profile.last_used_at ?? null,
    };
  }

  async list(): Promise<{ profiles: BrowserProfileMetadata[] }> {
    const result = await requestJson<{ profiles: BrowserProfileApiMetadata[] }>(this.config, "/api/browser-profiles");
    return {
      profiles: result.profiles.map((profile) => this.toMetadata(profile)),
    };
  }

  async delete(input: BrowserProfileDeleteInput): Promise<{ ok: boolean }> {
    return await requestJson(this.config, "/api/browser-profiles", {
      method: "DELETE",
      body: JSON.stringify(input),
    });
  }
}

export function browserProfiles(config: BrowserProfilesClientConfig = {}): BrowserProfilesClient {
  return new BrowserProfilesClient(config);
}
