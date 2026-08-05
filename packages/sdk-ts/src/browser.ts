import { stringify as stringifyToml } from "smol-toml";
import type { ActionbookBrowserConfig, AgentBrowserConfig, BrowserConfig, ManagedBrowserProvider } from "./types";
import { DEFAULT_DASHBOARD_URL } from "./constants";

// NOTE: the old baked-in browser skill catalog ("actionbook", "agent-browser",
// "active-research", "extract") is gone with the repo skills/ catalog. Browser
// TRANSPORT (CDP wiring, config files, prompts) is unaffected; agents that
// want instruction skills for their browser tooling name them explicitly via
// .withSkills() with real references (skills.sh / git / local folder).

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

export function getManagedBrowserSandboxSetup(
  provider: ManagedBrowserProvider,
  session: ManagedBrowserSession
): ManagedBrowserSandboxSetup {
  if (provider === "actionbook") {
    return {
      envs: {},
      files: [
        {
          // Serialized by smol-toml like every other TOML the SDK writes — a
          // hand-built template cannot be trusted to escape a CDP URL.
          path: ACTIONBOOK_CONFIG_PATH,
          data:
            stringifyToml({
              version: 1,
              browser: { mode: "cloud", cdp_endpoint: session.cdpUrl },
            }).trimEnd() + "\n",
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
