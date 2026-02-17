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
- **Checkpointing:** Snapshot sandbox state to Evolve-managed storage with `.withStorage()`—no S3 credentials needed. See [Storage & Checkpointing](./04-workspace-storage-observability.md#storage--checkpointing).

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
        // SDK reads token from CLAUDE_CODE_OAUTH_TOKEN automatically
    })
    .withSandbox(sandbox);
```

### BYO Codex Subscription

```bash
# Run in terminal, follow login steps:
codex auth --provider openai

# Creates auth file at ~/.codex/auth.json
```

```bash
# .env
CODEX_OAUTH_FILE_PATH=~/.codex/auth.json
E2B_API_KEY=e2b_...
```

```ts
import { Evolve, createE2BProvider } from "@evolvingmachines/sdk";

const sandbox = createE2BProvider({
    apiKey: process.env.E2B_API_KEY,
});

const evolve = new Evolve()
    .withAgent({
        type: "codex",
        // SDK reads auth file from CODEX_OAUTH_FILE_PATH automatically
    })
    .withSandbox(sandbox);
```

### BYO Gemini Subscription

```bash
# Run in terminal, follow login steps:
gemini auth login

# Creates credentials file at ~/.gemini/oauth_creds.json
```

```bash
# .env
GEMINI_OAUTH_FILE_PATH=~/.gemini/oauth_creds.json
E2B_API_KEY=e2b_...
```

```ts
import { Evolve, createE2BProvider } from "@evolvingmachines/sdk";

const sandbox = createE2BProvider({
    apiKey: process.env.E2B_API_KEY,
});

const evolve = new Evolve()
    .withAgent({
        type: "gemini",
        // SDK reads credentials file from GEMINI_OAUTH_FILE_PATH automatically
    })
    .withSandbox(sandbox);
```

---

### 1.1.3 Agent Reference

Set env vars and the SDK picks them up automatically—no need to pass explicitly.

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

```ts
// kimi (auto-picks KIMI_API_KEY + E2B_API_KEY)
const evolve = new Evolve()
    .withAgent({ type: "kimi" });

const evolve = new Evolve()
    .withAgent({ type: "kimi", model: "moonshot/kimi-k2-turbo-preview" });
```

```ts
// opencode — multi-provider (auto-picks OPENAI_API_KEY + E2B_API_KEY)
const evolve = new Evolve()
    .withAgent({ type: "opencode" });

const evolve = new Evolve()
    .withAgent({ type: "opencode", model: "anthropic/claude-sonnet-4-5" });
```

---
