import { DEFAULT_DASHBOARD_URL } from "./constants";
import type { IntegrationToolsFilter, IntegrationsSetup } from "./types";

export interface IntegrationMcpResult {
  url: string;
  headers: Record<string, string>;
}

export interface IntegrationRuntimeSetup extends IntegrationsSetup {
  apiKey: string;
  dashboardUrl?: string;
  sessionTag?: string;
}

export interface IntegrationConnectParams {
  userId?: string;
  userToken?: string;
  app: string;
  callbackUrl?: string;
  apiKey?: string;
  dashboardUrl?: string;
}

export interface IntegrationConnectResult {
  url: string;
  connectionId?: string;
}

export interface IntegrationConnectionStatus {
  app: string;
  appName?: string;
  appIcon?: string;
  status: string;
  accountId?: string;
}

export interface IntegrationActivity {
  app: string;
  appName?: string;
  tool: string;
  status: string;
  userId: string;
  durationMs?: number;
  occurredAt: string;
}

const ROOT_INTEGRATION_USER_ID = "root";

function dashboardBaseUrl(dashboardUrl?: string): string {
  return (dashboardUrl || process.env.EVOLVE_DASHBOARD_URL || DEFAULT_DASHBOARD_URL).replace(/\/$/, "");
}

function resolveApiKey(apiKey?: string): string {
  const resolved = apiKey || process.env.EVOLVE_API_KEY;
  if (!resolved) {
    throw new Error("EVOLVE_API_KEY is required for managed integrations");
  }
  return resolved;
}

async function readError(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

function normalizeUserId(userId?: string): string {
  return userId?.trim() || ROOT_INTEGRATION_USER_ID;
}

function normalizeApps(apps?: string[]): string[] {
  const normalized = Array.from(new Set((apps ?? []).map((app) => app.trim()).filter(Boolean)));
  if (normalized.length === 0) {
    throw new Error("withIntegrations() requires at least one app");
  }
  return normalized;
}

export async function setupIntegrations(config: IntegrationRuntimeSetup): Promise<IntegrationMcpResult> {
  const response = await fetch(`${dashboardBaseUrl(config.dashboardUrl)}/api/integration-sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolveApiKey(config.apiKey)}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      userId: normalizeUserId(config.userId),
      userToken: config.userToken,
      apps: normalizeApps(config.apps),
      tools: config.tools,
      sessionTag: config.sessionTag,
      manageConnections: config.manageConnections,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Managed integrations session create failed (${response.status}): ${await readError(response)}`);
  }

  const data = await response.json() as {
    mcp?: {
      url?: string;
      headers?: Record<string, string>;
    };
  };

  if (!data.mcp?.url) {
    throw new Error("Managed integrations response missing mcp.url");
  }

  return {
    url: data.mcp.url,
    headers: data.mcp.headers ?? {},
  };
}

export async function connectIntegration(params: IntegrationConnectParams): Promise<IntegrationConnectResult> {
  const response = await fetch(`${dashboardBaseUrl(params.dashboardUrl)}/api/integrations/connect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolveApiKey(params.apiKey)}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      userId: normalizeUserId(params.userId),
      userToken: params.userToken,
      app: params.app,
      callbackUrl: params.callbackUrl,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Managed integration connect failed (${response.status}): ${await readError(response)}`);
  }

  return await response.json() as IntegrationConnectResult;
}

export async function getIntegrationStatus(params: {
  userId?: string;
  userToken?: string;
  apiKey?: string;
  dashboardUrl?: string;
} = {}): Promise<IntegrationConnectionStatus[]> {
  const search = new URLSearchParams({ userId: normalizeUserId(params.userId) });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolveApiKey(params.apiKey)}`,
    accept: "application/json",
  };
  if (params.userToken) headers["x-evolve-integration-user-token"] = params.userToken;

  const response = await fetch(`${dashboardBaseUrl(params.dashboardUrl)}/api/integrations/status?${search}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Managed integration status failed (${response.status}): ${await readError(response)}`);
  }

  const data = await response.json() as { connections?: Array<Record<string, unknown>> };
  return (data.connections ?? []).map((connection) => ({
    app: String(connection.app ?? ""),
    appName: typeof connection.appName === "string" ? connection.appName : undefined,
    appIcon: typeof connection.appIcon === "string" ? connection.appIcon : undefined,
    status: String(connection.status ?? ""),
    accountId: typeof connection.accountId === "string" ? connection.accountId : undefined,
  }));
}

export async function getIntegrationActivity(params: {
  userId?: string;
  userToken?: string;
  apiKey?: string;
  dashboardUrl?: string;
} = {}): Promise<IntegrationActivity[]> {
  const search = new URLSearchParams({ userId: normalizeUserId(params.userId) });
  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolveApiKey(params.apiKey)}`,
    accept: "application/json",
  };
  if (params.userToken) headers["x-evolve-integration-user-token"] = params.userToken;

  const response = await fetch(`${dashboardBaseUrl(params.dashboardUrl)}/api/integrations/activity?${search}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Managed integration activity failed (${response.status}): ${await readError(response)}`);
  }

  const data = await response.json() as { activity?: Array<Record<string, unknown>> };
  return (data.activity ?? []).map((event) => ({
    app: String(event.app ?? ""),
    appName: typeof event.appName === "string" ? event.appName : undefined,
    tool: String(event.tool ?? ""),
    status: String(event.status ?? ""),
    userId: String(event.sdkUserId ?? ""),
    durationMs: typeof event.durationMs === "number" ? event.durationMs : undefined,
    occurredAt: String(event.occurredAt ?? ""),
  }));
}

export const integrationHelpers = {
  connect: connectIntegration,
  status: getIntegrationStatus,
  activity: getIntegrationActivity,
};

export type { IntegrationToolsFilter };
