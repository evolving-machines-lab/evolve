# Getting Started

Run terminal-based AI agents in secure sandboxes with built-in observability.

> See the [main README](../../README.md) for installation and API keys.

---

## Quick Start

```bash
# .env
EVOLVE_API_KEY=sk-...          # Evolve gateway key (dashboard.evolvingmachines.ai)
COMPOSIO_API_KEY=...           # Composio integrations (app.composio.dev)
```

Evolve auto-resolves API keys from environment variables.

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withAgent({
        apiKey: process.env.EVOLVE_API_KEY!,
    })
    .withSessionTagPrefix("my-app")
    .withSystemPrompt("You are Manus Evolve, a powerful AI agent.")
    .withSkills(["pdf", "docx", "pptx"])
    .withComposio("user_123", { toolkits: ["gmail", "notion", "exa"] });

const result = await evolve.run({
    prompt: "Go to Hacker News top posts. Spawn 5 parallel sub-agents to screenshot each of the top 5 posts."
});

console.log(result.stdout);

const output = await evolve.getOutputFiles();
for (const [name, content] of Object.entries(output.files)) {
    console.log(name);
}

await evolve.kill();
```

## Gateway Features

When using `EVOLVE_API_KEY`:

- **Tracing:** Automatic tracing and agent analytics at [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) — no extra setup needed. Use `withSessionTagPrefix()` to label sessions.
- **Browser Automation:** `browser-use` integration included — agents can browse the web, take screenshots, fill forms out of the box.
- **Checkpointing:** Snapshot sandbox state to Evolve-managed storage with `.withStorage()` — no S3 credentials needed. See [Storage & Checkpointing](04-storage-and-observability.md).

---

## Authentication

| | Gateway Mode | BYOK Mode |
|---|---------|---------------|
| Setup | `EVOLVE_API_KEY` | [Model provider keys](#agent-reference) + [`E2B_API_KEY`](https://e2b.dev) |
| Observability | [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) | `~/.evolve-sdk/observability/` |
| Browser | `browser-use` integrated | Via skills or MCP |
| Billing | Evolving Machines | Your provider accounts |

### Gateway Mode (EVOLVE_API_KEY)

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

### BYOK Mode

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

### BYO Subscriptions

Use your existing Claude Max, Codex, or Gemini subscription instead of API keys. Pattern:

```bash
# 1. Authenticate with the CLI to get a token/credentials file
claude --setup-token
# ✓ Long-lived authentication token created successfully!

# 2. Set env var + sandbox key
# .env
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-...
E2B_API_KEY=e2b_...
```

```ts
import { Evolve, createE2BProvider } from "@evolvingmachines/sdk";

const sandbox = createE2BProvider({ apiKey: process.env.E2B_API_KEY });

const evolve = new Evolve()
    .withAgent({
        type: "claude",
        // SDK reads token from env automatically
    })
    .withSandbox(sandbox);
```

All three subscriptions follow this pattern — authenticate via CLI, set the env var, and the SDK picks it up:

| Subscription | CLI Command | Env Var | Auto-Reads |
|-------------|------------|---------|------------|
| Claude Max | `claude --setup-token` | `CLAUDE_CODE_OAUTH_TOKEN` | OAuth token (valid 1 year) |
| Codex | `codex auth --provider openai` | `CODEX_OAUTH_FILE_PATH` | Auth file at `~/.codex/auth.json` |
| Gemini | `gemini auth login` | `GEMINI_OAUTH_FILE_PATH` | Credentials at `~/.gemini/oauth_creds.json` |

---

## Agent Reference

Set env vars and the SDK picks them up automatically — no need to pass explicitly.

| type | models | default | env var (BYOK) |
|------|--------|---------|----------------|
| `"claude"` | `"opus"` `"sonnet"` `"haiku"` | `"opus"` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |
| `"codex"` | `"gpt-5.2"` `"gpt-5.2-codex"` `"gpt-5.1-codex-max"` `"gpt-5.1-mini"` | `"gpt-5.2"` | `OPENAI_API_KEY` or `CODEX_OAUTH_FILE_PATH` |
| `"gemini"` | `"gemini-3-pro-preview"` `"gemini-3-flash-preview"` `"gemini-2.5-pro"` `"gemini-2.5-flash"` `"gemini-2.5-flash-lite"` | `"gemini-3-flash-preview"` | `GEMINI_API_KEY` or `GEMINI_OAUTH_FILE_PATH` |
| `"qwen"` | `"qwen3-coder-plus"` `"qwen3-vl-plus"` | `"qwen3-coder-plus"` | `OPENAI_API_KEY` |
| `"kimi"` | `"moonshot/kimi-k2.5"` `"moonshot/kimi-k2-turbo-preview"` | `"moonshot/kimi-k2.5"` | `KIMI_API_KEY` |
| `"opencode"` | `"openai/gpt-5.2"` `"anthropic/claude-sonnet-4-5"` `"anthropic/claude-opus-4-6"` `"google/gemini-3-pro-preview"` | `"openai/gpt-5.2"` | Per model: `OPENAI_API_KEY` `ANTHROPIC_API_KEY` `GEMINI_API_KEY` |

Agent-specific options: `reasoningEffort` (Codex: `"low"` `"medium"` `"high"` `"xhigh"`), `betas` (Claude Sonnet: `["context-1m-2025-08-07"]`)

### Agent Examples

```bash
# .env - set env vars for auto-pickup
ANTHROPIC_API_KEY=sk-...   # claude
OPENAI_API_KEY=sk-...      # codex, qwen, opencode
GEMINI_API_KEY=...         # gemini
KIMI_API_KEY=...           # kimi
E2B_API_KEY=e2b_...        # sandbox
```

```ts
// Claude — model selection and betas
const evolve = new Evolve()
    .withAgent({ type: "claude" });

const evolve = new Evolve()
    .withAgent({
        type: "claude",
        model: "sonnet",
        betas: ["context-1m-2025-08-07"],
    });
```

```ts
// Codex — reasoning effort control
const evolve = new Evolve()
    .withAgent({ type: "codex" });

const evolve = new Evolve()
    .withAgent({ type: "codex", reasoningEffort: "high" });
```

All other agent types (`gemini`, `qwen`, `kimi`, `opencode`) follow the same pattern — `new Evolve().withAgent({ type: "..." })` with optional `model`.

---

**Next:** [Configuration](02-configuration.md) for sandbox providers, builder methods, skills, and Composio integrations.
