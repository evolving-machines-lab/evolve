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

export interface IntegrationAuthParams {
  userId: string;
  app: string;
  alias?: string;
  apiKey?: string;
  dashboardUrl?: string;
}

export interface IntegrationHelperOptions {
  apiKey?: string;
  dashboardUrl?: string;
}

export interface IntegrationAuthResult {
  url: string;
  accountId?: string;
}

export interface IntegrationAccount {
  userId: string;
  app: string;
  appName?: string;
  appIcon?: string;
  alias?: string;
  status: string;
  accountId?: string;
  updatedAt?: string;
}

export interface IntegrationAccountListParams {
  userIds: string[];
  app?: string;
  statuses?: string[];
  apiKey?: string;
  dashboardUrl?: string;
}

export interface IntegrationAccountUpdateParams {
  accountId: string;
  alias?: string;
  apiKey?: string;
  dashboardUrl?: string;
}

export interface IntegrationAccountDeleteParams {
  accountId: string;
  apiKey?: string;
  dashboardUrl?: string;
}

export interface IntegrationAccountUpdateResult {
  success: boolean;
  accountId: string;
  alias?: string;
}

export interface IntegrationAccountDeleteResult {
  success: boolean;
  accountId: string;
}

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
  const normalized = userId?.trim();
  if (!normalized) {
    throw new Error("Integration userId is required; use \"root\" for dashboard-owned accounts");
  }
  return normalized;
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
      apps: normalizeApps(config.apps),
      tools: config.tools,
      accounts: config.accounts,
      keys: config.keys,
      authConfigs: config.authConfigs,
      sessionTag: config.sessionTag,
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

async function createIntegrationAuthLink(params: IntegrationAuthParams): Promise<IntegrationAuthResult> {
  const response = await fetch(`${dashboardBaseUrl(params.dashboardUrl)}/api/integrations/connect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolveApiKey(params.apiKey)}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      userId: normalizeUserId(params.userId),
      app: params.app,
      alias: params.alias,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Managed integration connect failed (${response.status}): ${await readError(response)}`);
  }

  return await response.json() as IntegrationAuthResult;
}

async function listIntegrationAccounts(params: IntegrationAccountListParams): Promise<IntegrationAccount[]> {
  const userIds = Array.from(new Set((params.userIds ?? []).map((userId) => normalizeUserId(userId))));
  if (userIds.length === 0) throw new Error("Integration accounts.list() requires at least one userId");

  const search = new URLSearchParams({ userIds: userIds.join(",") });
  if (params.app) search.set("app", params.app);
  if (params.statuses?.length) search.set("statuses", params.statuses.join(","));
  const headers: Record<string, string> = {
    Authorization: `Bearer ${resolveApiKey(params.apiKey)}`,
    accept: "application/json",
  };

  const response = await fetch(`${dashboardBaseUrl(params.dashboardUrl)}/api/integrations/status?${search}`, {
    headers,
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Managed integration status failed (${response.status}): ${await readError(response)}`);
  }

  const data = await response.json() as { accounts?: Array<Record<string, unknown>> };
  return (data.accounts ?? []).map((connection) => ({
    userId: String(connection.userId ?? ""),
    app: String(connection.app ?? ""),
    appName: typeof connection.appName === "string" ? connection.appName : undefined,
    appIcon: typeof connection.appIcon === "string" ? connection.appIcon : undefined,
    alias: typeof connection.alias === "string" ? connection.alias : undefined,
    status: String(connection.status ?? ""),
    accountId: typeof connection.accountId === "string" ? connection.accountId : undefined,
    updatedAt: typeof connection.updatedAt === "string" ? connection.updatedAt : undefined,
  }));
}

async function updateIntegrationAccount(params: IntegrationAccountUpdateParams): Promise<IntegrationAccountUpdateResult> {
  const response = await fetch(`${dashboardBaseUrl(params.dashboardUrl)}/api/integrations/accounts/update`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolveApiKey(params.apiKey)}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      accountId: params.accountId,
      alias: params.alias,
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Managed integration account update failed (${response.status}): ${await readError(response)}`);
  }

  return await response.json() as IntegrationAccountUpdateResult;
}

async function deleteIntegrationAccount(params: IntegrationAccountDeleteParams): Promise<IntegrationAccountDeleteResult> {
  const response = await fetch(`${dashboardBaseUrl(params.dashboardUrl)}/api/integrations/disconnect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resolveApiKey(params.apiKey)}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ accountId: params.accountId }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Managed integration account delete failed (${response.status}): ${await readError(response)}`);
  }

  return await response.json() as IntegrationAccountDeleteResult;
}

export const integrationHelpers = {
  auth: createIntegrationAuthLink,
  accounts: {
    list: listIntegrationAccounts,
    update: updateIntegrationAccount,
    delete: deleteIntegrationAccount,
  },
};

export type { IntegrationToolsFilter };
