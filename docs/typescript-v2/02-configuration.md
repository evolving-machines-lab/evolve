# Configuration

Sandbox providers, builder methods, skills, and Composio integrations.

---

## Sandbox Providers

Works with both Gateway mode (`EVOLVE_API_KEY`) and BYOK mode (provider API keys). With `EVOLVE_API_KEY` only, sandbox defaults to **E2B**. Add a sandbox provider key to auto-resolve to that provider.

All providers use the `evolve-all` image with pre-installed CLIs.

| Provider | Env Vars | Auto-Resolves When | First Time Setup |
|----------|----------|-------------------|------------------|
| E2B | `E2B_API_KEY` | Default, or `E2B_API_KEY` set | None — instant |
| Modal | `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` | Both Modal vars set | None — auto-builds image on first run (~2 min) |
| Daytona | `DAYTONA_API_KEY` | `DAYTONA_API_KEY` set | None — auto-creates snapshot on first run (~5 min) |

See [assets/README.md](../../assets/README.md) for detailed setup instructions.

### Auto-Resolution

Set env vars and the SDK auto-resolves the provider — no `.withSandbox()` needed:

```bash
# .env — set provider keys alongside your agent key
EVOLVE_API_KEY=sk-...              # or ANTHROPIC_API_KEY for BYOK
MODAL_TOKEN_ID=ak-...             # Auto-resolves to Modal
MODAL_TOKEN_SECRET=as-...
```

```ts
import { Evolve } from "@evolvingmachines/sdk";

// No .withSandbox() needed — SDK picks the right provider from env
const evolve = new Evolve()
    .withAgent({ type: "claude" });

await evolve.run({ prompt: "Hello" });
```

Only use explicit provider creation (below) if you need custom settings like timeout or app name.

### E2B (default)

```ts
import { Evolve, createE2BProvider } from "@evolvingmachines/sdk";

const sandbox = createE2BProvider({
    apiKey: process.env.E2B_API_KEY,    // (optional) Auto-resolves from env
    defaultTimeoutMs: 3600000,           // (optional) Default: 3600000 (1 hour)
    templateId: "my-custom-template",    // (optional) Default: "evolve-all"
});
```

### Modal

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

```ts
import { Evolve, createDaytonaProvider } from "@evolvingmachines/sdk";

const sandbox = createDaytonaProvider({
    apiKey: process.env.DAYTONA_API_KEY,  // (optional) Auto-resolves from env
    apiUrl: "https://app.daytona.io/api", // (optional) Default: https://app.daytona.io/api
    target: "us",                          // (optional) Target region. Default: "us"
    defaultTimeoutMs: 3600000,             // (optional) Default: 3600000 (1 hour)
    snapshotName: "evolve-all",            // (optional) Default: "evolve-all"
});
```

---

## Evolve Builder

Configuration methods grouped by purpose. Chain in any order.

### Agent + Sandbox

```ts
const evolve = new Evolve()
    .withAgent({
        type: "codex",                        // "claude" | "codex" | "gemini" | "qwen" | "kimi" | "opencode"
        model: "gpt-5.2-codex",               // (optional) Uses default if omitted
        reasoningEffort: "medium",            // (optional) Codex only
        apiKey: process.env.EVOLVE_API_KEY!,  // (optional) Auto-resolves from env
    })
    .withSandbox(sandbox)                     // (optional) Auto-resolves from env
```

### Input: Context + Files

```ts
    .withContext({                             // Uploads to /home/user/workspace/context/ on first run
        "docs/readme.txt": "User provided context...",
        "data.json": JSON.stringify({ key: "value" }),
    })
    .withFiles({                              // Uploads to /home/user/workspace/ on first run
        "scripts/setup.sh": "#!/bin/bash\necho hello",
    })
```

### Behavior: Prompt + Schema

```ts
    .withSystemPrompt("You are a careful pair programmer.")
    .withSchema(z.object({                    // Structured output (Zod or JSON Schema)
        summary: z.string(),
        score: z.number(),
    }))
```

### Capabilities: Skills + Composio + MCP

```ts
    .withSkills(["pdf", "docx", "pptx"])      // browser-use included by default
    .withComposio("user_123", {               // 1000+ integrations via Composio
        toolkits: ["github", "gmail"],
    })
    .withMcpServers({                         // MCP servers for agent tools
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
```

### Advanced: Secrets + Storage + Tags

```ts
    .withSecrets({ GITHUB_TOKEN: process.env.GITHUB_TOKEN! })
    .withStorage({ url: "s3://my-bucket/agent-snapshots/" })  // See Storage & Checkpointing
    .withSessionTagPrefix("my-agent")         // Observability prefix
```

**Notes:**
- The sandbox is created on the first `run()` or `executeCommand()` call — see [Runtime](03-runtime.md).
- Context files, workspace files, MCP servers, and system prompt are set up once on the first call.
- Using `.withSession()` to reconnect skips setup since the sandbox already exists.
- `withSchema()` accepts both Zod schemas and JSON Schema objects.

### McpServerConfig

MCP server connection (STDIO or HTTP/SSE):

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

---

## Agent Skills

Skills extend agent capabilities with specialized tools and workflows. See [agentskills.io](https://agentskills.io/home) for the open standard.

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

### Authentication Paths

**1. In-chat auth (default)** — Composio prompts user to authenticate via agent output:
```ts
const evolve = new Evolve()
    .withComposio("user_123");  // Agent prompts "Connect to GitHub" when needed

await evolve.run({ prompt: "Star my favorite repos on GitHub" });
```

**2. API key auth** — Bypass OAuth for tools that support API keys:
```ts
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
// Get OAuth URL for "Connect GitHub" button
const { url } = await Evolve.composio.auth("user_123", "github");
// Render: <a href={url}>Connect GitHub</a>

// Check connection status
const status = await Evolve.composio.status("user_123");
// { github: true, gmail: false, slack: true }

// Check single toolkit
const isGitHubConnected = await Evolve.composio.status("user_123", "github");

// Get detailed connection info (with account IDs)
const connections = await Evolve.composio.connections("user_123");
// [{ toolkit: "github", connected: true, accountId: "ca_..." }, ...]

// Then use in agent (user already connected via UI)
const evolve = new Evolve()
    .withComposio("user_123", { toolkits: ["github"] });

await evolve.run({ prompt: "List my open PRs" });
```

**4. White-label OAuth** — Use custom OAuth configs from [Composio dashboard](https://app.composio.dev):
```ts
const evolve = new Evolve()
    .withComposio("user_123", {
        toolkits: ["github"],
        authConfigs: { github: "ac_your_custom_oauth_app" },
    });

await evolve.run({ prompt: "Create a new private repo" });
```

### Tool Filtering

```ts
const evolve = new Evolve()
    .withComposio("user_123", {
        toolkits: ["github", "gmail", "slack"],
        tools: {
            github: ["github_create_issue", "github_list_repos"],  // Enable only these
            gmail: { disable: ["gmail_delete_email"] },            // Disable dangerous tools
            slack: { tags: ["readOnlyHint"] },                     // Filter by behavior tags
        },
    });
```

### Type Reference

```ts
interface ComposioSetup {
    userId: string,
    config?: ComposioConfig,
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

**Next:** [Runtime](03-runtime.md) for `run()`, streaming, file I/O, and session management.
