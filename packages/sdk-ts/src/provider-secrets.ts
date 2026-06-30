import { DEFAULT_DASHBOARD_URL } from "./constants";

export type ProviderRuntimeToken = {
  provider: "anthropic" | "openai";
  credentialMode: "provider_key" | "evolve_key";
  token: string;
  bindingSecret: string;
  baseUrl: string;
  expiresAt: string;
};

export const PROVIDER_RUNTIME_BINDING_HEADER =
  "x-evolve-provider-runtime-binding";

export interface ProviderRuntimeTokenClientConfig {
  apiKey: string;
  dashboardUrl?: string;
}

function dashboardBaseUrl(url?: string): string {
  return (
    url ||
    process.env.EVOLVE_DASHBOARD_URL ||
    DEFAULT_DASHBOARD_URL
  ).replace(/\/$/, "");
}

async function readError(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

class ProviderRuntimeTokenRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ProviderRuntimeTokenRequestError";
  }
}

export function isProviderRuntimeTokenEndpointMissing(error: unknown): boolean {
  return (
    error instanceof ProviderRuntimeTokenRequestError && error.status === 404
  );
}

async function requestJson<T>(
  config: ProviderRuntimeTokenClientConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(
    `${dashboardBaseUrl(config.dashboardUrl)}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    },
  );
  if (!response.ok) {
    throw new ProviderRuntimeTokenRequestError(
      response.status,
      `Provider runtime token request failed (${response.status}): ${await readError(response)}`,
    );
  }
  return (await response.json()) as T;
}

function isRuntimeTokenResponse(value: unknown): value is ProviderRuntimeToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.enabled === true &&
    (record.provider === "anthropic" || record.provider === "openai") &&
    (record.credentialMode === "provider_key" ||
      record.credentialMode === "evolve_key") &&
    typeof record.token === "string" &&
    record.token.length > 0 &&
    typeof record.bindingSecret === "string" &&
    record.bindingSecret.length > 0 &&
    typeof record.baseUrl === "string" &&
    record.baseUrl.length > 0 &&
    typeof record.expiresAt === "string" &&
    record.expiresAt.length > 0
  );
}

export async function createProviderRuntimeToken(
  config: ProviderRuntimeTokenClientConfig,
  input: { provider: "anthropic" | "openai"; sessionTag: string },
): Promise<ProviderRuntimeToken> {
  const result = await requestJson<unknown>(
    config,
    "/api/provider-secrets/runtime-token",
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  if (!isRuntimeTokenResponse(result)) {
    throw new ProviderRuntimeTokenRequestError(
      502,
      "Provider runtime token response was invalid",
    );
  }
  return result;
}

export async function bindProviderRuntimeToken(
  config: ProviderRuntimeTokenClientConfig,
  input: { token: string; sandboxId: string },
): Promise<boolean> {
  const result = await requestJson<{ ok: boolean }>(
    config,
    "/api/provider-secrets/runtime-token",
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
  return result.ok;
}

export async function revokeProviderRuntimeToken(
  config: ProviderRuntimeTokenClientConfig,
  input: { token: string },
): Promise<boolean> {
  const result = await requestJson<{ ok: boolean }>(
    config,
    "/api/provider-secrets/runtime-token",
    {
      method: "DELETE",
      body: JSON.stringify(input),
    },
  );
  return result.ok;
}
