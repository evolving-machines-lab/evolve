# Evolve TypeScript SDK

Run CLI agents ([Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi CLI](https://github.com/MoonshotAI/kimi-cli), [OpenCode](https://github.com/anomalyco/opencode)) in secure sandboxes with built-in observability.

---

## Installation

**Requirements:** [Node.js 18+](https://nodejs.org/)

```bash
npm install @evolvingmachines/sdk
```

Optional peer dependencies (only needed for [S3 checkpointing](./03-runtime.md#storage--checkpointing)):

```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
```

For structured output with [Zod](https://zod.dev) schemas (recommended but not required — JSON Schema objects also work):

```bash
npm install zod
```

---

## Quick Start

**1. Get your API key** from [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) — $10 free credits, no CC required.

**2. Set environment variables:**

```bash
# .env
EVOLVE_API_KEY=sk-...        # Evolve gateway key (dashboard.evolvingmachines.ai)
COMPOSIO_API_KEY=...         # (optional) Composio integrations (app.composio.dev)
```

**3. Run your first agent:**

Evolve auto-resolves API keys and sandbox providers from environment variables — no need to pass them explicitly.

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
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

### Core Lifecycle

Every Evolve application follows this pattern:

```
new Evolve()  →  .run()  →  .getOutputFiles()  →  .kill()
   setup         execute      retrieve results     ALWAYS cleanup
```

> **IMPORTANT: Always call `kill()` when done.** Each `run()` creates a cloud sandbox that bills until destroyed. Forgetting `kill()` leaves sandboxes running indefinitely. Use try/finally to guarantee cleanup:

```ts
const evolve = new Evolve().withAgent({ type: "claude" });
try {
    await evolve.run({ prompt: "Analyze the dataset" });
    const output = await evolve.getOutputFiles();
    console.log(output.files);           // All files from output/
    console.log(output.data);            // Parsed result.json (if schema set)
} finally {
    await evolve.kill();                 // Always destroy sandbox
}
```

- `run()` can be called multiple times — each continues in the same sandbox session with full context/history.
- `getOutputFiles()` returns files from the `output/` folder. If `.withSchema()` was set, `output.data` contains the validated result.
- `kill()` destroys the sandbox. The next `run()` creates a fresh one.

### Streaming

Subscribe to real-time agent output:

```ts
evolve.on("content", (event) => {
    // event.update.sessionUpdate: "agent_message_chunk" | "tool_call" | "plan" | ...
    console.log(event.update);
});

evolve.on("lifecycle", (event) => {
    // event.reason: "sandbox_ready" | "run_complete" | "run_failed" | ...
    console.log(event.reason, event.sandbox, event.agent);
});
```

See [Streaming Events](./04-streaming.md) for all event types, type definitions, and a full UI integration example.

### Gateway Features

When using `EVOLVE_API_KEY`:

- **Tracing:** Automatic tracing and agent analytics at [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) for observability and replay — no extra setup needed. Use `withSessionTagPrefix()` to label sessions for easy filtering.
- **Browser Automation:** `browser-use` integration included — agents can browse the web, take screenshots, fill forms, and interact with pages out of the box.
- **Checkpointing:** Snapshot sandbox state to Evolve-managed storage with `.withStorage()` — no S3 credentials needed. See [Storage & Checkpointing](./03-runtime.md#storage--checkpointing).

---

## Authentication

| | Gateway Mode | BYOK Mode |
|---|---------|---------------|
| Setup | `EVOLVE_API_KEY` | [Model provider keys](#agent-reference) + [`E2B_API_KEY`](https://e2b.dev) |
| Observability | [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) | `~/.evolve-sdk/observability/` |
| Browser | `browser-use` integrated | Via skills or MCP |
| Billing | Evolving Machines | Your provider accounts |

---

### Gateway Mode (EVOLVE_API_KEY)

Get API key from [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai).

```bash
# .env
EVOLVE_API_KEY=sk-...
```

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withAgent({ type: "claude" });

await evolve.run({ prompt: "Hello" });
```

---

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

### BYO Claude Max Subscription

```bash
# Run in terminal, follow login steps -> receive token:
claude --setup-token

# Long-lived authentication token created successfully!
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

### Agent Reference

Set env vars and the SDK picks them up automatically — no need to pass explicitly.

> **IMPORTANT: Only use the exact model names listed below.** The SDK will error on unrecognized model names. Do not invent or guess model identifiers.

| type | models | default | Gateway | BYOK |
|------|--------|---------|---------|------|
| `"claude"` | `"opus"` `"sonnet"` `"haiku"` | `"sonnet"` | `EVOLVE_API_KEY` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |
| `"codex"` | `"gpt-5.2"` `"gpt-5.2-codex"` `"gpt-5.1-codex-max"` `"gpt-5.1-mini"` | `"gpt-5.2"` | `EVOLVE_API_KEY` | `OPENAI_API_KEY` or `CODEX_OAUTH_FILE_PATH` |
| `"gemini"` | `"gemini-3.1-pro-preview"` `"gemini-3-pro-preview"` `"gemini-3-flash-preview"` `"gemini-2.5-pro"` `"gemini-2.5-flash"` `"gemini-2.5-flash-lite"` | `"gemini-3-flash-preview"` | `EVOLVE_API_KEY` | `GEMINI_API_KEY` or `GEMINI_OAUTH_FILE_PATH` |
| `"qwen"` | `"qwen3.5-plus"` `"qwen3-coder-plus"` `"qwen3-vl-plus"` | `"qwen3.5-plus"` | `EVOLVE_API_KEY` | `OPENAI_API_KEY` |
| `"kimi"` | `"moonshot/kimi-k2.5"` `"moonshot/kimi-k2-turbo-preview"` | `"moonshot/kimi-k2.5"` | `EVOLVE_API_KEY` | `KIMI_API_KEY` |
| `"opencode"` | `"openrouter/anthropic/claude-opus-4.6"` `"openrouter/anthropic/claude-sonnet-4.6"` `"openrouter/anthropic/claude-haiku-4.5"` `"openrouter/openai/gpt-5.2"` `"openrouter/openai/gpt-5.2-codex"` `"openrouter/openai/gpt-5.1-codex-max"` `"openrouter/google/gemini-3.1-pro-preview"` `"openrouter/google/gemini-3-pro-preview"` `"openrouter/google/gemini-3-flash-preview"` `"openrouter/qwen/qwen3-coder-plus"` `"openrouter/moonshotai/kimi-k2.5"` `"openrouter/z-ai/glm-5"` | `"openrouter/anthropic/claude-sonnet-4.6"` | `EVOLVE_API_KEY` | `OPENROUTER_API_KEY` |

> **Note:** In Gateway mode (`EVOLVE_API_KEY`), the default claude model is `"opus"`. In BYOK mode, it defaults to `"sonnet"`.

Agent-specific options: `reasoningEffort` (Codex: `"low"` `"medium"` `"high"` `"xhigh"`), `betas` (Claude Sonnet: `["context-1m-2025-08-07"]`)

### Agent Examples

```bash
# .env - set env vars for auto-pickup
ANTHROPIC_API_KEY=sk-...   # claude
OPENAI_API_KEY=sk-...      # codex, qwen
GEMINI_API_KEY=...         # gemini
KIMI_API_KEY=...           # kimi
OPENROUTER_API_KEY=sk-...  # opencode
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
// opencode — OpenRouter (auto-picks OPENROUTER_API_KEY + E2B_API_KEY)
const evolve = new Evolve()
    .withAgent({ type: "opencode" });

const evolve = new Evolve()
    .withAgent({ type: "opencode", model: "openrouter/openai/gpt-5.2" });
```

---
