# Configuration

## Sandbox Providers

Works with both Gateway mode (`EVOLVE_API_KEY`) and BYOK mode (provider API keys). With `EVOLVE_API_KEY` only, sandbox defaults to **E2B**. Add a sandbox provider key to auto-resolve to that provider.

All providers use the `evolve-all` image with pre-installed CLIs.

| Provider | Env Vars | Auto-Resolves When | First Time Setup |
|----------|----------|-------------------|------------------|
| E2B | `E2B_API_KEY` | Default, or `E2B_API_KEY` set | None — instant |
| Modal | `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` | Both Modal vars set | None — auto-builds image on first run (~2 min) |
| Daytona | `DAYTONA_API_KEY` | `DAYTONA_API_KEY` set | None — auto-creates snapshot on first run (~5 min) |

See [assets/README.md](../../assets/README.md) for detailed setup instructions.

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
        type: "codex",                        // "claude" | "codex" | "gemini" | "qwen" | "kimi" | "opencode" - defaults to "claude"
        model: "gpt-5.2-codex",               // (optional) Uses default if omitted. Use "sonnet[1m]" / "opus[1m]" for 1M context (Claude only)
        reasoningEffort: "medium",            // (optional) "low" | "medium" | "high" | "xhigh" - Codex only
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

    // (optional) Skills for the agent (browser-use included by default)
    .withSkills(["pdf", "docx", "pptx"])

    // (optional) Composio Tool Router for 1000+ integrations (GitHub, Gmail, Slack, etc.)
    .withComposio("user_123", {
        toolkits: ["github", "gmail"],                    // Restrict to specific toolkits
        tools: {                                          // Per-toolkit tool filtering
            github: ["github_create_issue"],              // Enable specific tools
            gmail: { disable: ["gmail_delete_email"] },   // Disable specific tools
        },
        keys: { stripe: "sk_live_..." },                  // API keys for direct auth (bypasses OAuth)
        authConfigs: { github: "ac_custom_oauth" },       // Custom OAuth configs (white-labeling)
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

## Agent Skills

Skills extend agent capabilities with specialized tools and workflows. See [agentskills.io](https://agentskills.io/home) for the open standard.

```bash
# .env
EVOLVE_API_KEY=sk-...
COMPOSIO_API_KEY=...
```

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withSkills(["pptx"]);  // browser-use included by default

await evolve.run({ prompt: "Browse Hacker News top 5 articles and create a slide deck summarizing each" });
```

### Documents
| Skill | Description | Source |
|-------|-------------|--------|
| `pdf` | Read, extract, and analyze PDF documents | [skills/pdf](https://github.com/evolving-machines-lab/evolve/tree/main/skills/pdf) |
| `docx` | Create and edit Word documents | [skills/docx](https://github.com/evolving-machines-lab/evolve/tree/main/skills/docx) |
| `pptx` | Create and edit PowerPoint presentations | [skills/pptx](https://github.com/evolving-machines-lab/evolve/tree/main/skills/pptx) |
| `xlsx` | Create and edit Excel spreadsheets | [skills/xlsx](https://github.com/evolving-machines-lab/evolve/tree/main/skills/xlsx) |

### Browser Automation

> **Note:** `browser-use` is included by default with Gateway mode (when using `EVOLVE_API_KEY`). These skills provide additional browser capabilities.

| Skill | Description | Source |
|-------|-------------|--------|
| `agent-browser` | CLI-based headless browser automation for AI agents | [skills/agent-browser](https://github.com/evolving-machines-lab/evolve/tree/main/skills/agent-browser) |
| `dev-browser` | Browser automation with persistent page state | [skills/dev-browser](https://github.com/evolving-machines-lab/evolve/tree/main/skills/dev-browser) |
| `webapp-testing` | Test web applications | [skills/webapp-testing](https://github.com/evolving-machines-lab/evolve/tree/main/skills/webapp-testing) |

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

## Composio (Tool Router)

Access 1000+ integrations (GitHub, Gmail, Slack, etc.) via [Composio](https://composio.dev).

[Tool Router Overview](https://docs.composio.dev/tool-router/overview) — How Tool Router works and integration guide.

[Available Toolkits](https://docs.composio.dev/toolkits/introduction) — Browse all 1000+ supported integrations.

```bash
# .env
EVOLVE_API_KEY=sk-...      # Evolve gateway key
COMPOSIO_API_KEY=...         # Get from https://app.composio.dev
```

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withComposio("user_123");  // All tools, in-chat OAuth

await evolve.run({ prompt: "Create a GitHub issue for the login bug" });
```

### Authentication Paths

**1. In-chat auth (default)** — Composio prompts user to authenticate via agent output:
```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withComposio("user_123");  // Agent prompts "Connect to GitHub" when needed

await evolve.run({ prompt: "Star my favorite repos on GitHub" });
```

**2. API key auth** — Bypass OAuth for tools that support API keys:
```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withComposio("user_123", {
        toolkits: ["stripe", "sendgrid"],
        keys: {
            stripe: process.env.STRIPE_API_KEY!,
            sendgrid: process.env.SENDGRID_API_KEY!,
        },
    });

await evolve.run({ prompt: "List my recent Stripe payments" });
```

**3. Manual OAuth (app UI)** — Get OAuth URL to show in your settings page:
```ts
import { Evolve } from "@evolvingmachines/sdk";

// Get OAuth URL for "Connect GitHub" button
const { url } = await Evolve.composio.auth("user_123", "github");
// Render: <a href={url}>Connect GitHub</a>

// Check connection status (simple)
const status = await Evolve.composio.status("user_123");
// { github: true, gmail: false, slack: true }

// Check single toolkit
const isGitHubConnected = await Evolve.composio.status("user_123", "github");
// true | false

// Get detailed connection info (with account IDs)
const connections = await Evolve.composio.connections("user_123");
// [{ toolkit: "github", connected: true, accountId: "ca_..." }, ...]

// Then use in agent (user already connected via UI)
const evolve = new Evolve()
    .withComposio("user_123", {
        toolkits: ["github"],
    });

await evolve.run({ prompt: "List my open PRs" });
```

**4. White-label OAuth** — Use custom OAuth configs from [Composio dashboard](https://app.composio.dev):
```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withComposio("user_123", {
        toolkits: ["github"],
        authConfigs: { github: "ac_your_custom_oauth_app" },
    });

await evolve.run({ prompt: "Create a new private repo" });
```

### Tool Filtering

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withComposio("user_123", {
        toolkits: ["github", "gmail", "slack"],
        tools: {
            github: ["github_create_issue", "github_list_repos"],  // Enable only these
            gmail: { disable: ["gmail_delete_email"] },            // Disable dangerous tools
            slack: { tags: ["readOnlyHint"] },                     // Filter by behavior tags
        },
    });

await evolve.run({ prompt: "Send a Slack message about the GitHub issue" });
```

### Type Reference

**ComposioSetup** — configuration for `.withComposio(userId, config?)`:
```ts
interface ComposioSetup {
    userId: string,                                         // User's unique identifier
    config?: ComposioConfig,                                // Optional configuration
}

interface ComposioConfig {
    toolkits?: string[],                                    // e.g. ["gmail", "notion", "stripe"]
    tools?: Record<string, ToolsFilter>,                    // Per-toolkit tool filtering
    keys?: Record<string, string>,                          // API keys (bypasses OAuth)
    authConfigs?: Record<string, string>,                   // Custom OAuth auth config IDs
}

type ToolsFilter =
    | string[]                                              // Enable only these tools
    | { enable: string[] }                                  // Enable only these tools
    | { disable: string[] }                                 // Disable these tools
    | { tags: string[] };                                   // Filter by behavior tags
```

---
