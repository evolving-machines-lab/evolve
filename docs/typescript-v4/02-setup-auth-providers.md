# Setup, Auth, Providers

## At a Glance

- Choose auth mode first (Gateway vs BYOK vs subscription credentials).
- Provider can auto-resolve from env vars.
- Use explicit provider constructors only for custom settings.

## Auth Mode Matrix

| | Gateway | BYOK API Keys | BYO Subscription Credentials |
|---|---|---|---|
| Primary env | `EVOLVE_API_KEY` | provider key (`ANTHROPIC_API_KEY`, etc.) | `CLAUDE_CODE_OAUTH_TOKEN` / `CODEX_OAUTH_FILE_PATH` / `GEMINI_OAUTH_FILE_PATH` |
| Sandbox key needed | optional (`E2B_API_KEY` can still be set) | yes | yes |
| Observability | dashboard + local logs | local logs | local logs |
| Billing | Evolving Machines | your provider accounts | your subscriptions |

## Gateway Mode (recommended)

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

## BYOK API Keys

```bash
# .env
ANTHROPIC_API_KEY=sk-...
E2B_API_KEY=e2b_...
```

```ts
import { Evolve, createE2BProvider } from "@evolvingmachines/sdk";

const sandbox = createE2BProvider({ apiKey: process.env.E2B_API_KEY });

const evolve = new Evolve()
  .withAgent({ type: "claude", providerApiKey: process.env.ANTHROPIC_API_KEY })
  .withSandbox(sandbox);
```

## BYO Subscriptions

| Agent | Setup command | Env var |
|---|---|---|
| Claude | `claude --setup-token` | `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex | `codex auth --provider openai` | `CODEX_OAUTH_FILE_PATH` |
| Gemini | `gemini auth login` | `GEMINI_OAUTH_FILE_PATH` |

```bash
# .env example
CLAUDE_CODE_OAUTH_TOKEN=sk-ant-...
CODEX_OAUTH_FILE_PATH=~/.codex/auth.json
GEMINI_OAUTH_FILE_PATH=~/.gemini/oauth_creds.json
E2B_API_KEY=e2b_...
```

## Agent Reference

The SDK auto-resolves env vars by `type`.

| type | models | default | env var (BYOK) |
|---|---|---|---|
| `"claude"` | `"opus"` `"sonnet"` `"haiku"` | `"opus"` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |
| `"codex"` | `"gpt-5.2"` `"gpt-5.2-codex"` `"gpt-5.1-codex-max"` `"gpt-5.1-mini"` | `"gpt-5.2"` | `OPENAI_API_KEY` or `CODEX_OAUTH_FILE_PATH` |
| `"gemini"` | `"gemini-3-pro-preview"` `"gemini-3-flash-preview"` `"gemini-2.5-pro"` `"gemini-2.5-flash"` `"gemini-2.5-flash-lite"` | `"gemini-3-flash-preview"` | `GEMINI_API_KEY` or `GEMINI_OAUTH_FILE_PATH` |
| `"qwen"` | `"qwen3-coder-plus"` `"qwen3-vl-plus"` | `"qwen3-coder-plus"` | `OPENAI_API_KEY` |
| `"kimi"` | `"moonshot/kimi-k2.5"` `"moonshot/kimi-k2-turbo-preview"` | `"moonshot/kimi-k2.5"` | `KIMI_API_KEY` |
| `"opencode"` | `"openai/gpt-5.2"` `"anthropic/claude-sonnet-4-5"` `"anthropic/claude-opus-4-6"` `"google/gemini-3-pro-preview"` | `"openai/gpt-5.2"` | model-specific (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`) |

Agent-specific options:
- `reasoningEffort` for Codex (`"low" | "medium" | "high" | "xhigh"`)
- `betas` for Claude Sonnet (example: `"context-1m-2025-08-07"`)

## Sandbox Provider Auto-Resolution

| Provider | Env vars | Auto-resolves when | First run setup |
|---|---|---|---|
| E2B | `E2B_API_KEY` | default, or `E2B_API_KEY` set | instant |
| Modal | `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` | both vars set | image build (~2 min) |
| Daytona | `DAYTONA_API_KEY` | var set | snapshot create (~5 min) |

All providers default to `evolve-all` image.

```bash
# .env examples
EVOLVE_API_KEY=sk-...
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...

EVOLVE_API_KEY=sk-...
DAYTONA_API_KEY=...

ANTHROPIC_API_KEY=sk-ant-...
E2B_API_KEY=e2b_...
```

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve().withAgent({ type: "claude" });
// no withSandbox() needed when env auto-resolution is enough
```

## Explicit Provider Constructors (optional)

```ts
import {
  createDaytonaProvider,
  createE2BProvider,
  createModalProvider,
} from "@evolvingmachines/sdk";

const e2b = createE2BProvider({
  apiKey: process.env.E2B_API_KEY,
  defaultTimeoutMs: 3_600_000,
  templateId: "evolve-all",
});

const modal = createModalProvider({
  tokenId: process.env.MODAL_TOKEN_ID,
  tokenSecret: process.env.MODAL_TOKEN_SECRET,
  appName: "evolve-sandbox",
  endpoint: "https://api.modal.com:443",
  imageName: "evolve-all",
  defaultTimeoutMs: 3_600_000,
});

const daytona = createDaytonaProvider({
  apiKey: process.env.DAYTONA_API_KEY,
  apiUrl: "https://app.daytona.io/api",
  target: "us",
  snapshotName: "evolve-all",
  defaultTimeoutMs: 3_600_000,
});
```

Detailed asset setup notes: [`../../assets/README.md`](../../assets/README.md)

## Next

- Runtime behavior: [03 Runtime Core](./03-runtime-core.md)
- Integrations (skills/composio/mcp): [07 Integrations](./07-integrations.md)
- Exhaustive type contracts: [10 Reference](./10-reference.md)
