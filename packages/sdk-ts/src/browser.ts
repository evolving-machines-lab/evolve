import type { ActionbookBrowserConfig, BrowserConfig, SkillName } from "./types";
import { DEFAULT_DASHBOARD_URL } from "./constants";

export const ACTIONBOOK_BROWSER_SKILLS: SkillName[] = [
  "actionbook",
  "active-research",
  "extract",
];

export interface NormalizedBrowserConfig {
  provider: "browser-use" | "actionbook";
  managed: boolean;
}

export interface ManagedBrowserConfig {
  apiKey: string;
  dashboardUrl?: string;
}

export interface ManagedBrowserSession {
  id: string;
  cdpUrl: string;
  liveUrl: string;
}

export function normalizeBrowserConfig(browser: BrowserConfig): NormalizedBrowserConfig {
  if (browser === "browser-use") {
    return { provider: "browser-use", managed: false };
  }
  if (browser === "actionbook") {
    return { provider: "actionbook", managed: false };
  }
  if (browser.provider === "actionbook") {
    return { provider: "actionbook", managed: browser.superstealth !== false };
  }
  throw new Error("Unsupported browser configuration");
}

export function mergeActionbookSkills(skills?: SkillName[]): SkillName[] {
  return Array.from(new Set([...(skills ?? []), ...ACTIONBOOK_BROWSER_SKILLS]));
}

function dashboardBaseUrl(config?: ManagedBrowserConfig): string {
  return (config?.dashboardUrl || DEFAULT_DASHBOARD_URL).replace(/\/$/, "");
}

async function readError(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

export async function createManagedBrowserSession(
  config: ManagedBrowserConfig,
  sessionTag: string
): Promise<ManagedBrowserSession> {
  const response = await fetch(`${dashboardBaseUrl(config)}/api/browser-sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      provider: "actionbook",
      sessionTag,
      options: { superstealth: true },
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Managed browser session create failed (${response.status}): ${await readError(response)}`);
  }

  const data = await response.json() as Partial<ManagedBrowserSession>;
  if (!data.id || !data.cdpUrl || !data.liveUrl) {
    throw new Error("Managed browser session response missing id, cdpUrl, or liveUrl");
  }

  return {
    id: data.id,
    cdpUrl: data.cdpUrl,
    liveUrl: data.liveUrl,
  };
}

export async function stopManagedBrowserSession(
  config: ManagedBrowserConfig,
  session: ManagedBrowserSession
): Promise<void> {
  const response = await fetch(`${dashboardBaseUrl(config)}/api/browser-sessions/${encodeURIComponent(session.id)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Managed browser session stop failed (${response.status}): ${await readError(response)}`);
  }
}

export type { ActionbookBrowserConfig, BrowserConfig };
