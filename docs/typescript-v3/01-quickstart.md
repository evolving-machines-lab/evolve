# Quickstart

## 60-Second Start (Gateway Mode)

```bash
# .env
EVOLVE_API_KEY=sk-...
COMPOSIO_API_KEY=...
```

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
  .withAgent({ apiKey: process.env.EVOLVE_API_KEY! })
  .withSessionTagPrefix("my-app")
  .withSystemPrompt("You are a powerful AI coding agent.")
  .withSkills(["pdf", "docx", "pptx"])
  .withComposio("user_123", { toolkits: ["gmail", "notion", "exa"] });

const result = await evolve.run({
  prompt: "Open Hacker News, inspect top posts, and summarize trends."
});

console.log(result.stdout);

const output = await evolve.getOutputFiles();
for (const name of Object.keys(output.files)) console.log(name);

await evolve.kill();
```

## Gateway vs BYOK

| | Gateway Mode | BYOK Mode |
|---|---|---|
| Primary auth | `EVOLVE_API_KEY` | Provider keys + sandbox key |
| Observability | `dashboard.evolvingmachines.ai` | local JSONL logs (`~/.evolve-sdk/observability/`) |
| Browser automation | `browser-use` included | via skills/MCP |
| Billing | Evolving Machines | your provider accounts |

Gateway feature notes:
- tracing and replay in dashboard
- browser-use integration out of the box
- managed checkpointing with `.withStorage()` (no S3 creds)

## Authentication Patterns

### A. Gateway (recommended)

```bash
# .env
EVOLVE_API_KEY=sk-...
```

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve().withAgent({
  type: "claude",
  apiKey: process.env.EVOLVE_API_KEY,
});

await evolve.run({ prompt: "Hello" });
```

### B. BYOK with provider API key

```bash
# .env
ANTHROPIC_API_KEY=sk-...
E2B_API_KEY=e2b_...
```

```ts
import { Evolve, createE2BProvider } from "@evolvingmachines/sdk";

const sandbox = createE2BProvider({ apiKey: process.env.E2B_API_KEY });

const evolve = new Evolve()
  .withAgent({
    type: "claude",
    providerApiKey: process.env.ANTHROPIC_API_KEY,
  })
  .withSandbox(sandbox);
```

### C. BYO subscription auth (OAuth files/tokens)

| Agent | Terminal setup | Env var |
|---|---|---|
| Claude | `claude --setup-token` | `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex | `codex auth --provider openai` | `CODEX_OAUTH_FILE_PATH` |
| Gemini | `gemini auth login` | `GEMINI_OAUTH_FILE_PATH` |

```bash
# Example .env
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-...
CODEX_OAUTH_FILE_PATH=~/.codex/auth.json
GEMINI_OAUTH_FILE_PATH=~/.gemini/oauth_creds.json
E2B_API_KEY=e2b_...
```

```ts
import { Evolve, createE2BProvider } from "@evolvingmachines/sdk";

const sandbox = createE2BProvider({ apiKey: process.env.E2B_API_KEY });

const claude = new Evolve().withAgent({ type: "claude" }).withSandbox(sandbox);
const codex = new Evolve().withAgent({ type: "codex" }).withSandbox(sandbox);
const gemini = new Evolve().withAgent({ type: "gemini" }).withSandbox(sandbox);
```

## Agent Reference

The SDK auto-picks env vars by `type`.

| type | models | default | env var (BYOK) |
|---|---|---|---|
| `"claude"` | `"opus"` `"sonnet"` `"haiku"` | `"opus"` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |
| `"codex"` | `"gpt-5.2"` `"gpt-5.2-codex"` `"gpt-5.1-codex-max"` `"gpt-5.1-mini"` | `"gpt-5.2"` | `OPENAI_API_KEY` or `CODEX_OAUTH_FILE_PATH` |
| `"gemini"` | `"gemini-3-pro-preview"` `"gemini-3-flash-preview"` `"gemini-2.5-pro"` `"gemini-2.5-flash"` `"gemini-2.5-flash-lite"` | `"gemini-3-flash-preview"` | `GEMINI_API_KEY` or `GEMINI_OAUTH_FILE_PATH` |
| `"qwen"` | `"qwen3-coder-plus"` `"qwen3-vl-plus"` | `"qwen3-coder-plus"` | `OPENAI_API_KEY` |
| `"kimi"` | `"moonshot/kimi-k2.5"` `"moonshot/kimi-k2-turbo-preview"` | `"moonshot/kimi-k2.5"` | `KIMI_API_KEY` |
| `"opencode"` | `"openai/gpt-5.2"` `"anthropic/claude-sonnet-4-5"` `"anthropic/claude-opus-4-6"` `"google/gemini-3-pro-preview"` | `"openai/gpt-5.2"` | model-specific (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) |

Agent options:
- `reasoningEffort`: Codex only (`"low" | "medium" | "high" | "xhigh"`)
- `betas`: Claude Sonnet betas (example: `"context-1m-2025-08-07"`)

## Minimal Agent Examples

```bash
# .env for auto-pickup
ANTHROPIC_API_KEY=sk-...
OPENAI_API_KEY=sk-...
GEMINI_API_KEY=...
KIMI_API_KEY=...
E2B_API_KEY=e2b_...
```

```ts
import { Evolve } from "@evolvingmachines/sdk";

const claude = new Evolve().withAgent({ type: "claude" });
const codex = new Evolve().withAgent({ type: "codex", reasoningEffort: "high" });
const gemini = new Evolve().withAgent({ type: "gemini", model: "gemini-3-pro-preview" });
const qwen = new Evolve().withAgent({ type: "qwen" });
const kimi = new Evolve().withAgent({ type: "kimi", model: "moonshot/kimi-k2-turbo-preview" });
const opencode = new Evolve().withAgent({ type: "opencode", model: "anthropic/claude-sonnet-4-5" });
```

## Next

- Provider + skills + Composio setup: [Configuration](./02-configuration.md)
- `run()` and file flow: [Runtime Core](./03-runtime-core.md)
