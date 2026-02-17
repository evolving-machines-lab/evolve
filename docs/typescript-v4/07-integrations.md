# Integrations

## At a Glance

- Skills extend tool capabilities.
- Composio provides 1000+ SaaS tools.
- MCP adds custom local/remote tool servers.

## Full Builder Example (integrations-focused)

```ts
import { Evolve } from "@evolvingmachines/sdk";
import { z } from "zod";

const evolve = new Evolve()
  .withAgent({ type: "codex", model: "gpt-5.2-codex" })
  .withContext({ "docs/readme.txt": "User context" })
  .withSystemPrompt("You are a careful pair programmer.")
  .withSchema(z.object({ summary: z.string(), score: z.number() }))
  .withSkills(["pdf", "docx", "pptx"])
  .withComposio("user_123", {
    toolkits: ["github", "gmail"],
    tools: {
      github: ["github_create_issue"],
      gmail: { disable: ["gmail_delete_email"] },
    },
    keys: { stripe: "sk_live_..." },
    authConfigs: { github: "ac_custom_oauth" },
  })
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
  .withSecrets({ GITHUB_TOKEN: process.env.GITHUB_TOKEN! });
```

## Skills

`browser-use` is included by default in Gateway mode (`EVOLVE_API_KEY`).

```ts
const evolve = new Evolve().withSkills(["pptx"]);
await evolve.run({ prompt: "Create a slide deck from web research" });
```

### Documents

| Skill | Description | Source |
|---|---|---|
| `pdf` | Read, extract, and analyze PDF documents | [skills/pdf](https://github.com/evolving-machines-lab/evolve/tree/main/skills/pdf) |
| `docx` | Create and edit Word documents | [skills/docx](https://github.com/evolving-machines-lab/evolve/tree/main/skills/docx) |
| `pptx` | Create and edit PowerPoint presentations | [skills/pptx](https://github.com/evolving-machines-lab/evolve/tree/main/skills/pptx) |
| `xlsx` | Create and edit Excel spreadsheets | [skills/xlsx](https://github.com/evolving-machines-lab/evolve/tree/main/skills/xlsx) |

### Browser Automation

| Skill | Description | Source |
|---|---|---|
| `agent-browser` | CLI-based headless browser automation for AI agents | [skills/agent-browser](https://github.com/evolving-machines-lab/evolve/tree/main/skills/agent-browser) |
| `dev-browser` | Browser automation with persistent page state | [skills/dev-browser](https://github.com/evolving-machines-lab/evolve/tree/main/skills/dev-browser) |
| `webapp-testing` | Test web applications | [skills/webapp-testing](https://github.com/evolving-machines-lab/evolve/tree/main/skills/webapp-testing) |

### Research and Analysis

| Skill | Description | Source |
|---|---|---|
| `content-research-writer` | Research and write content | [skills/content-research-writer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/content-research-writer) |
| `lead-research-assistant` | Research and qualify leads | [skills/lead-research-assistant](https://github.com/evolving-machines-lab/evolve/tree/main/skills/lead-research-assistant) |
| `meeting-insights-analyzer` | Analyze meeting insights | [skills/meeting-insights-analyzer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/meeting-insights-analyzer) |
| `developer-growth-analysis` | Analyze developer growth metrics | [skills/developer-growth-analysis](https://github.com/evolving-machines-lab/evolve/tree/main/skills/developer-growth-analysis) |
| `competitive-ads-extractor` | Extract and analyze competitor ads | [skills/competitive-ads-extractor](https://github.com/evolving-machines-lab/evolve/tree/main/skills/competitive-ads-extractor) |

### Design and Media

| Skill | Description | Source |
|---|---|---|
| `canvas-design` | Canvas and design creation | [skills/canvas-design](https://github.com/evolving-machines-lab/evolve/tree/main/skills/canvas-design) |
| `image-enhancer` | Enhance and process images | [skills/image-enhancer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/image-enhancer) |
| `theme-factory` | Create themes and styles | [skills/theme-factory](https://github.com/evolving-machines-lab/evolve/tree/main/skills/theme-factory) |
| `video-downloader` | Download videos from URLs | [skills/video-downloader](https://github.com/evolving-machines-lab/evolve/tree/main/skills/video-downloader) |
| `slack-gif-creator` | Create GIFs for Slack | [skills/slack-gif-creator](https://github.com/evolving-machines-lab/evolve/tree/main/skills/slack-gif-creator) |

### Business and Productivity

| Skill | Description | Source |
|---|---|---|
| `file-organizer` | Organize files and directories | [skills/file-organizer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/file-organizer) |
| `invoice-organizer` | Organize and process invoices | [skills/invoice-organizer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/invoice-organizer) |
| `brand-guidelines` | Brand asset and guidelines management | [skills/brand-guidelines](https://github.com/evolving-machines-lab/evolve/tree/main/skills/brand-guidelines) |
| `internal-comms` | Internal communications tools | [skills/internal-comms](https://github.com/evolving-machines-lab/evolve/tree/main/skills/internal-comms) |
| `tailored-resume-generator` | Generate tailored resumes | [skills/tailored-resume-generator](https://github.com/evolving-machines-lab/evolve/tree/main/skills/tailored-resume-generator) |
| `domain-name-brainstormer` | Brainstorm domain names | [skills/domain-name-brainstormer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/domain-name-brainstormer) |

### Development

| Skill | Description | Source |
|---|---|---|
| `mcp-builder` | Build MCP servers | [skills/mcp-builder](https://github.com/evolving-machines-lab/evolve/tree/main/skills/mcp-builder) |
| `skill-creator` | Create new skills | [skills/skill-creator](https://github.com/evolving-machines-lab/evolve/tree/main/skills/skill-creator) |
| `skill-share` | Share skills with others | [skills/skill-share](https://github.com/evolving-machines-lab/evolve/tree/main/skills/skill-share) |
| `changelog-generator` | Generate changelogs from commits | [skills/changelog-generator](https://github.com/evolving-machines-lab/evolve/tree/main/skills/changelog-generator) |
| `artifacts-builder` | Build artifacts and deliverables | [skills/artifacts-builder](https://github.com/evolving-machines-lab/evolve/tree/main/skills/artifacts-builder) |

### Other

| Skill | Description | Source |
|---|---|---|
| `raffle-winner-picker` | Pick raffle winners randomly | [skills/raffle-winner-picker](https://github.com/evolving-machines-lab/evolve/tree/main/skills/raffle-winner-picker) |

## Composio (Tool Router)

Composio docs:
- [Tool Router overview](https://docs.composio.dev/tool-router/overview)
- [Available toolkits](https://docs.composio.dev/toolkits/introduction)

```bash
# .env
EVOLVE_API_KEY=sk-...
COMPOSIO_API_KEY=...
```

```ts
const evolve = new Evolve().withComposio("user_123");
await evolve.run({ prompt: "Create GitHub issue for login bug" });
```

### Authentication paths

1. In-chat OAuth (default)

```ts
new Evolve().withComposio("user_123");
```

2. API key auth

```ts
new Evolve().withComposio("user_123", {
  toolkits: ["stripe", "sendgrid"],
  keys: {
    stripe: process.env.STRIPE_API_KEY!,
    sendgrid: process.env.SENDGRID_API_KEY!,
  },
});
```

3. Manual OAuth flow in app UI

```ts
const { url } = await Evolve.composio.auth("user_123", "github");
const status = await Evolve.composio.status("user_123");
const isGitHubConnected = await Evolve.composio.status("user_123", "github");
const connections = await Evolve.composio.connections("user_123");
```

4. White-label OAuth

```ts
new Evolve().withComposio("user_123", {
  toolkits: ["github"],
  authConfigs: { github: "ac_your_custom_oauth_app" },
});
```

### Tool filtering

```ts
new Evolve().withComposio("user_123", {
  toolkits: ["github", "gmail", "slack"],
  tools: {
    github: ["github_create_issue", "github_list_repos"],
    gmail: { disable: ["gmail_delete_email"] },
    slack: { tags: ["readOnlyHint"] },
  },
});
```

## MCP Server Transport Rules

| Fields | Transport |
|---|---|
| `command` | stdio (local subprocess) |
| `url` + `type: "http"` | HTTP (remote) |
| `url` with no `type` | SSE (remote, default) |

## Full Contracts

See [10 Reference](./10-reference.md) for:
- `McpServerConfig`
- `ComposioSetup`, `ComposioConfig`, `ToolsFilter`
