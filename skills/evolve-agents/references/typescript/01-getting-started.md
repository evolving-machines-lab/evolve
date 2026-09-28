# Evolve TypeScript SDK

Run CLI agents ([Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-code), [OpenCode](https://github.com/anomalyco/opencode), [Droid](https://docs.factory.ai/cli/droid-exec/overview), [pi](https://github.com/earendil-works/pi), [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [Z Code](https://github.com/zai-org/ZCode), [Antigravity](https://antigravity.google/docs/cli/overview/)) in secure sandboxes with built-in observability.

---

## Installation

**Requirements:** [Node.js 18+](https://nodejs.org/)

```bash
npm install @evolvingmachines/evolve
```

Storage & checkpointing is available in [gateway mode](./03-runtime.md#storage--checkpointing) (`EVOLVE_API_KEY`) — no additional dependencies needed.

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
```

**3. Run your first agent:**

Evolve auto-resolves API keys and sandbox providers from environment variables — no need to pass them explicitly.

```ts
import { Evolve } from "@evolvingmachines/evolve";

const evolve = new Evolve()
  .withSystemPrompt("You are Manus Evolve, a powerful AI agent. You can execute code, browse the web, manage files, and solve complex tasks.")
  .withBrowser()  // optional; defaults to remote managed agent-browser automation in Gateway mode
  .withSkills(["anthropics/skills", "./my-skill"])  // skills.sh / git / local references
  .withIntegrations({ userId: "root", apps: ["gmail", "notion"] });  // optional; managed integrations in Gateway mode

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

> **Always call `kill()` when done.** The first run creates a sandbox; later runs reuse it. Use `try/finally` to clean up even when a run fails:

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
- **Browser Automation:** Call `.withBrowser()` for the default and recommended managed browser path with dashboard live view and replay.
- **Checkpointing:** Snapshot sandbox state to Evolve-managed storage with `.withStorage()` — no S3 credentials needed. See [Storage & Checkpointing](./03-runtime.md#storage--checkpointing).
- **Hosted Evals:** Score agents against datasets of tasks on managed infrastructure with `jobs()` and `datasets()`, or the `evolve` CLI. See https://docs.evolvingmachines.ai.

---

## Authentication

| | Gateway Mode | Managed BYO Provider Keys | Direct Provider Key Mode |
|---|---------|---------------------------|--------------------------|
| Setup | `EVOLVE_API_KEY` | `EVOLVE_API_KEY` + provider key saved in Dashboard → Secrets → BYO Provider Keys | [Model provider credentials](#direct-provider-credentials) + [sandbox provider credentials](./02-configuration.md#sandbox-providers) |
| Provider key location | Evolve-managed | Encrypted Dashboard secret | Your local environment or app config |
| Sandbox receives | Evolve gateway runtime config | A short-lived, sandbox-scoped credential — never your raw provider key or `EVOLVE_API_KEY` for that route | Your provider credentials |
| Observability | [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) | [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) | `~/.evolve-sdk/observability/` |
| Browser | `.withBrowser()` is the default and recommended managed browser path with live view and replay. | Same as Gateway Mode | Self-managed browser runtime; no managed live/replay |
| Model billing | Evolving Machines | Your provider account for enabled providers | Your provider accounts |

---

### Gateway Mode (EVOLVE_API_KEY)

Get API key from [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai).

```bash
# .env
EVOLVE_API_KEY=sk-...
```

```ts
import { Evolve } from "@evolvingmachines/evolve";

const evolve = new Evolve()
  .withAgent({ type: "claude" });

await evolve.run({ prompt: "Hello" });
```

---

### Managed BYO Provider Keys

Use this when you want supported provider usage billed to your provider account while keeping gateway features.

1. Save your provider key in Dashboard → Secrets → BYO Provider Keys.
2. Keep `EVOLVE_API_KEY` in your app.
3. Run any supported agent normally.

Managed BYO Provider Keys currently supports **Anthropic and OpenAI**. Enable the matching key to bill supported requests to your provider account. Other providers use Evolve-managed model access.

The sandbox receives a short-lived credential scoped to that sandbox, not your saved provider key. If no managed key is enabled for the provider, Evolve uses its own model access.

---

### Direct Provider Key Mode (Local BYOK)

Use provider keys from your environment or app config together with your own [sandbox provider credentials](./02-configuration.md#sandbox-providers). E2B, Daytona, and Modal are supported; the example below uses E2B.

```bash
# .env
ANTHROPIC_API_KEY=sk-...
E2B_API_KEY=e2b_...
```

```ts
import { Evolve, createE2BProvider } from "@evolvingmachines/evolve";

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
import { Evolve, createE2BProvider } from "@evolvingmachines/evolve";

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
import { Evolve, createE2BProvider } from "@evolvingmachines/evolve";

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

---

### Agent Reference

Choose an agent with `withAgent({ type })` and a model with `model`. If you omit `model`, the SDK uses the default below.

| Agent | Default model |
| --- | --- |
| `claude` | `opus` |
| `codex` | `gpt-6-sol` |
| `qwen` | `qwen3.8-max` |
| `kimi` | `kimi-k3` |
| `opencode` | `openrouter/anthropic/claude-opus-5.5` |
| `droid` | `claude-opus-5-5` |
| `pi` | `openrouter/anthropic/claude-opus-5.5` |
| `prime-agent` | `openrouter/anthropic/claude-opus-5.5` |
| `dsh` | `openrouter/deepseek/deepseek-v4.1-flash` |
| `zcode` | `openrouter/z-ai/glm-5.3` |
| `antigravity` | `gemini-3.8-flash` |

Open the [model and effort reference](https://docs.evolvingmachines.ai/core-concepts/models#model-and-effort-reference) for each agent's full model list, exact spellings, and reasoning levels. These names describe Evolve model access with `EVOLVE_API_KEY`. Your own provider key may support a different set.

The agent SDK can accept other nonempty model IDs for a configured provider or external gateway. Configuration acceptance does not establish that the provider supports that model. Managed evaluation jobs instead require an explicit model from the selected agent's published roster.

`gemini` is retired for new runs; use `antigravity`. Historical Gemini runs remain readable.

#### Direct Provider Credentials

The SDK reads these environment variables automatically in Direct Provider Key Mode. Managed BYO Provider Keys use `EVOLVE_API_KEY` and a key saved in the dashboard instead.

| Agent | Direct credential |
| --- | --- |
| `claude` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |
| `codex` | `OPENAI_API_KEY` or `CODEX_OAUTH_FILE_PATH` |
| `qwen` | `OPENAI_API_KEY` |
| `kimi` | `KIMI_API_KEY` |
| `opencode`, `pi`, `prime-agent`, `dsh`, `zcode` | `OPENROUTER_API_KEY` |
| `droid` | `FACTORY_API_KEY` |
| `antigravity` | `GEMINI_API_KEY` |

Use a model available from your provider account. An OpenRouter credential does not grant access to a `fireworks/` model. See the [gateway-only models](#evolve-provided-gateway-models) below.

#### Reasoning Effort

Set `reasoningEffort` to choose a reasoning level. Evolve explicitly applies its own defaults: `thinking` for Qwen, `max` for Kimi, and `high` for the other agents. These defaults can differ from the harness vendor's defaults.

Use the [model and effort reference](https://docs.evolvingmachines.ai/core-concepts/models#model-and-effort-reference) for supported choices. Some SDK spellings have specific behavior:

| Agent | SDK behavior |
| --- | --- |
| `qwen` | `off`, `minimal`, or `no-thinking` disables thinking; `medium` or `thinking` enables it. |
| `kimi` | K3 keeps thinking enabled; use `low`, `high`, or `max`. The legacy `no-thinking` option applies to K2.7. |
| `opencode` | `thinking` selects `medium`; `low` or `minimal` selects `minimal`; `xhigh` selects `max`. `off` or `no-thinking` disables thinking flags. |
| `pi`, `prime-agent` | `thinking` selects `medium`; `no-thinking` selects `off`. The harness limits effort to what the model supports. |
| `dsh` | Only `low`, `medium`, and `high` are accepted. Thinking cannot be disabled. |
| `zcode` | `off`, `minimal`, or `no-thinking` uses the model's default reasoning. `thinking` selects `medium`; `xhigh` and `max` select `high`. |
| `antigravity` | `xhigh` selects `max`; `thinking` selects `medium`. `off`, `minimal`, or `no-thinking` selects `low`; thinking cannot be disabled. |

`no-thinking` is an agent SDK option, not a managed evaluation job value. Use the managed reference's accepted values for `jobs()` or `evolve run`. An accepted setting does not prove every model implements a distinct level.

#### Native Configuration and Presets

For `claude` and `codex`, `config` accepts a local file path or an inline object. Use it for permissions, sandbox settings, and tool behavior. Codex configuration must be representable as TOML, so it cannot contain `null`.

Evolve applies model, reasoning, gateway, and MCP settings over your configuration. Other agents reject `config`.

```ts
const evolve = new Evolve()
  .withAgent({
    type: "claude",
    config: { permissions: { deny: ["WebSearch", "WebFetch"] } },
  });
```

Presets are available on `claude` and `codex`:

| Preset | Effect |
| --- | --- |
| `no-internet` | Disables the harness's server-side web tools. It does not block all sandbox networking. |
| `pinned-context` | Sets a 200,000-token effective context window. |

A preset takes precedence over conflicting `config` settings. Other agents reject `preset`. Use [sandbox network options](./02-configuration.md#sandbox-create-options) to restrict network access from the sandbox.

```ts
const evolve = new Evolve()
  .withAgent({ type: "codex", preset: "no-internet" });
```

#### Harness and Model Pairing

- **Qwen:** choose a Qwen model from its tab in the model reference. Other model families can reject Qwen Code's thinking parameters.

- **OpenCode:** use the complete model ID from its tab. Additional OpenRouter IDs use `openrouter/<vendor>/<model>`; arbitrary provider prefixes do not select a separate direct provider.

- **Kimi:** the SDK supplies a context ceiling. K3 and K3 Raptor use 1,048,576 tokens; K2.7 uses 262,144. Other models default to 128,000. Kimi Code also sends this value as the request's completion limit, so a provider can reject a ceiling above its own limit.

Set `maxContextSize` when you know the model's limit:

```ts
const evolve = new Evolve()
  .withAgent({
    type: "kimi",
    model: "kimi-k3",
    maxContextSize: 1048576,
  });
```

`maxContextSize` is an SDK option, not an environment variable. Harnesses that do not send a ceiling ignore it.

#### Evolve-Provided Gateway Models

Use `EVOLVE_API_KEY` for these models:

| Agent | Gateway-only model |
| --- | --- |
| `kimi` | `kimi-k3-raptor` |
| `opencode`, `dsh` | `fireworks/deepseek-v4.1-flash` |
| `zcode` | `fireworks/glm-5.3`, `fireworks/glm-5.3-flash` |

OpenCode, dsh, and Z Code reject the listed Fireworks models during configuration in Direct Provider Key Mode. Kimi K3 Raptor requires Evolve model access.

### Agent Examples

```bash
# .env - set env vars for auto-pickup
ANTHROPIC_API_KEY=sk-...   # claude
OPENAI_API_KEY=sk-...      # codex, qwen
GEMINI_API_KEY=...         # antigravity
KIMI_API_KEY=...           # kimi
OPENROUTER_API_KEY=sk-...  # opencode, pi, prime-agent, dsh, zcode
FACTORY_API_KEY=...        # droid
E2B_API_KEY=e2b_...        # sandbox
```

```ts
// claude (auto-picks ANTHROPIC_API_KEY + E2B_API_KEY)
const defaultClaude = new Evolve()
  .withAgent({ type: "claude" });

const opusClaude = new Evolve()
  .withAgent({ type: "claude", model: "opus" });

const fableClaude = new Evolve()
  .withAgent({ type: "claude", model: "fable" });

const maxEffortClaude = new Evolve()
  .withAgent({ type: "claude", reasoningEffort: "max" });
```

```ts
// codex (auto-picks OPENAI_API_KEY + E2B_API_KEY)
const defaultCodex = new Evolve()
  .withAgent({ type: "codex" });

const codex53 = new Evolve()
  .withAgent({ type: "codex", model: "gpt-5.3-codex" });

const highEffortCodex = new Evolve()
  .withAgent({ type: "codex", reasoningEffort: "high" });
```

```ts
// qwen (auto-picks OPENAI_API_KEY + E2B_API_KEY)
const defaultQwen = new Evolve()
  .withAgent({ type: "qwen" });

const qwenMax = new Evolve()
  .withAgent({ type: "qwen", model: "qwen3.8-max" });

const qwenWithoutThinking = new Evolve()
  .withAgent({ type: "qwen", reasoningEffort: "no-thinking" });
```

```ts
// kimi (auto-picks KIMI_API_KEY + E2B_API_KEY)
const defaultKimi = new Evolve()
  .withAgent({ type: "kimi" });

const kimiK3 = new Evolve()
  .withAgent({ type: "kimi", model: "kimi-k3" });

// Gateway mode: set EVOLVE_API_KEY for Kimi K3 Raptor.
const kimiRaptor = new Evolve()
  .withAgent({
    type: "kimi",
    model: "kimi-k3-raptor",
    reasoningEffort: "thinking",
  });
```

```ts
// opencode — OpenRouter (auto-picks OPENROUTER_API_KEY + E2B_API_KEY)
const defaultOpenCode = new Evolve()
  .withAgent({ type: "opencode" });

const openCodeSol = new Evolve()
  .withAgent({ type: "opencode", model: "openrouter/openai/gpt-6-sol" });

const openCodeFable = new Evolve()
  .withAgent({ type: "opencode", model: "openrouter/anthropic/claude-fable-5.1" });

const openCodeMaxEffort = new Evolve()
  .withAgent({ type: "opencode", reasoningEffort: "xhigh" });
```

```ts
// droid (auto-picks FACTORY_API_KEY + E2B_API_KEY)
const defaultDroid = new Evolve()
  .withAgent({ type: "droid" });

const droidOpus = new Evolve()
  .withAgent({ type: "droid", model: "claude-opus-5-5" });
```

```ts
// pi (auto-picks OPENROUTER_API_KEY + E2B_API_KEY)
const defaultPi = new Evolve()
  .withAgent({ type: "pi" });

const piSol = new Evolve()
  .withAgent({ type: "pi", model: "openrouter/openai/gpt-6-sol", reasoningEffort: "xhigh" });

// prime-agent (the same key and the same model ids)
const primeAgent = new Evolve()
  .withAgent({ type: "prime-agent", model: "openrouter/anthropic/claude-sonnet-5" });

// dsh — DeepSeek Harness (auto-picks OPENROUTER_API_KEY + E2B_API_KEY)
const defaultDsh = new Evolve()
  .withAgent({ type: "dsh" });

const deepseekPro = new Evolve()
  .withAgent({ type: "dsh", model: "openrouter/deepseek/deepseek-v4-pro-0813" });

// zcode (auto-picks OPENROUTER_API_KEY + E2B_API_KEY)
const defaultZcode = new Evolve()
  .withAgent({ type: "zcode" });

const glmFlash = new Evolve()
  .withAgent({ type: "zcode", model: "openrouter/z-ai/glm-5.3-flash" });

// antigravity (auto-picks GEMINI_API_KEY + E2B_API_KEY)
const defaultAntigravity = new Evolve()
  .withAgent({ type: "antigravity" });

const lowEffortAntigravity = new Evolve()
  .withAgent({ type: "antigravity", model: "gemini-3.5-flash-lite", reasoningEffort: "low" });
```

#### Harness-specific Behavior

| Agent | Tools and configuration |
| --- | --- |
| `pi` | Built-in tools are `read`, `bash`, `edit`, and `write`. MCP tools are available through the `mcp` proxy tool. `grep`, `find`, and `ls` are not enabled by default. |
| `prime-agent` | Actions run through `ipython` in a persistent Python kernel. For stdio MCP servers, use `envVars` to name sandbox variables; literal `env` values are rejected. |
| `dsh` | Supports stdio and streamable HTTP MCP servers. SSE servers are rejected. |

pi, Prime Agent, and dsh read `AGENTS.md`. pi installs skills in `~/.pi/agent/skills`; Prime Agent uses `~/.prime/agent/skills`. See [Agent Skills](./02-configuration.md#agent-skills) for skill installation and [Configuration](./02-configuration.md#evolve-instance) for MCP settings.

pi, Prime Agent, and Z Code can return process exit code `0` despite a failed outcome. Evolve also checks the last model call for pi and Prime Agent, and the final turn status for Z Code.

A failed final outcome produces `run_failed` and agent status `error`. Failure details appear as `error` updates; the response's `exitCode` still records the process exit code. See [Streaming](./04-streaming.md#harness-reported-failures-error).

---

## Where to go next

- [Configuration](./02-configuration.md) shapes the sandbox: which provider, which image, which skills, secrets and integrations.
- [Runtime](./03-runtime.md) covers everything after `run()` — files in and out, sessions, checkpointing, cost.
- [Streaming](./04-streaming.md) is the event surface a UI subscribes to.
- [Swarm & Pipeline](./05-swarm-pipeline.md) runs many agents in parallel and chains the results.
- [Hosted evals](https://docs.evolvingmachines.ai) is the other half of the SDK, and the part that is easiest to miss. Instead of driving one agent yourself, you hand Evolve datasets and a list of agents and read back scored trials — `jobs()` and `datasets()`, or the `evolve` CLI, with no `Evolve` instance involved. Start with `datasets().list()`: what comes back is whatever the platform has published to your account. If that list is empty, you have not hit a wall — [Bring your own dataset](https://docs.evolvingmachines.ai/core-concepts/datasets) publishes a corpus of your own.
