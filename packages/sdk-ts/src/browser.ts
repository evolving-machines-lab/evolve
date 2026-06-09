import type { ActionbookBrowserConfig, AgentBrowserConfig, BrowserConfig, ManagedBrowserProvider, SkillName } from "./types";
import { DEFAULT_DASHBOARD_URL } from "./constants";

export const ACTIONBOOK_BROWSER_SKILLS: SkillName[] = [
  "actionbook",
  "active-research",
  "extract",
];

export const AGENT_BROWSER_SKILLS: SkillName[] = [
  "agent-browser",
];

const BROWSER_SKILLS: Record<ManagedBrowserProvider, SkillName[]> = {
  actionbook: ACTIONBOOK_BROWSER_SKILLS,
  "agent-browser": AGENT_BROWSER_SKILLS,
};

const AGENT_BROWSER_CONFIG_DIR = "/home/user/.agent-browser";
const AGENT_BROWSER_CONFIG_PATH = `${AGENT_BROWSER_CONFIG_DIR}/config.json`;
const ACTIONBOOK_CONFIG_DIR = "/home/user/.actionbook";
const ACTIONBOOK_CONFIG_PATH = `${ACTIONBOOK_CONFIG_DIR}/config.toml`;

export interface NormalizedBrowserConfig {
  provider: "browser-use" | ManagedBrowserProvider;
  managed: boolean;
  profile?: string;
}

export interface ManagedBrowserConfig {
  provider: ManagedBrowserProvider;
  apiKey: string;
  dashboardUrl?: string;
  profile?: string;
}

export interface ManagedBrowserSession {
  id: string;
  sessionId?: string;
  sessionTag?: string;
  cdpUrl: string;
  liveUrl: string;
  browserAuthGrantToken?: string;
}

export interface ManagedBrowserSandboxSetup {
  envs: Record<string, string>;
  files: Array<{ path: string; data: string }>;
  directories: string[];
}

function isManagedProvider(provider: string): provider is ManagedBrowserProvider {
  return provider === "actionbook" || provider === "agent-browser";
}

function usesManagedRemote(browser: ActionbookBrowserConfig | AgentBrowserConfig): boolean {
  return browser.remote === true;
}

function normalizeProfile(profile: unknown): string | undefined {
  if (profile === undefined || profile === null) return undefined;
  if (typeof profile !== "string") throw new Error("browser profile must be a string");
  const trimmed = profile.trim();
  if (!trimmed) throw new Error("browser profile cannot be empty");
  return trimmed;
}

export function normalizeBrowserConfig(browser: BrowserConfig): NormalizedBrowserConfig {
  if (typeof browser === "string") {
    if (browser === "browser-use") {
      return { provider: "browser-use", managed: false };
    }
    if (isManagedProvider(browser)) {
      return { provider: browser, managed: false };
    }
    throw new Error("Unsupported browser configuration");
  }
  if (browser.provider === undefined) {
    return {
      provider: "agent-browser",
      managed: browser.remote !== false,
      profile: normalizeProfile(browser.profile),
    };
  }
  if (isManagedProvider(browser.provider)) {
    return {
      provider: browser.provider,
      managed: usesManagedRemote(browser),
      profile: normalizeProfile(browser.profile),
    };
  }
  throw new Error("Unsupported browser configuration");
}

export function mergeBrowserSkills(provider: ManagedBrowserProvider, skills?: SkillName[]): SkillName[] {
  return Array.from(new Set([...(skills ?? []), ...BROWSER_SKILLS[provider]]));
}

export function getManagedBrowserSandboxSetup(
  provider: ManagedBrowserProvider,
  session: ManagedBrowserSession
): ManagedBrowserSandboxSetup {
  if (provider === "actionbook") {
    return {
      envs: {},
      files: [
        {
          path: ACTIONBOOK_CONFIG_PATH,
          data: `version = 1\n\n[browser]\nmode = "cloud"\ncdp_endpoint = ${JSON.stringify(session.cdpUrl)}\n`,
        },
      ],
      directories: [ACTIONBOOK_CONFIG_DIR],
    };
  }

  return {
    envs: {
      AGENT_BROWSER_CONFIG: AGENT_BROWSER_CONFIG_PATH,
    },
    files: [
      {
        path: AGENT_BROWSER_CONFIG_PATH,
        data: `${JSON.stringify({
          cdp: session.cdpUrl,
        }, null, 2)}\n`,
      },
    ],
    directories: [AGENT_BROWSER_CONFIG_DIR],
  };
}

function dashboardBaseUrl(config?: ManagedBrowserConfig): string {
  return (config?.dashboardUrl || DEFAULT_DASHBOARD_URL).replace(/\/$/, "");
}

async function readError(response: Response): Promise<string> {
  return await response.text().catch(() => "");
}

export async function createManagedBrowserSession(
  config: ManagedBrowserConfig,
  sessionTag: string,
  options: { browserCredentials?: boolean } = {}
): Promise<ManagedBrowserSession> {
  const response = await fetch(`${dashboardBaseUrl(config)}/api/browser-sessions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      sessionTag,
      options: { remote: true },
      browserAuth: options.browserCredentials === true,
      ...(config.profile ? { profile: config.profile } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) {
    throw new Error(`Managed browser session create failed (${response.status}): ${await readError(response)}`);
  }

  const data = await response.json() as Partial<ManagedBrowserSession>;
  if (!data.id || !data.sessionId || !data.cdpUrl || !data.liveUrl) {
    throw new Error("Managed browser session response missing id, sessionId, cdpUrl, or liveUrl");
  }

  return {
    id: data.id,
    sessionId: data.sessionId,
    sessionTag: data.sessionTag,
    cdpUrl: data.cdpUrl,
    liveUrl: data.liveUrl,
    browserAuthGrantToken: data.browserAuthGrantToken,
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
    signal: AbortSignal.timeout(5_000),
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Managed browser session stop failed (${response.status}): ${await readError(response)}`);
  }
}

export type { ActionbookBrowserConfig, AgentBrowserConfig, BrowserConfig, ManagedBrowserProvider };
