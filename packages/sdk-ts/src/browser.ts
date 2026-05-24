import type {
  ActionbookBrowserConfig,
  AgentBrowserConfig,
  BrowserConfig,
  ManagedBrowserProvider,
  SessionArtifactInfo,
  SkillName,
} from "./types";
import { DEFAULT_DASHBOARD_URL, DEFAULT_MANAGED_BROWSER_TRANSPORT } from "./constants";

type ManagedBrowserTransport = "managed-a" | "managed-b";
type BrowserConfigWithInternalTransport = (ActionbookBrowserConfig | AgentBrowserConfig) & {
  _managedTransport?: unknown;
};

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

// Dashboard create requests keep the existing managed-browser contract; the
// SDK-level automation provider is tracked separately on ManagedBrowserConfig.
const MANAGED_BROWSER_CREATE_PROVIDER = "actionbook";

export interface NormalizedBrowserConfig {
  provider: "browser-use" | ManagedBrowserProvider;
  managed: boolean;
  _managedTransport?: ManagedBrowserTransport;
}

export interface ManagedBrowserConfig {
  provider: ManagedBrowserProvider;
  _managedTransport: ManagedBrowserTransport;
  apiKey: string;
  dashboardUrl?: string;
}

export interface ManagedBrowserSession {
  id: string;
  sessionId?: string;
  sessionTag?: string;
  cdpUrl: string;
  liveUrl: string;
}

export interface StopManagedBrowserSessionResult {
  artifacts?: SessionArtifactInfo[];
}

export interface ManagedBrowserSandboxSetup {
  envs: Record<string, string>;
  files: Array<{ path: string; data: string }>;
  directories: string[];
}

function isManagedProvider(provider: string): provider is ManagedBrowserProvider {
  return provider === "actionbook" || provider === "agent-browser";
}

function isManagedTransport(transport: string): transport is ManagedBrowserTransport {
  return transport === "managed-a" || transport === "managed-b";
}

function usesManagedRemote(browser: ActionbookBrowserConfig | AgentBrowserConfig): boolean {
  return browser.remote === true;
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
  if (isManagedProvider(browser.provider)) {
    const managed = usesManagedRemote(browser);
    if (!managed) return { provider: browser.provider, managed: false };

    const requestedTransport = (browser as BrowserConfigWithInternalTransport)._managedTransport;
    const transport = requestedTransport === undefined ? DEFAULT_MANAGED_BROWSER_TRANSPORT : requestedTransport;
    if (typeof transport !== "string") {
      throw new Error("Unsupported managed browser transport");
    }
    if (!isManagedTransport(transport)) {
      throw new Error("Unsupported managed browser transport");
    }

    return { provider: browser.provider, managed: true, _managedTransport: transport };
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
      provider: MANAGED_BROWSER_CREATE_PROVIDER,
      sessionTag,
      options: { remote: true, transport: config._managedTransport },
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
    sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
    sessionTag: typeof data.sessionTag === "string" ? data.sessionTag : undefined,
    cdpUrl: data.cdpUrl,
    liveUrl: data.liveUrl,
  };
}

export async function stopManagedBrowserSession(
  config: ManagedBrowserConfig,
  session: ManagedBrowserSession
): Promise<StopManagedBrowserSessionResult> {
  const response = await fetch(`${dashboardBaseUrl(config)}/api/browser-sessions/${encodeURIComponent(session.id)}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(330_000),
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Managed browser session stop failed (${response.status}): ${await readError(response)}`);
  }
  if (response.status === 404) return {};
  const data = await response.json().catch(() => ({})) as Partial<StopManagedBrowserSessionResult>;
  return { artifacts: Array.isArray(data.artifacts) ? data.artifacts : undefined };
}

export type { ActionbookBrowserConfig, AgentBrowserConfig, BrowserConfig, ManagedBrowserProvider };
