# 01. Getting Started & Setup

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
- **Checkpointing:** Snapshot sandbox state to Evolve-managed storage with `.withStorage()`—no S3 credentials needed. See [Storage & Checkpointing](../typescript-sdk.md#51-storage--checkpointing).

---

## 2. Authentication

| | Gateway Mode | BYOK Mode |
|---|---------|---------------|
| Setup | `EVOLVE_API_KEY` | Model provider keys + [`E2B_API_KEY`](https://e2b.dev) |
| Observability | [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) | `~/.evolve-sdk/observability/` |
| Browser | `browser-use` integrated | Via skills or MCP |
| Billing | Evolving Machines | Your provider accounts |

### 2.1 Gateway Mode (EVOLVE_API_KEY)

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

### 2.2 BYOK Mode

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

#### BYO Claude Max Subscription

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

#### BYO Codex Subscription

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

#### BYO Gemini Subscription

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

### 2.3 Agent Reference

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

## 3. Sandbox Providers

Works with both Gateway mode (`EVOLVE_API_KEY`) and BYOK mode (provider API keys). With `EVOLVE_API_KEY` only, sandbox defaults to **E2B**. Add a sandbox provider key to auto-resolve to that provider.

All providers use the `evolve-all` image with pre-installed CLIs.

| Provider | Env Vars | Auto-Resolves When | First Time Setup |
|----------|----------|-------------------|------------------|
| E2B | `E2B_API_KEY` | Default, or `E2B_API_KEY` set | None — instant |
| Modal | `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` | Both Modal vars set | None — auto-builds image on first run (~2 min) |
| Daytona | `DAYTONA_API_KEY` | `DAYTONA_API_KEY` set | None — auto-creates snapshot on first run (~5 min) |

See [assets/README.md](../assets/README.md) for detailed setup instructions.

### 3.1 Auto-Resolution

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

```ts
import { createE2BProvider } from "@evolvingmachines/sdk";

const sandbox = createE2BProvider({
    apiKey: process.env.E2B_API_KEY,       // (optional) Auto-resolves from env
    defaultTimeoutMs: 3600000,             // (optional) Default: 3600000 (1 hour)
    templateId: "my-custom-template",      // (optional) E2B template ID. Default: "evolve-all"
});
```

### Modal

```ts
import { createModalProvider } from "@evolvingmachines/sdk";

const sandbox = createModalProvider({
    tokenId: process.env.MODAL_TOKEN_ID,         // (optional) Auto-resolves from env
    tokenSecret: process.env.MODAL_TOKEN_SECRET, // (optional) Auto-resolves from env
    appName: "my-app",                           // (optional) Default: "evolve-sandbox"
    defaultTimeoutMs: 3600000,                   // (optional) Default: 3600000 (1 hour)
    endpoint: "https://api.modal.com:443",       // (optional) Default: https://api.modal.com:443
    imageName: "evolve-all",                     // (optional) Default: "evolve-all"
});
```

### Daytona

```ts
import { createDaytonaProvider } from "@evolvingmachines/sdk";

const sandbox = createDaytonaProvider({
    apiKey: process.env.DAYTONA_API_KEY,     // (optional) Auto-resolves from env
    apiUrl: "https://app.daytona.io/api",    // (optional) Default: https://app.daytona.io/api
    target: "us",                            // (optional) Target region. Default: "us"
    defaultTimeoutMs: 3600000,               // (optional) Default: 3600000 (1 hour) - converted to minutes for auto-stop
    snapshotName: "evolve-all",              // (optional) Default: "evolve-all". Custom snapshots via build.sh daytona
});
```

---

## 4. Setup Notes (Runtime Behavior)

- Configuration methods can be chained in any order.
- The sandbox is created on the first `run()` or `executeCommand()` call.
- Context files, workspace files, MCP servers, and system prompt are set up once on the first call.
- Using `.withSession()` to reconnect skips setup since the sandbox already exists.
- Calling `run()` multiple times maintains the agent context / history.
- Calling `run()` while another run or command is active throws immediately. Call `interrupt()` first or wait for the active operation to finish.
