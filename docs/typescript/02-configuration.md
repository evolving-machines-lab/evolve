# Configuration

## Sandbox Providers

Works with both Gateway mode (`EVOLVE_API_KEY`) and BYOK mode (provider API keys). With `EVOLVE_API_KEY` only, sandbox defaults to **E2B**. Add a sandbox provider key to auto-resolve to that provider.

All providers use the `evolve-all` image with pre-installed CLIs.

| Provider | Env Vars | Auto-Resolves When | First Time Setup |
|----------|----------|-------------------|------------------|
| E2B | `E2B_API_KEY` | Default, or `E2B_API_KEY` set | None — instant |
| Modal | `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` | Both Modal vars set | None — auto-builds image on first run (~2 min) |
| Daytona | `DAYTONA_API_KEY` | `DAYTONA_API_KEY` set | None — auto-creates snapshot on first run (~5 min) |

See [assets/README.md](https://github.com/evolving-machines-lab/evolve/blob/main/assets/README.md) for detailed setup instructions.

---

### Auto-Resolution

Set env vars and the SDK auto-resolves the provider—no `.withSandbox()` needed:

```bash
# .env - Gateway mode with Modal (auto-resolves to Modal)
EVOLVE_API_KEY=sk-...
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...

# .env - Gateway mode with Daytona (auto-resolves to Daytona)
EVOLVE_API_KEY=sk-...
DAYTONA_API_KEY=...

# .env - BYOK mode with E2B (auto-resolves to E2B)
ANTHROPIC_API_KEY=sk-ant-...
E2B_API_KEY=e2b_...
```

```ts
import { Evolve } from "@evolvingmachines/sdk";

// No .withSandbox() needed — SDK picks the right provider from env
const evolve = new Evolve()
    .withAgent({ type: "claude" });

await evolve.run({ prompt: "Hello" });
```

Only use explicit provider creation (below) if you need custom settings like timeout or app name.

---

### E2B (default)
```bash
# .env - Gateway mode
EVOLVE_API_KEY=sk-...
E2B_API_KEY=e2b_...              # Optional with EVOLVE_API_KEY (auto-resolves)

# .env - BYOK mode
ANTHROPIC_API_KEY=sk-ant-...     # Or OPENAI_API_KEY, GEMINI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN
E2B_API_KEY=e2b_...              # Required in BYOK mode
```

```ts
import { Evolve, createE2BProvider } from "@evolvingmachines/sdk";

const sandbox = createE2BProvider({
    apiKey: process.env.E2B_API_KEY,    // (optional) Auto-resolves from env
    defaultTimeoutMs: 3600000,           // (optional) Default: 3600000 (1 hour)
    templateId: "my-custom-template",    // (optional) E2B template ID. Default: "evolve-all"
});
```

### Modal
```bash
# .env - Gateway mode
EVOLVE_API_KEY=sk-...
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...

# .env - BYOK mode
ANTHROPIC_API_KEY=sk-ant-...     # Or OPENAI_API_KEY, GEMINI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
```

```ts
import { Evolve, createModalProvider } from "@evolvingmachines/sdk";

const sandbox = createModalProvider({
    tokenId: process.env.MODAL_TOKEN_ID,       // (optional) Auto-resolves from env
    tokenSecret: process.env.MODAL_TOKEN_SECRET, // (optional) Auto-resolves from env
    appName: "my-app",                   // (optional) Default: "evolve-sandbox"
    defaultTimeoutMs: 3600000,           // (optional) Default: 3600000 (1 hour)
    endpoint: "https://api.modal.com:443", // (optional) Default: https://api.modal.com:443
    imageName: "evolve-all",             // (optional) Default: "evolve-all"
});
```

### Daytona
```bash
# .env - Gateway mode
EVOLVE_API_KEY=sk-...
DAYTONA_API_KEY=...

# .env - BYOK mode
ANTHROPIC_API_KEY=sk-ant-...     # Or OPENAI_API_KEY, GEMINI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN
DAYTONA_API_KEY=...
```

```ts
import { Evolve, createDaytonaProvider } from "@evolvingmachines/sdk";

const sandbox = createDaytonaProvider({
    apiKey: process.env.DAYTONA_API_KEY,  // (optional) Auto-resolves from env
    apiUrl: "https://app.daytona.io/api", // (optional) Default: https://app.daytona.io/api
    target: "us",                          // (optional) Target region. Default: "us"
    defaultTimeoutMs: 3600000,             // (optional) Default: 3600000 (1 hour) - converted to minutes for auto-stop
    snapshotName: "evolve-all",            // (optional) Default: "evolve-all". Custom snapshots via build.sh daytona
});
```

---

## Evolve Instance

```ts
const evolve = new Evolve()

    // Agent configuration (optional if EVOLVE_API_KEY set, defaults to claude)
    .withAgent({
        type: "codex",                        // "claude" | "codex" | "gemini" | "qwen" | "kimi" | "opencode" | "droid" - defaults to "claude"
        model: "gpt-5.3-codex",               // (optional) Uses default if omitted. Use "sonnet[1m]" / "opus[1m]" for 1M context (Claude only)
        reasoningEffort: "medium",            // (optional) Codex and Droid; valid values vary by model
        apiKey: process.env.EVOLVE_API_KEY!, // (optional) Gateway mode - auto-resolves from env
        // providerApiKey: process.env.ANTHROPIC_API_KEY!, // (optional) Direct mode (BYOK)
        // oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN!, // (optional) Claude Max subscription
    })

    // Sandbox provider (see 2.1 above, or auto-resolves from env)
    .withSandbox(sandbox)

    // (optional) Uploads to /home/user/workspace/context/ on first run
    .withContext({
        "docs/readme.txt": "User provided context...",
        "data.json": JSON.stringify({ key: "value" }),
    })

    // (optional) System prompt appended to default instructions
    .withSystemPrompt("You are a careful pair programmer.")

    // (optional) Schema for structured output (agent writes result.json, validated on getOutputFiles())
    // Accepts Zod schemas or JSON Schema objects
    .withSchema(z.object({
        summary: z.string(),
        score: z.number(),
    }))

    // Or with JSON Schema:
    // .withSchema({
    //     type: "object",
    //     properties: {
    //         summary: { type: "string" },
    //         score: { type: "number" },
    //     },
    //     required: ["summary", "score"],
    // })

    // (optional) Gateway browser automation (.withBrowser() defaults to remote managed agent-browser)
    .withBrowser()

    // (optional) Install plugins/extensions for the selected agent before first run
    .withPlugins({
        marketplace: "https://github.com/org/codex-plugins.git",
        sparse: [".agents/plugins"],
    })

    // (optional) Skills for the agent
    .withSkills(["pdf", "docx", "pptx"])

    // (optional) Managed integrations (gateway mode only)
    .withIntegrations({
        userId: "root",
        apps: ["github", "gmail"],
        tools: {
            github: { enable: ["github_create_issue"] },
            gmail: { disable: ["gmail_delete_email"] },
        },
    })

    // (optional) Prefix for observability logs
    .withSessionTagPrefix("my-agent")

    // (optional) Storage for checkpoint persistence (gateway feature — requires EVOLVE_API_KEY)
    .withStorage()

    // ─── Advanced ───────────────────────────────────────────────────────────────

    // (optional) MCP servers for agent tools
    .withMcpServers({
        exa: {
            command: "npx",
            args: ["-y", "exa-mcp-server"],
            env: { EXA_API_KEY: "..." },
        },
        api: {
            type: "http",
            url: "https://example.com/mcp",
            headers: { "x-api-key": "..." },
        },
    })

    // (optional) Environment variables injected into sandbox
    .withSecrets({
        GITHUB_TOKEN: process.env.GITHUB_TOKEN!
    })

    // (optional) Uploads to /home/user/workspace/ on first run
    .withFiles({
        "scripts/setup.sh": "#!/bin/bash\necho hello",
    });
```

**Note:**
- Configuration methods can be chained in any order.
- The sandbox is created on the first `run()` or `executeCommand()` call (see below).
- Context files, workspace files, MCP servers, and system prompt are set up once on the first call.
- Using `.withSession()` to reconnect skips setup since the sandbox already exists.
- `withSchema()` accepts both Zod schemas and JSON Schema objects.

**McpServerConfig** — MCP server connection (STDIO or HTTP/SSE):

| Fields | Transport |
|--------|-----------|
| `command` | stdio (local subprocess) |
| `url` + `type: "http"` | HTTP (remote) |
| `url` (no type) | SSE (remote, default) |

```ts
interface McpServerConfig {
    type?: "stdio" | "http" | "sse";
    command?: string;  args?: string[];  cwd?: string;   // STDIO
    url?: string;  headers?: Record<string, string>;     // HTTP/SSE
    env?: Record<string, string>;                        // Common
}
```

## Browser Automation

Browser automation is opt-in. Use `.withBrowser()` for browser, QA, dogfooding, and website automation tasks.

```ts
new Evolve().withBrowser(); // managed browser with dashboard live view and replay
```

Evolve automatically configures the browser runtime. In Gateway mode, the managed browser gives you:

- `event.browser.liveUrl` from the `browser_ready` lifecycle event
- `result.browser?.liveUrl` after `run()` returns
- `result.sessionId`, which is the id to use for traces and browser replay
- `sessions().browserReplay(sessionId)`, which returns replay and raw `.mp4` download URLs after cleanup
- `replay.suggestedStartSeconds`, when present, which is the recommended replay start time in seconds
- `replay.sizeBytes` and `replay.readyAt`, when present, which describe the raw recording size and replay readiness time

`remote` controls where the browser session runs:

- `.withBrowser()` uses `remote: true` by default. Evolve creates and manages a cloud browser session, wires it into the sandbox, and exposes dashboard live view plus replay.
- `remote: false` runs browser automation locally inside the sandbox. Use it only when you do not need managed live view or replay.

Use the default unless you have a reason not to:

```ts
new Evolve().withBrowser();
// recommended: managed remote browser

new Evolve().withBrowser({
    provider: "agent-browser",
    remote: false,
});
// local agent-browser, no managed live/replay
```

To disable browser automation, omit `.withBrowser()`.

Full browser run with live view and replay:

```ts
import { Evolve, sessions } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withBrowser()
    .withSessionTagPrefix("checkout-qa");

let sessionId: string | undefined;

evolve.on("lifecycle", (event) => {
    if (event.reason === "browser_ready" && event.browser) {
        showLiveBrowser(event.browser.liveUrl);
        sessionId = event.browser.sessionId;
    }
});

try {
    const result = await evolve.run({
        prompt: "Open the app, test the checkout flow, and report issues.",
    });

    sessionId = result.sessionId ?? sessionId;
    if (result.browser?.liveUrl) {
        showLiveBrowser(result.browser.liveUrl);
    }
} finally {
    await evolve.kill();
}

if (!sessionId) throw new Error("Missing dashboard session id");

const replay = await sessions().browserReplay(sessionId, {
    timeoutMs: 600_000,
    intervalMs: 5_000,
});

showReplay(replay.replayUrl);
saveDownloadLink(replay.downloadUrl);
setReplayStartTime(replay.suggestedStartSeconds ?? 0);
showReplayMetadata({
    sizeBytes: replay.sizeBytes,
    readyAt: replay.readyAt,
});
```

Replay processing starts when the managed browser is cleaned up, usually during `kill()`.
If replay is not ready before `timeoutMs`, call `browserReplay()` again later with the same `sessionId`.
The `replayUrl` already applies `suggestedStartSeconds`; use the field separately only if your UI needs to display or store the recommended start time.
The `status` is `"ready"` once `browserReplay()` returns.

## Browser Credentials

Browser credentials let managed remote `agent-browser` runs sign in with saved website logins without exposing passwords to the agent.

Availability:

- Requires Gateway mode and managed remote `agent-browser`.
- `.withBrowser()` uses that recommended remote setup by default.
- Not available with `browser-use`, `actionbook`, `remote: false`, direct/BYOK provider mode, or `.withSession()`.

Dashboard setup:

1. Open the Evolve Dashboard.
2. Go to **Secrets**.
3. Add a browser login with `Account label`, `Website`, `Email`, and `Password`.
4. Use `Website` for the domain, such as `github.com`; use `Account label` as one word with no spaces, such as `qa-admin`, `work`, or `personal`, to distinguish multiple saved accounts for the same website. It is not the website username or email.

Passwords are encrypted before upload. The dashboard and SDK list only login metadata: account label, website, email, and last-used time.

Expose saved logins to a run:

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withBrowser()
    .withBrowserCredentials({
        allow: [{ website: "github.com", accountLabel: "qa-admin" }],
    });

await evolve.run({
    prompt: "Open GitHub, sign in with the saved qa-admin login, and verify the repository settings page.",
});

await evolve.kill();
```

If `allow` is omitted, all enabled browser logins for the Evolve account are available to that run:

```ts
const evolve = new Evolve()
    .withBrowser()
    .withBrowserCredentials();
```

The agent receives a run-scoped `browser-login` MCP server with these tools:

- `browser_list_logins` returns website, account_label, and email metadata only.
- `browser_login` fills and submits a saved login on the current sign-in tab without returning the password.
- `browser_complete_signup` completes password-based signup after the agent has filled non-secret fields, then saves the generated login for future `browser_login` calls.

Manage browser logins from the SDK:

```ts
import { Evolve } from "@evolvingmachines/sdk";

const credentials = Evolve.browserCredentials();

await credentials.create({
    website: "github.com",
    accountLabel: "qa-admin",
    email: "qualityassurance@example.com",
    password: process.env.QA_GITHUB_PASSWORD!,
});

const page = await credentials.list({ website: "github.com" });

await credentials.delete({
    website: "github.com",
    accountLabel: "qa-admin",
});
```

## Agent Plugins

`.withPlugins()` installs plugins/extensions into the sandbox user profile before the first agent command. The currently selected agent determines the accepted shape:

```ts
// droid
.withPlugins({
    marketplace: "https://github.com/Factory-AI/factory-plugins",
    plugin: "droid-control@factory-plugins",
})

// claude
.withPlugins({
    marketplace: "anthropics/claude-code",
    plugin: "commit-commands@anthropics-claude-code",
})

// gemini
.withPlugins({
    source: "https://github.com/org/gemini-extension",
    ref: "main",
})

// codex marketplace registration
.withPlugins({
    marketplace: "https://github.com/org/codex-plugins.git",
    sparse: [".agents/plugins"],
})
```

If `.withAgent()` is omitted, plugins target the default agent (`claude`).

## Agent Skills

Skills extend agent capabilities with specialized tools and workflows. See [agentskills.io](https://agentskills.io/home) for the open standard.

```bash
# .env
EVOLVE_API_KEY=sk-...
```

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withSkills(["pptx"]);

await evolve.run({ prompt: "Create a slide deck summarizing the uploaded notes." });
```

### Documents
| Skill | Description | Source |
|-------|-------------|--------|
| `pdf` | Read, extract, and analyze PDF documents | [skills/pdf](https://github.com/evolving-machines-lab/evolve/tree/main/skills/pdf) |
| `docx` | Create and edit Word documents | [skills/docx](https://github.com/evolving-machines-lab/evolve/tree/main/skills/docx) |
| `pptx` | Create and edit PowerPoint presentations | [skills/pptx](https://github.com/evolving-machines-lab/evolve/tree/main/skills/pptx) |
| `xlsx` | Create and edit Excel spreadsheets | [skills/xlsx](https://github.com/evolving-machines-lab/evolve/tree/main/skills/xlsx) |

### Research & Analysis
| Skill | Description | Source |
|-------|-------------|--------|
| `content-research-writer` | Research and write content | [skills/content-research-writer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/content-research-writer) |
| `lead-research-assistant` | Research and qualify leads | [skills/lead-research-assistant](https://github.com/evolving-machines-lab/evolve/tree/main/skills/lead-research-assistant) |
| `meeting-insights-analyzer` | Analyze meeting insights | [skills/meeting-insights-analyzer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/meeting-insights-analyzer) |
| `developer-growth-analysis` | Analyze developer growth metrics | [skills/developer-growth-analysis](https://github.com/evolving-machines-lab/evolve/tree/main/skills/developer-growth-analysis) |
| `competitive-ads-extractor` | Extract and analyze competitor ads | [skills/competitive-ads-extractor](https://github.com/evolving-machines-lab/evolve/tree/main/skills/competitive-ads-extractor) |

### Design & Media
| Skill | Description | Source |
|-------|-------------|--------|
| `canvas-design` | Canvas and design creation | [skills/canvas-design](https://github.com/evolving-machines-lab/evolve/tree/main/skills/canvas-design) |
| `image-enhancer` | Enhance and process images | [skills/image-enhancer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/image-enhancer) |
| `theme-factory` | Create themes and styles | [skills/theme-factory](https://github.com/evolving-machines-lab/evolve/tree/main/skills/theme-factory) |
| `video-downloader` | Download videos from URLs | [skills/video-downloader](https://github.com/evolving-machines-lab/evolve/tree/main/skills/video-downloader) |
| `slack-gif-creator` | Create GIFs for Slack | [skills/slack-gif-creator](https://github.com/evolving-machines-lab/evolve/tree/main/skills/slack-gif-creator) |

### Business & Productivity
| Skill | Description | Source |
|-------|-------------|--------|
| `file-organizer` | Organize files and directories | [skills/file-organizer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/file-organizer) |
| `invoice-organizer` | Organize and process invoices | [skills/invoice-organizer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/invoice-organizer) |
| `brand-guidelines` | Brand asset and guidelines management | [skills/brand-guidelines](https://github.com/evolving-machines-lab/evolve/tree/main/skills/brand-guidelines) |
| `internal-comms` | Internal communications tools | [skills/internal-comms](https://github.com/evolving-machines-lab/evolve/tree/main/skills/internal-comms) |
| `tailored-resume-generator` | Generate tailored resumes | [skills/tailored-resume-generator](https://github.com/evolving-machines-lab/evolve/tree/main/skills/tailored-resume-generator) |
| `domain-name-brainstormer` | Brainstorm domain names | [skills/domain-name-brainstormer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/domain-name-brainstormer) |

### Development
| Skill | Description | Source |
|-------|-------------|--------|
| `mcp-builder` | Build MCP servers | [skills/mcp-builder](https://github.com/evolving-machines-lab/evolve/tree/main/skills/mcp-builder) |
| `skill-creator` | Create new skills | [skills/skill-creator](https://github.com/evolving-machines-lab/evolve/tree/main/skills/skill-creator) |
| `skill-share` | Share skills with others | [skills/skill-share](https://github.com/evolving-machines-lab/evolve/tree/main/skills/skill-share) |
| `changelog-generator` | Generate changelogs from commits | [skills/changelog-generator](https://github.com/evolving-machines-lab/evolve/tree/main/skills/changelog-generator) |
| `artifacts-builder` | Build artifacts and deliverables | [skills/artifacts-builder](https://github.com/evolving-machines-lab/evolve/tree/main/skills/artifacts-builder) |

### Other
| Skill | Description | Source |
|-------|-------------|--------|
| `raffle-winner-picker` | Pick raffle winners randomly | [skills/raffle-winner-picker](https://github.com/evolving-machines-lab/evolve/tree/main/skills/raffle-winner-picker) |

---

## Managed Integrations

Managed integrations are available only in gateway mode (`EVOLVE_API_KEY`); integration credentials stay server-side and agents receive an Evolve-scoped MCP proxy.

Available apps:

| `apps` value | App | What agents can do |
| --- | --- | --- |
| `gmail` | Gmail | Read, search, draft, and send email. |
| `agent_mail` | Agent Mail | Use an agent inbox to send, receive, and act on email. |
| `slack` | Slack | Search channels, read conversations, and send team messages. |
| `github` | GitHub | Work with repositories, issues, pull requests, and code. |
| `googlecalendar` | Google Calendar | Read and manage calendar events. |
| `notion` | Notion | Read and update pages, databases, docs, and workspace content. |
| `linear` | Linear | Read and manage issues, teams, projects, and comments. |

```bash
# .env
EVOLVE_API_KEY=sk-...
```

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withIntegrations({
        userId: "customer_123",
        apps: ["github", "gmail"],
        tools: {
            github: ["github_create_issue", "github_list_repos"],
            gmail: { disable: ["gmail_delete_email"] },
        },
    });

await evolve.run({ prompt: "Create a GitHub issue for the login bug" });
```

### Root vs SDK Users

Use `userId: "root"` for accounts connected in the Evolve dashboard for private agents and test accounts.

For an application with end users, pass your stable SDK user ID. Evolve namespaces that ID under the authenticated Evolve account before creating private integration sessions.

```ts
const link = await Evolve.integrations.auth({
    userId: "customer_123",
    app: "gmail",
    accountLabel: "work",
});

// Show link.url to the user.
const evolve = new Evolve()
    .withIntegrations({
        userId: "customer_123",
        apps: ["gmail"],
    });
```

### Account Helpers

```ts
const accounts = await Evolve.integrations.accounts.list({
    userIds: ["customer_123"],
    app: "gmail",
    statuses: ["ACTIVE"],
});

await Evolve.integrations.accounts.update({
    accountId: "account_id_from_list",
    accountLabel: "work",
});

// If the user connected multiple Gmail accounts, choose an account label or account ID returned by accounts.list().
const evolve = new Evolve()
    .withIntegrations({
        userId: "customer_123",
        apps: ["gmail"],
        accounts: { gmail: ["work"] },
    });

// Disconnect by account ID.
await Evolve.integrations.accounts.delete({ accountId: "account_id_from_list" });
```

### Custom Auth Configs and API Keys

Use `authConfigs` to select a custom auth config for an app. For apps with an API-key auth config, pass the matching key in `keys`; Evolve creates the connected account server-side and does not store the raw key in the session.

```ts
const evolve = new Evolve()
    .withIntegrations({
        userId: "customer_123",
        apps: ["github"],
        authConfigs: { github: "ac_custom_github" },
        keys: { github: process.env.GITHUB_TOKEN! },
    });
```

### Type Reference

```ts
interface IntegrationsSetup {
    userId: string;            // "root" or your stable SDK user ID
    apps: string[];
    tools?: Record<string, IntegrationToolsFilter>;
    accounts?: Record<string, string[]>; // app -> account labels or account IDs
    authConfigs?: Record<string, string>; // app -> custom auth config ID
    keys?: Record<string, string>;        // app -> API key, requires authConfigs[app]
}

type IntegrationToolsFilter =
    | string[]
    | { enable: string[] }
    | { disable: string[] }
    | { tags: string[] };
```

---
