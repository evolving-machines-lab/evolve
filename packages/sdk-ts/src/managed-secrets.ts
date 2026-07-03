import { DEFAULT_DASHBOARD_URL } from "./constants";
import type { ManagedSecretRef } from "./types";

export const MANAGED_SECRET_RUNTIME_TOKEN_HEADER =
  "x-evolve-managed-secret-token";
export const MANAGED_SECRET_RUNTIME_BINDING_HEADER =
  "x-evolve-managed-secret-binding";
export const MANAGED_SECRET_TARGET_HEADER = "x-evolve-managed-secret-target";
export const MANAGED_SECRET_PROXY_URL_ENV =
  "EVOLVE_MANAGED_SECRETS_PROXY_URL";
export const MANAGED_SECRET_TOKEN_ENV = "EVOLVE_MANAGED_SECRETS_TOKEN";
export const MANAGED_SECRET_BINDING_ENV = "EVOLVE_MANAGED_SECRETS_BINDING";

export interface ManagedSecretMetadata {
  id: string;
  name: string;
  label: string;
  enabled: boolean;
  allowedHosts: string[];
  allowedPathPrefixes: string[];
  allowedMethods: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface ManagedSecretsClientConfig {
  apiKey?: string;
  dashboardUrl?: string;
}

export interface ManagedSecretRuntimeConfig {
  apiKey: string;
  dashboardUrl?: string;
  secrets: ManagedSecretRef[];
}

export type ManagedSecretRuntimeToken = {
  enabled: true;
  token: string;
  bindingSecret: string;
  proxyUrl: string;
  expiresAt: string;
  envs: Record<string, string>;
};

function dashboardBaseUrl(url?: string): string {
  return (url || process.env.EVOLVE_DASHBOARD_URL || DEFAULT_DASHBOARD_URL)
    .replace(/\/$/, "");
}

function resolveApiKey(apiKey?: string): string {
  const resolved = apiKey || process.env.EVOLVE_API_KEY;
  if (!resolved) {
    throw new Error("Managed secrets require EVOLVE_API_KEY or an explicit apiKey");
  }
  return resolved;
}

async function readError(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

class ManagedSecretRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ManagedSecretRequestError";
  }
}

export function isManagedSecretEndpointMissing(error: unknown): boolean {
  return error instanceof ManagedSecretRequestError && error.status === 404;
}

async function requestJson<T>(
  config: ManagedSecretsClientConfig | ManagedSecretRuntimeConfig,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(
    `${dashboardBaseUrl(config.dashboardUrl)}${path}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${resolveApiKey(config.apiKey)}`,
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    },
  );
  if (!response.ok) {
    throw new ManagedSecretRequestError(
      response.status,
      `Managed secrets request failed (${response.status}): ${await readError(response)}`,
    );
  }
  return (await response.json()) as T;
}

function isRuntimeTokenResponse(value: unknown): value is ManagedSecretRuntimeToken {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    record.enabled === true &&
    typeof record.token === "string" &&
    record.token.length > 0 &&
    typeof record.bindingSecret === "string" &&
    record.bindingSecret.length > 0 &&
    typeof record.proxyUrl === "string" &&
    record.proxyUrl.length > 0 &&
    typeof record.expiresAt === "string" &&
    record.expiresAt.length > 0 &&
    !!record.envs &&
    typeof record.envs === "object" &&
    !Array.isArray(record.envs)
  );
}

export class ManagedSecretsClient {
  constructor(private readonly config: ManagedSecretsClientConfig = {}) {}

  async list(): Promise<ManagedSecretMetadata[]> {
    const result = await requestJson<{ secrets: ManagedSecretMetadata[] }>(
      this.config,
      "/api/managed-secrets",
    );
    return result.secrets;
  }
}

export function managedSecrets(
  config: ManagedSecretsClientConfig = {},
): ManagedSecretsClient {
  return new ManagedSecretsClient(config);
}

export function managedSecretRefEnvName(ref: ManagedSecretRef): string {
  return (ref.as || ref.name).trim().toUpperCase();
}

export async function createManagedSecretRuntimeToken(
  config: ManagedSecretRuntimeConfig,
  input: { sessionTag: string },
): Promise<ManagedSecretRuntimeToken> {
  const result = await requestJson<unknown>(
    config,
    "/api/managed-secrets/runtime-token",
    {
      method: "POST",
      body: JSON.stringify({
        sessionTag: input.sessionTag,
        secrets: config.secrets,
      }),
    },
  );
  if (!isRuntimeTokenResponse(result)) {
    throw new ManagedSecretRequestError(
      502,
      "Managed secret runtime token response was invalid",
    );
  }
  return result;
}

export async function bindManagedSecretRuntimeToken(
  config: ManagedSecretRuntimeConfig,
  input: { token: string; sandboxId: string },
): Promise<boolean> {
  const result = await requestJson<{ ok: boolean }>(
    config,
    "/api/managed-secrets/runtime-token",
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
  return result.ok;
}

export async function revokeManagedSecretRuntimeToken(
  config: ManagedSecretRuntimeConfig,
  input: { token: string },
): Promise<boolean> {
  const result = await requestJson<{ ok: boolean }>(
    config,
    "/api/managed-secrets/runtime-token",
    {
      method: "DELETE",
      body: JSON.stringify(input),
    },
  );
  return result.ok;
}
