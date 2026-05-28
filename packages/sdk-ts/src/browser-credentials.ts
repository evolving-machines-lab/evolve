import { constants, publicEncrypt } from "crypto";
import type { BrowserCredentialScopeEntry, BrowserCredentialsConfig, McpServerConfig } from "./types";
import { DEFAULT_DASHBOARD_URL } from "./constants";

const BROWSER_AUTH_ALGORITHM = "RSA-OAEP-256";
export const BROWSER_LOGIN_MCP_SERVER_NAME = "browser-login";

export interface BrowserCredentialMetadata {
  id: string;
  website: string;
  alias: string;
  email: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface BrowserCredentialsClientConfig {
  apiKey?: string;
  dashboardUrl?: string;
}

export interface BrowserCredentialCreateInput {
  website: string;
  alias: string;
  email: string;
  password: string;
}

export type BrowserCredentialDeleteInput =
  | { id: string }
  | { website: string; alias: string };

export interface BrowserCredentialListOptions {
  website?: string;
  limit?: number;
  offset?: number;
}

type PublicKeyResponse = {
  id: string;
  algorithm: typeof BROWSER_AUTH_ALGORITHM;
  publicKey: string;
};

type EncryptedPassword = {
  algorithm: typeof BROWSER_AUTH_ALGORITHM;
  keyId: string;
  ciphertext: string;
};

function dashboardBaseUrl(url?: string): string {
  return (url || process.env.EVOLVE_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/$/, "");
}

function resolveApiKey(apiKey?: string): string {
  const resolved = apiKey || process.env.EVOLVE_API_KEY;
  if (!resolved) throw new Error("Browser credentials require EVOLVE_API_KEY or an explicit apiKey");
  return resolved;
}

async function readError(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

async function requestJson<T>(
  config: BrowserCredentialsClientConfig | undefined,
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
    throw new Error(`Browser credentials request failed (${response.status}): ${await readError(response)}`);
  }
  return await response.json() as T;
}

async function encryptPassword(
  config: BrowserCredentialsClientConfig | undefined,
  password: string
): Promise<EncryptedPassword> {
  const key = await requestJson<PublicKeyResponse>(config, "/api/browser-credentials/public-key");
  const ciphertext = publicEncrypt(
    {
      key: key.publicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(password, "utf8")
  );
  return {
    algorithm: BROWSER_AUTH_ALGORITHM,
    keyId: key.id,
    ciphertext: ciphertext.toString("base64url"),
  };
}

export class BrowserCredentialsClient {
  constructor(private readonly config: BrowserCredentialsClientConfig = {}) {}

  async list(options: BrowserCredentialListOptions = {}): Promise<{
    credentials: BrowserCredentialMetadata[];
    total: number;
    count: number;
    offset: number;
    hasMore: boolean;
  }> {
    const params = new URLSearchParams();
    if (options.website) params.set("website", options.website);
    if (options.limit !== undefined) params.set("limit", String(options.limit));
    if (options.offset !== undefined) params.set("offset", String(options.offset));
    const suffix = params.toString() ? `?${params.toString()}` : "";
    const result = await requestJson<{
      credentials: BrowserCredentialMetadata[];
      total: number;
      count: number;
      offset: number;
      has_more?: boolean;
    }>(this.config, `/api/browser-credentials${suffix}`);
    return {
      credentials: result.credentials,
      total: result.total,
      count: result.count,
      offset: result.offset,
      hasMore: result.has_more ?? result.offset + result.count < result.total,
    };
  }

  async create(input: BrowserCredentialCreateInput): Promise<{
    status: "created" | "already_exists";
    credential: BrowserCredentialMetadata;
  }> {
    const encryptedPassword = await encryptPassword(this.config, input.password);
    return await requestJson(this.config, "/api/browser-credentials", {
      method: "POST",
      body: JSON.stringify({
        website: input.website,
        alias: input.alias,
        email: input.email,
        encryptedPassword,
      }),
    });
  }

  async delete(input: BrowserCredentialDeleteInput): Promise<{ ok: boolean }> {
    return await requestJson(this.config, "/api/browser-credentials", {
      method: "DELETE",
      body: JSON.stringify(input),
    });
  }
}

export function browserCredentials(config: BrowserCredentialsClientConfig = {}): BrowserCredentialsClient {
  return new BrowserCredentialsClient(config);
}

export async function createBrowserLoginMcpServer(options: {
  apiKey: string;
  dashboardUrl?: string;
  browserSessionId: string;
  sessionTag: string;
  grantToken: string;
  config?: BrowserCredentialsConfig;
}): Promise<McpServerConfig> {
  const response = await requestJson<{
    server: McpServerConfig;
  }>({
    apiKey: options.apiKey,
    dashboardUrl: options.dashboardUrl,
  }, "/api/browser-login/mcp-config", {
    method: "POST",
    body: JSON.stringify({
      browserSessionId: options.browserSessionId,
      sessionTag: options.sessionTag,
      grantToken: options.grantToken,
      allow: options.config?.allow,
    }),
  });
  return response.server;
}

export function normalizeBrowserCredentialScope(
  config?: BrowserCredentialsConfig
): BrowserCredentialScopeEntry[] | undefined {
  return config?.allow?.map((entry) => ({
    website: entry.website,
    ...(entry.alias ? { alias: entry.alias } : {}),
  }));
}
