# Evolve TypeScript SDK

Run terminal-based AI agents in secure sandboxes with built-in observability.

> See the [main README](../README.md) for installation and API keys.

---

## 1. Quick Start

```bash
# .env

# Evolve gateway key (dashboard.evolvingmachines.ai)
EVOLVE_API_KEY=sk-...

# Composio integrations (app.composio.dev)
COMPOSIO_API_KEY=...
```

Evolve auto-resolves API keys from environment variables.

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withAgent({
        apiKey: process.env.EVOLVE_API_KEY!,
    })
    .withSessionTagPrefix("my-app") // optional tag for the agent session
    .withSystemPrompt("You are Manus Evolve, a powerful AI agent. You can execute code, browse the web, manage files, and solve complex tasks.")
    .withSkills(["pdf", "docx", "pptx"])  // browser-use included by default
    .withComposio("user_123", { toolkits: ["gmail", "notion", "exa"] });  // 1000+ integrations via Composio

// Run agent
const result = await evolve.run({
    prompt: "Go to Hacker News top posts. Spawn 5 parallel sub-agents to screenshot each of the top 5 posts."
});

console.log(result.stdout);

// Get output files
const output = await evolve.getOutputFiles();
for (const [name, content] of Object.entries(output.files)) {
    console.log(name);
}

// Once done, destroy sandbox
await evolve.kill();
```

## Gateway Features

When using `EVOLVE_API_KEY`:

- **Tracing:** Automatic tracing and agent analytics at [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) for observability and replay—no extra setup needed. Use `withSessionTagPrefix()` to label sessions for easy filtering.
- **Browser Automation:** `browser-use` integration included—agents can browse the web, take screenshots, fill forms, and interact with pages out of the box.

---

## 1.1 Authentication

| | Gateway Mode | BYOK Mode |
|---|---------|---------------|
| Setup | `EVOLVE_API_KEY` | [Model provider keys](#113-agent-reference) + [`E2B_API_KEY`](https://e2b.dev) |
| Observability | [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) | `~/.evolve-sdk/observability/` |
| Browser | `browser-use` integrated | Via skills or MCP |
| Billing | Evolving Machines | Your provider accounts |

---

### 1.1.1 Gateway Mode (EVOLVE_API_KEY)

Get API key from [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai).

```bash
# .env
EVOLVE_API_KEY=sk-...
```

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withAgent({
        type: "claude",
        apiKey: process.env.EVOLVE_API_KEY,
    });

await evolve.run({ prompt: "Hello" });
```

---

### 1.1.2 BYOK Mode

Use your own provider keys. Requires [E2B API key](https://e2b.dev) for sandbox.

```bash
# .env
ANTHROPIC_API_KEY=sk-...
E2B_API_KEY=e2b_...
```

```ts
import { Evolve, createE2BProvider } from "@evolvingmachines/sdk";

const sandbox = createE2BProvider({
    apiKey: process.env.E2B_API_KEY,
});

const evolve = new Evolve()
    .withAgent({
        type: "claude",
        providerApiKey: process.env.ANTHROPIC_API_KEY,
    })
    .withSandbox(sandbox);
```

### BYO Claude Max Subscription

```bash
# Run in terminal, follow login steps → receive token:
claude --setup-token

# ✓ Long-lived authentication token created successfully!
# Your OAuth token (valid for 1 year): sk-ant-...
```

```bash
# .env
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-...
E2B_API_KEY=e2b_...
```

```ts
import { Evolve, createE2BProvider } from "@evolvingmachines/sdk";

const sandbox = createE2BProvider({
    apiKey: process.env.E2B_API_KEY,
});

const evolve = new Evolve()
    .withAgent({
        type: "claude",
        oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN,
    })
    .withSandbox(sandbox);
```

---

### 1.1.3 Agent Reference

Set env vars and the SDK picks them up automatically—no need to pass explicitly.

| type | models | default | env var (BYOK) |
|------|--------|---------|----------------|
| `"claude"` | `"opus"` `"sonnet"` `"haiku"` | `"opus"` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |
| `"codex"` | `"gpt-5.2"` `"gpt-5.2-codex"` `"gpt-5.1-codex-max"` `"gpt-5.1-mini"` | `"gpt-5.2"` | `OPENAI_API_KEY` |
| `"gemini"` | `"gemini-3-pro-preview"` `"gemini-3-flash-preview"` `"gemini-2.5-pro"` `"gemini-2.5-flash"` `"gemini-2.5-flash-lite"` | `"gemini-3-flash-preview"` | `GEMINI_API_KEY` |
| `"qwen"` | `"qwen3-coder-plus"` `"qwen3-vl-plus"` | `"qwen3-coder-plus"` | `OPENAI_API_KEY` |

Agent-specific options: `reasoningEffort` (Codex: `"low"` `"medium"` `"high"` `"xhigh"`), `betas` (Claude Sonnet: `["context-1m-2025-08-07"]`)

### Agent Examples

```bash
# .env - set env vars for auto-pickup
ANTHROPIC_API_KEY=sk-...   # claude
OPENAI_API_KEY=sk-...      # codex, qwen
GEMINI_API_KEY=...         # gemini
E2B_API_KEY=e2b_...        # sandbox
```

```ts
// claude (auto-picks ANTHROPIC_API_KEY + E2B_API_KEY)
const evolve = new Evolve()
    .withAgent({ type: "claude" });

const evolve = new Evolve()
    .withAgent({ type: "claude", model: "opus" });

const evolve = new Evolve()
    .withAgent({
        type: "claude",
        model: "sonnet",
        betas: ["context-1m-2025-08-07"],
    });
```

```ts
// codex (auto-picks OPENAI_API_KEY + E2B_API_KEY)
const evolve = new Evolve()
    .withAgent({ type: "codex" });

const evolve = new Evolve()
    .withAgent({ type: "codex", model: "gpt-5.2-codex" });

const evolve = new Evolve()
    .withAgent({ type: "codex", reasoningEffort: "high" });
```

```ts
// gemini (auto-picks GEMINI_API_KEY + E2B_API_KEY)
const evolve = new Evolve()
    .withAgent({ type: "gemini" });

const evolve = new Evolve()
    .withAgent({ type: "gemini", model: "gemini-3-pro-preview" });
```

```ts
// qwen (auto-picks OPENAI_API_KEY + E2B_API_KEY)
const evolve = new Evolve()
    .withAgent({ type: "qwen" });

const evolve = new Evolve()
    .withAgent({ type: "qwen", model: "qwen3-coder-plus" });
```

---

## 2. Full Configuration

### 2.1 Sandbox Providers

With `EVOLVE_API_KEY` only, sandbox defaults to **E2B**. Add a provider key to auto-resolve to that provider:

| Provider | Env Vars | Auto-Resolves When |
|----------|----------|-------------------|
| E2B | `E2B_API_KEY` | Default, or `E2B_API_KEY` set |
| Modal | `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` | Both Modal vars set |
| Daytona | `DAYTONA_API_KEY` | `DAYTONA_API_KEY` set |

**E2B** (default)
```bash
# .env
EVOLVE_API_KEY=sk-...
E2B_API_KEY=e2b_...        # Optional with EVOLVE_API_KEY (auto-resolves)
```

```ts
import { Evolve, createE2BProvider } from "@evolvingmachines/sdk";

const sandbox = createE2BProvider({
    apiKey: process.env.E2B_API_KEY,    // (optional) Auto-resolves from env
    defaultTimeoutMs: 3600000,           // (optional) Sandbox lifetime (default: 1 hour)
});
```

**Modal**
```bash
# .env
EVOLVE_API_KEY=sk-...
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
```

```ts
import { Evolve, createModalProvider } from "@evolvingmachines/sdk";

const sandbox = createModalProvider({
    appName: "evolve-sandbox",           // (optional) Default: "evolve-sandbox"
    defaultTimeoutMs: 3600000,           // (optional) Default: 3600000 (1 hour)
});
```

**Daytona**
```bash
# .env
EVOLVE_API_KEY=sk-...
DAYTONA_API_KEY=...
```

```ts
import { Evolve, createDaytonaProvider } from "@evolvingmachines/sdk";

const sandbox = createDaytonaProvider({
    apiKey: process.env.DAYTONA_API_KEY,  // (optional) Auto-resolves from env
    apiUrl: "https://app.daytona.io/api", // (optional) Default: "https://app.daytona.io/api"
    target: "us",                          // (optional) Default: "us"
    defaultTimeoutMs: 3600000,             // (optional) Default: 3600000 (1 hour)
});
```

---

### 2.2 Evolve Instance

```ts
const evolve = new Evolve()

    // Agent configuration (optional if EVOLVE_API_KEY set, defaults to claude)
    .withAgent({
        type: "codex",                        // "claude" | "codex" | "gemini" | "qwen" - defaults to "claude"
        model: "gpt-5.2-codex",               // (optional) Uses default if omitted
        reasoningEffort: "medium",            // (optional) "low" | "medium" | "high" | "xhigh" - Codex only
        // betas: ["context-1m-2025-08-07"],  // (optional) Claude Sonnet only
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

## 3. Runtime Methods

All runtime calls are `async` and return a shared `AgentResponse`:

```ts
type AgentResponse = {
  sandboxId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
};
```

### 3.1 run

Runs the agent with a given prompt. 

```ts
const result = await evolve.run({
    prompt: "Analyze the data and create a report",
    timeoutMs: 15 * 60 * 1000,                // (optional) Default 1 hour
    background: false,                         // (optional) Run in background
});

console.log(result.exitCode);
console.log(result.stdout);
```

- If `timeoutMs` is omitted the agent uses the TypeScript default of 3_600_000 ms (1 hour).
- If `background` is `true`, the call returns immediately while the agent continues running.

- Calling `run()` multiple times maintains the agent context / history. 

### 3.2 executeCommand

Runs a direct shell command in the sandbox working directory.

```ts
// Run shell command directly in sandbox
const result = await evolve.executeCommand("pytest", {
    timeoutMs: 10 * 60 * 1000,                // (optional) Default 1 hour
    background: false,                         // (optional) Run in background
});
```

### 3.3 Streaming Events

`Evolve` extends Node's `EventEmitter`. Subscribe to real-time output from `run()` and `executeCommand()`:

```typescript
import { Evolve } from "@evolvingmachines/sdk";
import type { OutputEvent } from "@evolvingmachines/sdk";

const evolve = new Evolve().withAgent({ type: "claude" });

// Parsed events (recommended)
evolve.on("content", (event: OutputEvent) => {
  console.log(event.update.sessionUpdate, event.update);
});

// Raw output (debugging)
evolve.on("stdout", (chunk: string) => process.stdout.write(chunk));
evolve.on("stderr", (chunk: string) => process.stderr.write(chunk));

await evolve.run({ prompt: "Hello" });
```

| Event | Type | Description |
|-------|------|-------------|
| `content` | `OutputEvent` | Parsed ACP-style events (recommended) |
| `stdout` | `string` | Raw JSONL output |
| `stderr` | `string` | Error output |

---

### OutputEvent

Top-level event structure:

```typescript
interface OutputEvent {
  sessionId?: string;
  update: SessionUpdate;
}
```

---

### SessionUpdate Types

Discriminated union on `sessionUpdate` field:

```typescript
type SessionUpdate =
  | AgentMessageChunk
  | AgentThoughtChunk
  | UserMessageChunk
  | ToolCall
  | ToolCallUpdate
  | Plan;
```

#### Message Events

| Type | `sessionUpdate` | Description |
|------|-----------------|-------------|
| `AgentMessageChunk` | `"agent_message_chunk"` | Text/image streaming from agent |
| `AgentThoughtChunk` | `"agent_thought_chunk"` | Reasoning (Codex) or thinking (Claude) |
| `UserMessageChunk` | `"user_message_chunk"` | User message echo (Gemini) |

```typescript
interface AgentMessageChunk {
  sessionUpdate: "agent_message_chunk";
  content: ContentBlock;
}

interface AgentThoughtChunk {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock;
}

interface UserMessageChunk {
  sessionUpdate: "user_message_chunk";
  content: ContentBlock;
}
```

#### Tool Events

| Type | `sessionUpdate` | Description |
|------|-----------------|-------------|
| `ToolCall` | `"tool_call"` | Tool execution started |
| `ToolCallUpdate` | `"tool_call_update"` | Tool execution finished |

```typescript
interface ToolCall {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  rawInput?: unknown;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
}

interface ToolCallUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status?: ToolCallStatus;
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
}
```

#### Plan Event

| Type | `sessionUpdate` | Description |
|------|-----------------|-------------|
| `Plan` | `"plan"` | TodoWrite updates (replaces entire list) |

```typescript
interface Plan {
  sessionUpdate: "plan";
  entries: PlanEntry[];
}

interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}
```

---

### Content Types

```typescript
type ContentBlock = TextContent | ImageContent;

interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image";
  data: string;       // Base64-encoded
  mimeType: string;   // "image/png", "image/jpeg"
  uri?: string;
}
```

---

### Tool Metadata Types

#### ToolKind

Tool category for UI icons:

```typescript
type ToolKind =
  | "read"        // Read, NotebookRead
  | "edit"        // Edit, Write, NotebookEdit
  | "delete"      // (future)
  | "move"        // (future)
  | "search"      // Glob, Grep, LS
  | "execute"     // Bash, BashOutput, KillShell
  | "think"       // Task (subagent)
  | "fetch"       // WebFetch, WebSearch
  | "switch_mode" // ExitPlanMode
  | "other";      // MCP tools (including browser-use), unknown
```

> **Important:** Browser-use MCP tools have `kind: "other"`, not `"browser"` or `"fetch"`. To identify browser tools in your UI, check if `title` starts with `"browser-use:"` (e.g., `"browser-use: browser_task"`, `"browser-use: monitor_task"`).

```typescript
// Helper to detect browser-use tools
function isBrowserUseTool(title?: string): boolean {
  return title?.toLowerCase().includes('browser-use') ?? false;
}
```

#### ToolCallStatus

```typescript
type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
```

#### ToolCallLocation

```typescript
interface ToolCallLocation {
  path: string;
  line?: number;
}
```

#### ToolCallContent

```typescript
type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | DiffContent;

interface DiffContent {
  type: "diff";
  path: string;
  oldText: string | null;
  newText: string;
}
```

#### BrowserUseResponse

Browser automation (`browser-use`) is included by default in Gateway mode. Browser tool responses embed a **JSON string** inside `ToolCallUpdate.content[].content.text`. You must extract and parse it.

> **Detection:** Browser-use tools arrive with `kind: "other"` and `title` like `"browser-use: browser_task"` or `"browser-use: monitor_task"`. Use the `isBrowserUseTool(title)` helper above to identify them, then extract URLs from the tool output.

```typescript
interface BrowserUseResponse {
  task_id?: string;                           // Task ID for monitoring
  session_id?: string;                        // Browser session ID
  live_url?: string;                          // VNC live view URL
  screenshot_url?: string;                    // Final screenshot URL
  steps?: Array<{                             // Per-step screenshots
    step_number: number;
    screenshot_url?: string;
    url?: string;                             // Page URL at this step
    memory?: string;                          // Agent's reasoning
  }>;
  is_success?: boolean | null;                // Task completion status
  task_output?: string | null;                // Final task result
}
```

**Extraction function** (use regex first for speed and malformed JSON tolerance, then JSON.parse fallback for nested access):

```typescript
function extractBrowserUseUrls(text: string): { liveUrl?: string; screenshotUrl?: string } {
  let liveUrl: string | undefined;
  let screenshotUrl: string | undefined;

  // 1. Regex extraction (fast, handles malformed JSON)
  const liveMatch = text.match(/"live_url"\s*:\s*"([^"]+)"/);
  if (liveMatch) liveUrl = liveMatch[1];

  const screenshotMatch = text.match(/"screenshot_url"\s*:\s*"([^"]+)"/);
  if (screenshotMatch) screenshotUrl = screenshotMatch[1];

  // 2. JSON.parse fallback (for steps[].screenshot_url)
  if (!liveUrl || !screenshotUrl) {
    try {
      const parsed = JSON.parse(text) as BrowserUseResponse;
      if (!liveUrl) liveUrl = parsed.live_url;
      if (!screenshotUrl) screenshotUrl = parsed.screenshot_url ?? parsed.steps?.[parsed.steps.length - 1]?.screenshot_url;
    } catch {}
  }

  return { liveUrl, screenshotUrl };
}
```

---

### UI Integration Example

```typescript
import type { OutputEvent } from "@evolvingmachines/sdk";

// Helper to detect browser-use tools (they have kind: "other")
function isBrowserUseTool(title?: string): boolean {
  return title?.toLowerCase().includes('browser-use') ?? false;
}

// Track tool titles for browser detection
const toolTitles = new Map<string, string>();

function handleEvent(event: OutputEvent): void {
  const { update } = event;

  switch (update.sessionUpdate) {
    case "agent_message_chunk":
      if (update.content.type === "text") {
        ui.appendMessage(update.content.text);
      } else {
        ui.appendImage(update.content.data, update.content.mimeType);
      }
      break;

    case "agent_thought_chunk":
      ui.appendThought(update.content);
      break;

    case "user_message_chunk":
      // Gemini echo - typically ignored
      break;

    case "tool_call":
      // Store title for browser-use detection on updates
      toolTitles.set(update.toolCallId, update.title);

      // Determine effective kind for UI (browser-use has kind: "other")
      const effectiveKind = isBrowserUseTool(update.title) ? "browser" : update.kind;

      ui.addTool({
        id: update.toolCallId,
        title: update.title,
        kind: effectiveKind,  // Use "browser" for browser-use tools
        status: update.status,
        locations: update.locations,
      });
      break;

    case "tool_call_update":
      // 1. Always update tool card with result
      ui.updateTool(update.toolCallId, {
        status: update.status,
        content: update.content,
      });

      // 2. Extract browser-use URLs if this is a browser-use tool
      const title = toolTitles.get(update.toolCallId);
      if (isBrowserUseTool(title)) {
        for (const c of update.content ?? []) {
          if (c.type === "content" && c.content?.type === "text") {
            const urls = extractBrowserUseUrls(c.content.text);
            if (urls.liveUrl) ui.showLiveViewButton(urls.liveUrl);
            if (urls.screenshotUrl) ui.showScreenshot(urls.screenshotUrl);
          }
        }
      }
      break;

    case "plan":
      ui.renderPlan(update.entries);
      break;
  }
}

evolve.on("content", handleEvent);
```

---

### Key Patterns

1. **Handle all 6 event types** — Don't silently drop unknown events
2. **Match tools by ID** — `tool_call` and `tool_call_update` share `toolCallId`
3. **Handle out-of-order** — `tool_call_update` may arrive before `tool_call`
4. **Concatenate chunks** — Message text arrives incrementally
5. **Support images** — `ContentBlock` includes `ImageContent`
6. **Use `kind` for icons** — Categorize tools visually (read, edit, execute, etc.)
7. **Track `locations`** — Show affected file paths in UI
8. **Detect browser-use by title** — Browser-use MCP tools have `kind: "other"`, check `title.includes("browser-use")` to identify them

### 3.4 Upload: Local → Sandbox

**Format:** `{ "destination": content }` — directories created automatically

| Method | Destination |
|--------|-------------|
| `uploadContext()` | `/home/user/workspace/context/{path}` |
| `uploadFiles()` | `/home/user/workspace/{path}` |

```ts
// Single file
await evolve.uploadContext({ "spec.json": JSON.stringify(data) });

// Multiple files
await evolve.uploadFiles({
  "scripts/setup.sh": "#!/bin/bash\necho hello",
  "data/input.csv": csvBuffer,
});

// From local directory (helper)
import { readLocalDir } from "@evolvingmachines/sdk";
await evolve.uploadContext(readLocalDir("./input", true));
```

> **Setup alternative:** `withContext()` and `withFiles()` use the same format but upload on first `run()` instead of immediately.

### 3.5 Download: Sandbox → Local

**Flow:** `getOutputFiles()` → `saveLocalDir()`

```ts
// Return type
interface OutputResult<T = unknown> {
    files: FileMap;      // All files from output/ folder
    data: T | null;      // Parsed result.json (if schema was set via withSchema())
    error?: string;      // Validation error message (if schema validation failed)
    rawData?: string;    // Raw result.json content when parse/validation failed (for debugging)
}
```

```ts
import { z } from "zod";
import { saveLocalDir } from "@evolvingmachines/sdk";

const ResultSchema = z.object({
    summary: z.string(),
    score: z.number(),
});

const evolve = new Evolve()
    .withAgent({...})
    .withSchema(ResultSchema);  // Agent will be prompted to write result.json

await evolve.run({ prompt: "Analyze and score the document" });

const output = await evolve.getOutputFiles(true);  // recursive=true for nested dirs

// Access all three fields
saveLocalDir("./output", output.files);  // Save files locally
console.log(output.data);                 // { summary: "...", score: 85 }
console.log(output.error);                // undefined (or validation error message)
```

- **`files`** — `FileMap` of all files from `output/` folder
- **`data`** — Parsed `result.json` validated against schema (null if no schema or validation failed)
- **`error`** — Validation error message if schema validation failed (undefined otherwise)

Files created before the last `run()` or `executeCommand()` are filtered out.

### 3.6 Session controls

```ts
const sessionId = evolve.getSession();  // Returns sandbox ID (string) or null (sync)

await evolve.pause();  // Suspends sandbox (stops billing, preserves state)
await evolve.resume(); // Reactivates same sandbox

await evolve.kill();   // Destroys sandbox; next run() creates a new sandbox

await evolve.setSession("existing-sandbox-id"); // Sets sandbox ID; reconnection happens on next run()
```

`withSession("sandbox-id")` is a builder method equivalent to `setSession()` - use it during initialization to reconnect to an existing sandbox.

### 3.7 getHost

Expose a forwarded port:

```ts
const url = await evolve.getHost(8000);
console.log(`Workspace service available at ${url}`);
```
---

## 4. Workspace Setup & Structured Output

Calling `run` or `executeCommand` for the first time provisions a sandbox with the following filesystem:

```
/home/user/workspace/
├── context/     # Input files (read-only) provided by the user
├── scripts/     # Your code goes here
├── temp/        # Scratch space
├── output/      # Final deliverables
└── CLAUDE.md    # System prompt (or AGENT.md, GEMINI.md, QWEN.md depending on agent)
```

Files passed to `context` are uploaded to `context/`. Files passed to `files` are uploaded relative to the working directory.

## Filesystem Instructions
Evolve writes a default filesystem instructions to the agent's config file in the workspace (`CLAUDE.md`, `AGENT.md`, `GEMINI.md`, or `QWEN.md`):

```
## FILESYSTEM INSTRUCTIONS

You are running in a sandbox environment.

Present working directory: /home/user/workspace/

IMPORTANT - Directory structure:
/home/user/workspace/
├── context/   # Input files (read-only) provided by the user
├── scripts/   # Your code goes here
├── temp/      # Scratch space
└── output/    # Final deliverables

## OUTPUT RESULTS (DELIVERABLES) MUST BE SAVED to `output/` as files.
```

Any string passed to `systemPrompt` is automatically appended to the agent's config file in the workspace (`CLAUDE.md`, `AGENT.md`, `GEMINI.md`, or `QWEN.md`) after this default.

## Structured Output

When you provide a `schema`, Evolve instructs the agent to write structured JSON output.

```ts
import { z } from "zod";

const CREDataSchema = z.object({
    property_name: z.string(),
    units: z.number(),
    total_rent: z.number(),
    occupancy_rate: z.number(),
});

const evolve = new Evolve()
    .withSchema(CREDataSchema)
    .withContext({
        "rent_roll.pdf": fs.readFileSync("rent_roll.pdf"),
    });

await evolve.run({ prompt: "Extract CRE data from the rent roll" });

const output = await evolve.getOutputFiles();
console.log(output.data);  // { property_name: '...', units: 120, ... }
```

When a schema is provided, `getOutputFiles()` automatically validates `output/result.json` and returns:

```ts
interface OutputResult<T> {
    files: FileMap,                   // All output files
    data: T | null,                   // Parsed & validated result.json (null if failed)
    error?: string,                   // Validation/parse error message
    rawData?: string,                 // Raw result.json for debugging failed validation
}
```

```ts
// Type-safe access to validated data
if (output.data) {
    console.log(output.data.property_name);  // TypeScript knows the shape
} else {
    console.error(output.error);             // "Schema validation failed: ..."
    console.log(output.rawData);             // Raw JSON for debugging
}
```

The SDK automatically appends the following to the agent's config file in the workspace (`CLAUDE.md`, `AGENT.md`, `GEMINI.md`, or `QWEN.md`):

~~~
## STRUCTURED OUTPUT

Your final result MUST be saved to `output/result.json` following this schema:

```json
{
  "type": "object",
  "properties": {
    "property_name": { "type": "string" },
    "units": { "type": "integer" },
    "total_rent": { "type": "number" },
    "occupancy_rate": { "type": "number" }
  },
  "required": ["property_name", "units", "total_rent", "occupancy_rate"]
}
```

You are free to:
- Reason through the problem step by step
- Read and analyze context files
- Use any available tools
- Process incrementally
- Create intermediate files in `temp/` or `scripts/`

But your final `output/result.json` MUST conform to the schema above.

### OUTPUT RESULTS (DELIVERABLES) MUST BE WRITTEN to `output/result.json` as files.
### Never just state results as text.
~~~

---

## 5. Cleaning up and session management

**Multi-turn conversations** (most common):

```ts
const evolve = new Evolve()
  .withAgent({...});

await evolve.run({ prompt: 'Analyze data.csv' });
const output1 = await evolve.getOutputFiles();

// Still same session, automatically maintains context / history
await evolve.run({ prompt: 'Now create visualization' });
const output2 = await evolve.getOutputFiles();

// Still same session, automatically maintains context / history
await evolve.run({ prompt: 'Export to PDF' });
const output3 = await evolve.getOutputFiles();

await evolve.kill();  // When done
```

**Pause and resume** (same instance):

```ts
const evolve = new Evolve()
  .withAgent({...});

await evolve.run({ prompt: 'Start analysis' });
await evolve.pause();  // Suspend billing, keep state
// Do other work...
await evolve.resume();  // Reactivate same sandbox
await evolve.run({ prompt: 'Continue analysis' });  // Session intact

await evolve.kill();  // Kill the Sandbox when done
```

**Save and reconnect** (different script/session):

```ts
// Script 1: Save session for later
const evolve = new Evolve()
  .withAgent({...});

await evolve.run({ prompt: 'Start analysis' });

const sessionId = evolve.getSession();
// Save to file, database, environment variable, etc.
fs.writeFileSync('session.txt', sessionId);

// Script 2: Reconnect to saved session
const savedId = fs.readFileSync('session.txt', 'utf-8');

const evolve2 = new Evolve()
  .withAgent({...})
  .withSession(savedId);  // Reconnect

await evolve2.run({ prompt: 'Continue analysis' });  // Session continues from Script 1
```

**Switch between sandboxes** (same instance):

```ts
const evolve = new Evolve()
  .withAgent({...});

// Work with first sandbox
await evolve.run({ prompt: 'Analyze dataset A' });
const sessionA = evolve.getSession();

// Switch to different sandbox
await evolve.setSession('existing-sandbox-b-id');
await evolve.run({ prompt: 'Analyze dataset B' });  // Now working with sandbox B

// Switch back to first sandbox
await evolve.setSession(sessionA);
await evolve.run({ prompt: 'Compare results' });  // Back to sandbox A
```

---

## 6. Observability

Full execution traces—including tool calls, file operations (read/write/edit), text responses, and reasoning chunks—are logged to your Evolve dashboard at **https://dashboard.evolvingmachines.ai/traces** for debugging and replay.

Additionally, every run and command is logged locally to structured JSON lines under `~/.evolve-sdk/observability/sessions`. File name format:

```
{tag}_{provider}_{sandboxId}_{agent}_{timestamp}.jsonl
```

- `{tag}` – `my-prefix-` + 16 random hex characters (e.g. `my-prefix-a1b2c3d4e5f6g7h8`)
- `{provider}` – the sandbox provider (e.g. `e2b`)
- `{sandboxId}` – the active sandbox ID
- `{agent}` – the agent type (`codex`, `claude`, `gemini`, `qwen`)
- `{timestamp}` – ISO timestamp with `:` and `.` replaced by `-`

Each file contains three entry types:

```json
{"_meta":{"tag":"my-prefix-a1b2c3d4","provider":"e2b","agent":"qwen","model":"qwen-coder-plus-latest","sandbox_id":"sbx_123","timestamp":"2025-10-26T20:15:17.984Z"}}
{"_prompt":{"text":"hello how are you?"}}
{"jsonrpc":"2.0","method":"session/update", ...}
```

- `_meta` – exactly one line per file (sandbox, agent, timestamp)
- `_prompt` – one line per `run()` call with the prompt text
- Raw JSON – every streamed payload (ACP notifications, stdout, etc.)

Attach your own prefix to make logs easy to search:

```ts
const evolve = new Evolve()
  .withAgent({...})
  .withSessionTagPrefix("my-project");

await evolve.run({ prompt: "Kick off analysis" });

console.log(evolve.getSessionTag());        // "my-project-ab12cd34"
console.log(evolve.getSessionTimestamp()); // Timestamp for first log file

await evolve.kill();                              // Flushes log file for sandbox A

await evolve.run({ prompt: "Start fresh" });      // New sandbox → new log file

console.log(evolve.getSessionTag());        // "my-project-f56789cd"
console.log(evolve.getSessionTimestamp()); // Timestamp for second log file
```

- `kill()` or `setSession()` flushes the current log; the next `run()` starts a
  fresh file with the new sandbox id.
- Long-running sessions (pause/resume or ACP auto-resume) keep appending to the
  current file, so you always have the full timeline.
- Logging is buffered inside the SDK, so it never blocks streaming output.

Use the tag together with the sandbox id to correlate logs with files saved in
`/output/`.

---

# Swarm Abstractions

Functional programming for AI agents: `map`, `filter`, `reduce`, `bestOf`.

```ts
import { Swarm } from "@evolvingmachines/sdk";
import { z } from "zod";  // Or use plain JSON Schema objects instead

const swarm = new Swarm({
    agent: { type: "claude" },   // Default agent for all operations
    skills: ["pdf"],                 // Default skills (browser-use included by default)
    composio: {                  // Default Composio config for all workers
        userId: "user_123",
        config: { toolkits: ["github", "linear"] },
    },
    mcpServers: {...},           // Default MCP servers for all workers
    concurrency: 4,              // Max parallel sandboxes (default: 4)
    timeoutMs: 3_600_000,        // Default timeout per worker (default: 1 hour)
    tag: "my-pipeline",          // Tag prefix for observability
    retry: {                     // Default retry config for all operations
        maxAttempts: 3,
        backoffMs: 1000,
        backoffMultiplier: 2,
    },
});
```

> **Defaults**: `agent`, `skills`, `composio`, `mcpServers`, `timeoutMs`, and `retry` set here are inherited by all operations (`map`, `filter`, `reduce`, `bestOf`). Pass these options to individual operations to override.

**SwarmConfig** — configuration for Swarm instance:
```ts
{
    agent?: AgentOverride,
    skills?: string[],
    composio?: ComposioSetup,
    mcpServers?: Record<string, McpServerConfig>,
    concurrency?: number,
    timeoutMs?: number,
    tag?: string,
    retry?: RetryConfig,
}
```

| Option | Default | Notes |
|--------|---------|-------|
| `agent.type` | `'claude'` | Auto-resolved from env |
| `agent.model` | per type | `'opus'` (claude), `'gpt-5.2'` (codex), etc. |
| `skills` | `undefined` | Set here or per-operation |
| `composio` | `undefined` | Set here or per-operation |
| `mcpServers` | `undefined` | Set here or per-operation |
| `concurrency` | `4` | Max parallel sandboxes |
| `timeoutMs` | `3_600_000` | 1 hour per worker |
| `tag` | `'swarm'` | Observability prefix |
| `retry` | `undefined` | Set here or per-operation |

**Minimal setup** — with `EVOLVE_API_KEY` set (see [1.1 Authentication](#11-authentication)):

```ts
import "dotenv/config";  // If using .env file
import { Swarm } from "@evolvingmachines/sdk";

const swarm = new Swarm();  // Auto-resolves agent (claude) and sandbox from env
```

**RetryConfig** — auto-retry on error with exponential backoff:
```ts
{
    maxAttempts?: number,
    backoffMs?: number,
    backoffMultiplier?: number,
    retryOn?: (result) => boolean,
    onItemRetry?: (idx, attempt, error) => void,
}
```

## 1. Input Types

Swarm runs in **knowledge mode** by default—files are uploaded to `context/` in the sandbox.

**FileMap structure:**

```ts
// FileMap: Record<path, content>
//   - path: string              → file path in context/ folder
//   - content: string | Uint8Array  → file content

type FileMap = Record<string, string | Uint8Array>;
```

---

**Case 1: One file per worker**

```ts
// 3 workers, each gets 1 file
const items: FileMap[] = [
    { "report.txt": "Q1 revenue..." },      // → Worker 0: context/report.txt
    { "report.txt": "Q2 revenue..." },      // → Worker 1: context/report.txt
    { "report.txt": "Q3 revenue..." },      // → Worker 2: context/report.txt
];

const results = await swarm.map({
    items,
    prompt: "Summarize this report",
});
```

---

**Case 2: Multiple files per worker**

```ts
// 3 workers, each gets 2 files
const items: FileMap[] = [
    {                                       // → Worker 0:
        "doc1.pdf": fs.readFileSync("./doc1.pdf"),  //   context/doc1.pdf
        "doc2.pdf": fs.readFileSync("./doc2.pdf"),  //   context/doc2.pdf
    },
    {                                       // → Worker 1:
        "doc3.pdf": fs.readFileSync("./doc3.pdf"),  //   context/doc3.pdf
        "doc4.pdf": fs.readFileSync("./doc4.pdf"),  //   context/doc4.pdf
    },
    {                                       // → Worker 2:
        "doc5.pdf": fs.readFileSync("./doc5.pdf"),  //   context/doc5.pdf
        "doc6.pdf": fs.readFileSync("./doc6.pdf"),  //   context/doc6.pdf
    },
];

const results = await swarm.map({
    items,
    prompt: "Compare these two documents",
});
```

---

**Case 3: Entire folder per worker**

```ts
import { readLocalDir } from "@evolvingmachines/sdk";

// readLocalDir(path, recursive) → returns FileMap with all files
const items: FileMap[] = [
    readLocalDir("./project-a", true),      // → Worker 0: all files from project-a (recursive)
    readLocalDir("./project-b", true),      // → Worker 1: all files from project-b (recursive)
    readLocalDir("./project-c", true),      // → Worker 2: all files from project-c (recursive)
];

const results = await swarm.map({
    items,
    prompt: "Review this codebase",
});
```

## 2. Abstractions

Two types of operations:

| Operation | Type | Description | Passes On |
|-----------|------|-------------|-----------|
| `bestOf` | transform + select | `input` → `output` (best of N candidates) | winner output |
| `map` | transform | `input` → `output` (agent produces new data) | agent output |
| `filter` | gate | `input` → `input` (agent evaluates, condition decides) | original input + status (`success` \| `filtered`) |
| `reduce` | transform | `inputs` → `output` (agent synthesizes) | agent output |

**Transforms** produce new output files. **Filter** passes through original input files unchanged.

**BestOfConfig** — run N candidates in parallel, judge picks the best:
```ts
{
    n?: number,
    judgeCriteria: string,
    taskAgents?: AgentOverride[],
    judgeAgent?: AgentOverride,
    skills?: string[],
    judgeSkills?: string[],
    composio?: ComposioSetup,
    judgeComposio?: ComposioSetup,
    mcpServers?: Record<string, McpServerConfig>,
    judgeMcpServers?: Record<string, McpServerConfig>,
    onCandidateComplete?: (idx, candIdx, status) => void,
    onJudgeComplete?: (idx, winnerIdx, reasoning) => void,
}
```

**VerifyConfig** — LLM-as-judge verifies output, retries with feedback if failed:
```ts
{
    criteria: string,
    maxAttempts?: number,
    verifierAgent?: AgentOverride,
    verifierSkills?: string[],
    verifierComposio?: ComposioSetup,
    verifierMcpServers?: Record<string, McpServerConfig>,
    onWorkerComplete?: (idx, attempt, status) => void,
    onVerifierComplete?: (idx, attempt, passed, feedback?) => void,
}
```

### 2.1 bestOf

Run N agents on the same `item` in parallel, then a judge picks the best. `Agent[i]` outputs `candidates[i]`, judge selects `winner`.

```
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│    Sandbox 0    │ │    Sandbox 1    │ │    Sandbox 2    │
│    Agent 0      │ │    Agent 1      │ │    Agent 2      │
│                 │ │                 │ │                 │
│  context/       │ │  context/       │ │  context/       │
│    item         │ │    item         │ │    item         │
│  output/        │ │  output/        │ │  output/        │
│    candidates[0]│ │    candidates[1]│ │    candidates[2]│
└───────┬─────────┘ └───────┬─────────┘ └───────┬─────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
                    ┌───────────────┐
                    │     Judge     │
                    └───────┬───────┘
                            │
                            ▼
                         winner
```

```ts
// Signature
swarm.bestOf<T>({
    item: FileMap | SwarmResult,
    prompt: string,
    config: BestOfConfig,               // { n?, judgeCriteria, taskAgents?, judgeAgent?, mcpServers?, judgeMcpServers?, skills?, judgeSkills?, composio?, judgeComposio?, ... }
    name?: string,                      // Operation name for observability (appears in meta.operationName)
    schema?: z.ZodType<T> | JsonSchema,
    systemPrompt?: string,
    retry?: RetryConfig,                // Per-candidate retry (judge uses default)
    timeoutMs?: number,
}): Promise<BestOfResult<T>>
```

```ts
const input = { "task.txt": "Complex problem..." };

const result = await swarm.bestOf({
    item: input,
    prompt: "Solve this problem",
    config: {
        n: 3,
        judgeCriteria: "Most accurate and well-explained solution",
        onCandidateComplete: (idx, candIdx, status) => console.log(`Candidate ${candIdx}: ${status}`),
        onJudgeComplete: (idx, winnerIdx, reasoning) => console.log(`Winner: ${winnerIdx}`),
    },
});

console.log(result.winner);         // Best SwarmResult
console.log(result.winnerIndex);    // 0, 1, or 2
console.log(result.judgeReasoning); // Why this was chosen
console.log(result.candidates);     // All candidate results
```

Use different agents per candidate:

```ts
const claudeAgent = { type: "claude", model: "opus" };
const codexAgent = { type: "codex", model: "gpt-5.2-codex" };
const geminiAgent = { type: "gemini", model: "gemini-3-flash" };

const result = await swarm.bestOf({
    item: input,
    prompt: "Solve this",
    config: {
        taskAgents: [claudeAgent, codexAgent, geminiAgent],
        judgeCriteria: "Best solution quality",
        judgeAgent: claudeAgent,
        mcpServers: {...},        // (optional) MCP servers for candidates
        judgeMcpServers: {...},   // (optional) MCP servers for judge
        skills: ["pdf"],          // (optional) Skills for candidates
        judgeSkills: ["pdf"],     // (optional) Skills for judge
        composio: {...},          // (optional) Composio config for candidates
        judgeComposio: {...},     // (optional) Composio config for judge
    },
});
```

### 2.2 map

Process items in parallel. `Agent[i]` sees `items[i]` and outputs `results[i]` (which includes `result.json` if `schema` provided).

```
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│    Sandbox 0    │ │    Sandbox 1    │ │    Sandbox 2    │
│    Agent 0      │ │    Agent 1      │ │    Agent 2      │
│                 │ │                 │ │                 │
│  context/       │ │  context/       │ │  context/       │
│    items[0]     │ │    items[1]     │ │    items[2]     │
│  output/        │ │  output/        │ │  output/        │
│    results[0]   │ │    results[1]   │ │    results[2]   │
└───────┬─────────┘ └───────┬─────────┘ └───────┬─────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
              [results[0], results[1], results[2]]
```

```ts
// Signature (schema accepts Zod or JSON Schema object)
swarm.map<T>({
    items: FileMap[] | SwarmResult[],
    prompt: string | ((files: FileMap, index: number) => string),
    name?: string,                      // Operation name for observability (appears in meta.operationName)
    schema?: z.ZodType<T> | JsonSchema,
    systemPrompt?: string,
    agent?: AgentOverride,
    bestOf?: BestOfConfig,              // N candidates + judge (mutually exclusive with verify)
    verify?: VerifyConfig,              // LLM-as-judge quality check with retry loop
    retry?: RetryConfig,                // Auto-retry on error with backoff
    mcpServers?: Record<string, McpServerConfig>,
    skills?: string[],                  // e.g. ["pdf"]
    composio?: ComposioSetup,           // Composio Tool Router config
    timeoutMs?: number,
}): Promise<SwarmResultList<T>>
```

```ts
// Basic
const results = await swarm.map({
    items: documents,
    prompt: "Summarize this document",
});
```

When `schema` is provided, a structured output prompt is automatically embedded—instructing the agent to write `output/result.json` matching the schema.

```ts
// With Zod schema
const SummarySchema = z.object({
    title: z.string(),
    keyPoints: z.array(z.string()),
});

const results = await swarm.map({
    items: documents,
    prompt: "Extract summary",
    schema: SummarySchema,
});

// Or with JSON Schema
const SummaryJsonSchema = {
    type: "object",
    properties: {
        title: { type: "string" },
        keyPoints: { type: "array", items: { type: "string" } },
    },
    required: ["title", "keyPoints"],
};

const results = await swarm.map({
    items: documents,
    prompt: "Extract summary",
    schema: SummaryJsonSchema,
});

// With dynamic prompt
const results = await swarm.map({
    items: documents,
    prompt: (files, index) => `Analyze document ${index + 1}: focus on revenue`,
});

// Access results
for (const r of results) {
    if (r.status === "success") {
        console.log(r.data);   // Parsed schema or FileMap
        console.log(r.files);  // Output files from agent
    }
}
```

### 2.3 map with bestOf

Combine map parallelism with bestOf quality:

```ts
const AnalysisSchema = z.object({
    findings: z.array(z.string()),
    confidence: z.number(),
});

// Each item gets N candidates, judge picks best per item
const results = await swarm.map({
    items: documents,
    prompt: "Analyze thoroughly",
    schema: AnalysisSchema,
    bestOf: {
        n: 3,
        judgeCriteria: "Most comprehensive analysis",
        // taskAgents?: AgentOverride[],     // Different agent per candidate
        // judgeAgent?: AgentOverride,       // Override judge agent
        // mcpServers?: {...},               // MCP servers for candidates
        // judgeMcpServers?: {...},          // MCP servers for judge
        // skills?: [...],                   // Skills for candidates
        // judgeSkills?: [...],              // Skills for judge
        // composio?: {...},                 // Composio for candidates
        // judgeComposio?: {...},            // Composio for judge
    },
});

// Results contain only winners (one per input item)
```

### 2.4 filter

Two-step evaluation (`schema` and `condition` are required):
1. `Agent[i]` sees `items[i]`, assesses it, outputs `result.json` matching `schema`
2. SDK parses `result.json` → `data`, your `condition(data)` applies the threshold
3. Passing items forward their original input files, not agent output

```
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│    Sandbox 0    │ │    Sandbox 1    │ │    Sandbox 2    │
│    Agent 0      │ │    Agent 1      │ │    Agent 2      │
│                 │ │                 │ │                 │
│  context/       │ │  context/       │ │  context/       │
│    items[0]     │ │    items[1]     │ │    items[2]     │
│  output/        │ │  output/        │ │  output/        │
│    result.json  │ │    result.json  │ │    result.json  │
└───────┬─────────┘ └───────┬─────────┘ └───────┬─────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
                   condition(data)
                      ✓    ✗    ✓
                      │         │
                      ▼         ▼
                [items[0], items[2]]
```

```ts
// Signature (schema accepts Zod or JSON Schema object)
swarm.filter<T>({
    items: FileMap[] | SwarmResult[],
    prompt: string,           // Describe what to assess (agent outputs result.json)
    name?: string,                      // Operation name for observability (appears in meta.operationName)
    schema: z.ZodType<T> | JsonSchema,  // Required - defines evaluation output structure
    condition: (data: T) => boolean,    // Local function applies threshold
    systemPrompt?: string,
    agent?: AgentOverride,
    verify?: VerifyConfig,              // LLM-as-judge quality check with retry loop
    retry?: RetryConfig,                // Auto-retry on error with backoff
    mcpServers?: Record<string, McpServerConfig>,
    skills?: string[],                  // e.g. ["pdf"]
    composio?: ComposioSetup,           // Composio Tool Router config
    timeoutMs?: number,
}): Promise<SwarmResultList<T>>
```

```ts
const EvalSchema = z.object({
    severity: z.enum(["critical", "warning", "info"]),
    score: z.number(),
});

const results = await swarm.filter({
    items: documents,
    prompt: "Assess the severity of issues in this document",  // Agent evaluates
    schema: EvalSchema,
    condition: (data) => data.severity === "critical",  // Code applies threshold
});

// Three possible statuses:
results.success;   // Passed condition
results.filtered;  // Evaluated but didn't pass
results.error;     // Agent error

// Chain to next step
await swarm.reduce({
    items: results.success,
    prompt: "Summarize critical issues",
});
```

### 2.5 reduce

Synthesize many items into one. A single agent sees all `items` as `item_0/`, `item_1/`, etc. and outputs a unified `result` (which includes `result.json` if `schema` provided).

```
        ┌─────────────────────────┐
        │         Sandbox         │
        │         Agent           │
        │                         │
        │  context/               │
        │    item_0/items[0]      │
        │    item_1/items[1]      │
        │    item_2/items[2]      │
        │  output/                │
        │    result               │
        └────────────┬────────────┘
                     │
                     ▼
                  result
```

```ts
// Signature (schema accepts Zod or JSON Schema object)
swarm.reduce<T>({
    items: FileMap[] | SwarmResult[],
    prompt: string,
    name?: string,                      // Operation name for observability (appears in meta.operationName)
    schema?: z.ZodType<T> | JsonSchema,
    systemPrompt?: string,
    agent?: AgentOverride,
    verify?: VerifyConfig,              // LLM-as-judge quality check with retry loop
    retry?: RetryConfig,                // Auto-retry on error with backoff
    mcpServers?: Record<string, McpServerConfig>,
    skills?: string[],                  // e.g. ["pdf"]
    composio?: ComposioSetup,           // Composio Tool Router config
    timeoutMs?: number,
}): Promise<ReduceResult<T>>
```

```ts
// Agent sees: item_0/, item_1/, item_2/, etc.
const report = await swarm.reduce({
    items: results.success,
    prompt: "Create a unified report from all analyses",
});

if (report.status === "success") {
    console.log(report.files);  // Final output files
    console.log(report.data);   // Parsed schema if provided
}

// With schema
const ReportSchema = z.object({
    summary: z.string(),
    recommendations: z.array(z.string()),
});

const report = await swarm.reduce({
    items,
    prompt: "Create report",
    schema: ReportSchema,
});
```

## 3. Result Types

```ts
// SwarmResult<T> - from map, filter, bestOf candidates
interface SwarmResult<T> {
    status: "success" | "filtered" | "error";
    data: T | null;      // Parsed schema, or null on error
    files: FileMap;      // Output files (map/bestOf) or input files (filter)
    meta: IndexedMeta;   // { operationId, operation, tag, sandboxId, itemIndex }
    error?: string;      // Error message if status === "error"
    rawData?: string;    // Raw result.json when parse/validation failed (for debugging)
    bestOf?: {           // Present when map used bestOf option
        winnerIndex: number;
        judgeReasoning: string;
        judgeMeta: JudgeMeta;   // { operationId, operation, tag, sandboxId, candidateCount }
        candidates: SwarmResult<T>[];
    };
    verify?: VerifyInfo; // Present when verify option was used
}

// SwarmResultList<T> - from map, filter (extends Array)
results.success;   // SwarmResult[] with status "success"
results.filtered;  // SwarmResult[] with status "filtered"
results.error;     // SwarmResult[] with status "error"

// ReduceResult<T> - from reduce
interface ReduceResult<T> {
    status: "success" | "error";
    data: T | null;
    files: FileMap;
    meta: ReduceMeta;   // { operationId, operation, tag, sandboxId, inputCount, inputIndices }
    error?: string;
    rawData?: string;   // Raw result.json when parse/validation failed (for debugging)
    verify?: VerifyInfo; // Present when verify option was used
}

// VerifyInfo - verification outcome
interface VerifyInfo {
    passed: boolean;        // Final verification status
    reasoning: string;      // Verifier's reasoning
    verifyMeta: VerifyMeta; // { operationId, operation, tag, sandboxId, attempts }
    attempts: number;       // Total attempts made
}

// BestOfResult<T> - from bestOf
interface BestOfResult<T> {
    winner: SwarmResult<T>;
    winnerIndex: number;
    judgeReasoning: string;
    judgeMeta: JudgeMeta;   // { operationId, operation, tag, sandboxId, candidateCount }
    candidates: SwarmResult<T>[];
}
```

## 4. Chaining Operations

When chaining Swarm operations, `result.json` from a previous step is automatically renamed to `data.json`. This avoids confusion when the downstream agent writes its own `result.json`. This also applies to [Pipeline](#7-pipeline).

**Example: map → reduce chain**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  MAP (parallel)                                                             │
│                                                                             │
│  item_0 agent writes:          item_1 agent writes:                         │
│  output/                       output/                                      │
│    result.json ← schema        result.json ← schema                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  REDUCE (single agent)                                                      │
│                                                                             │
│  context/                                                                   │
│    item_0/                                                                  │
│      data.json      ← renamed from result.json                              │
│    item_1/                                                                  │
│      data.json      ← renamed from result.json                              │
│  output/                                                                    │
│    result.json      ← reduce agent writes its own                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

```ts
const AnalysisSchema = z.object({ summary: z.string() });
const SeveritySchema = z.object({ severity: z.enum(["critical", "warning", "info"]) });

// Full pipeline: map → filter → reduce
const analyzed = await swarm.map({
    items: documents,
    prompt: "Analyze",
    schema: AnalysisSchema,
});

const critical = await swarm.filter({
    items: analyzed.success,
    prompt: "Evaluate severity",
    schema: SeveritySchema,
    condition: (d) => d.severity === "critical",
});

const report = await swarm.reduce({
    items: critical.success,
    prompt: "Create summary report",
});

// Combine success and filtered
const allEvaluated = [...critical.success, ...critical.filtered];
await swarm.reduce({
    items: allEvaluated,
    prompt: "Summarize all evaluated items",
});
```

## 5. AgentOverride

Override the default agent for any operation (apiKey inherited from Swarm config):

```ts
interface AgentOverride {
    type: "claude" | "codex" | "gemini" | "qwen";
    model?: string;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh";  // Codex only
    betas?: string[];  // Claude only
}
```

```ts
const codexAgent: AgentOverride = {
    type: "codex",
    reasoningEffort: "high",
};

const results = await swarm.map({
    items,
    prompt: "Analyze",
    agent: codexAgent,
});
```

## 6. Concurrency

Global semaphore limits parallel sandboxes across all operations.

```ts
const swarm = new Swarm({
    agent,
    sandbox,
    concurrency: 4,  // Max 4 sandboxes at once (default: 4)
});

// map(10) with bestOf(5) = 60 agent calls, but only 4 run at any time
```

**Ordering guarantees:**
- `bestOf`: Judge runs only after all candidates complete
- `map` → `filter` → `reduce`: Each phase completes before next starts
- Within a phase: Items run in parallel (up to concurrency limit)

---

## 7. Pipeline

Fluent wrapper over Swarm for chaining operations. **All Swarm features work in Pipeline steps** — `schema`, `bestOf`, `verify`, `retry`, `agent`, `mcpServers`, `skills`, `composio`, dynamic prompts.

```ts
import "dotenv/config";
import { Swarm, Pipeline } from "@evolvingmachines/sdk";

const swarm = new Swarm();  // See Swarm Abstractions for full config

const pipeline = new Pipeline(swarm)
    .map({
        name: "analyze",
        prompt: "Analyze...",
        schema: AnalysisSchema,
    })
    .filter({
        name: "critical",
        prompt: "Rate...",
        schema: SeveritySchema,
        condition: d => d.severity === "critical",
    })
    .reduce({
        name: "report",
        prompt: "Summarize...",
    });

// Reusable — run with different data
const result1 = await pipeline.run(batch1);
const result2 = await pipeline.run(batch2);
```

### Step Configurations

Each step accepts the same options as the corresponding Swarm method, plus `name` for observability:

```ts
// Map step — same as swarm.map() + name
.map<T>({
    name?: string,                        // Step name (appears in events)
    prompt: string | ((files, idx) => string),
    schema?: z.ZodType<T> | JsonSchema,
    bestOf?: BestOfConfig,                // N candidates + judge
    verify?: VerifyConfig,                // LLM-as-judge quality check
    retry?: RetryConfig,                  // Auto-retry on error
    agent?: AgentOverride,
    mcpServers?: Record<string, McpServerConfig>,
    skills?: string[],                    // Skills for workers
    composio?: ComposioSetup,             // Composio Tool Router config
    systemPrompt?: string,
    timeoutMs?: number,
})

// Filter step — same as swarm.filter() + name + emit
.filter<T>({
    name?: string,
    prompt: string,
    schema: z.ZodType<T> | JsonSchema,    // Required
    condition: (data: T) => boolean,      // Required
    emit?: "success" | "filtered" | "all",  // What passes to next step (default: "success")
    verify?: VerifyConfig,
    retry?: RetryConfig,
    agent?: AgentOverride,
    mcpServers?: Record<string, McpServerConfig>,
    skills?: string[],                    // Skills for workers
    composio?: ComposioSetup,             // Composio Tool Router config
    systemPrompt?: string,
    timeoutMs?: number,
})

// Reduce step — same as swarm.reduce() + name (terminal: no steps after)
.reduce<T>({
    name?: string,
    prompt: string,
    schema?: z.ZodType<T> | JsonSchema,
    verify?: VerifyConfig,
    retry?: RetryConfig,
    agent?: AgentOverride,
    mcpServers?: Record<string, McpServerConfig>,
    skills?: string[],                    // Skills for workers
    composio?: ComposioSetup,             // Composio Tool Router config
    systemPrompt?: string,
    timeoutMs?: number,
})
```

### Full Example

```ts
const pipeline = new Pipeline(swarm)

    .map({
        name: "analyze",
        prompt: (files, idx) => `Analyze document ${idx + 1}`,
        schema: AnalysisSchema,
        bestOf: {
            n: 3,
            judgeCriteria: "Most thorough analysis",
        },
        retry: { maxAttempts: 2 },
        agent: { type: "claude", model: "opus" },
    })

    .filter({
        name: "quality-gate",
        prompt: "Rate the analysis quality",
        schema: z.object({
            score: z.number(),
            reasoning: z.string(),
        }),
        condition: d => d.score >= 8,
        emit: "success",                  // Only high-quality pass through
        verify: {
            criteria: "Rating must be justified with specific examples",
        },
    })

    .reduce({
        name: "synthesize",
        prompt: "Create executive summary from all analyses",
        schema: ReportSchema,
        verify: {
            criteria: "Summary must cover all key findings",
        },
    })

    .on("stepComplete", e => {
        console.log(`${e.name}: ${e.successCount}/${e.successCount + e.errorCount}`);
    });

const result = await pipeline.run(documents);
```

### Events

Pipeline unifies all Swarm callbacks at the pipeline level, adding `stepIndex` and `stepName`:

```ts
pipeline
    .on("stepStart", e => {
        console.log(`Step ${e.index} started with ${e.itemCount} items`);
    })
    .on("stepComplete", e => {
        console.log(`Step ${e.index} done in ${e.durationMs}ms`);
    })
    .on("stepError", e => {
        console.error(`Step ${e.index} failed:`, e.error);
    });

// Or object style
pipeline.on({
    onStepComplete: e => console.log(`${e.name}: ${e.successCount} success`),
    onItemRetry: e => console.log(`Retry: step ${e.stepIndex}, item ${e.itemIndex}`),
    onVerifierComplete: e => console.log(`Verify: ${e.passed ? "PASS" : e.feedback}`),
});
```

| Event | Fields |
|-------|--------|
| `stepStart` | `type`, `index`, `name?`, `itemCount` |
| `stepComplete` | `type`, `index`, `name?`, `durationMs`, `successCount`, `errorCount`, `filteredCount` |
| `stepError` | `type`, `index`, `name?`, `error` |
| `itemRetry` | `stepIndex`, `stepName?`, `itemIndex`, `attempt`, `error` |
| `workerComplete` | `stepIndex`, `stepName?`, `itemIndex`, `attempt`, `status` |
| `verifierComplete` | `stepIndex`, `stepName?`, `itemIndex`, `attempt`, `passed`, `feedback?` |
| `candidateComplete` | `stepIndex`, `stepName?`, `itemIndex`, `candidateIndex`, `status` |
| `judgeComplete` | `stepIndex`, `stepName?`, `itemIndex`, `winnerIndex`, `reasoning` |

### Result

```ts
interface PipelineResult<T> {
  pipelineRunId: string;
  steps: StepResult[];        // { type, index, durationMs, results }
  output: SwarmResult<T>[] | ReduceResult<T>;
  totalDurationMs: number;
}

// Access step results
for (const step of result.steps) {
  console.log(`${step.type} took ${step.durationMs}ms`);
}
```

### Terminal Pipeline

After `.reduce()`, no more steps can be added (returns `TerminalPipeline`):

```ts
const terminal = pipeline.reduce({ prompt: "..." });
terminal.map({ prompt: "..." });  // Throws: "Cannot add steps after reduce"
```

---
