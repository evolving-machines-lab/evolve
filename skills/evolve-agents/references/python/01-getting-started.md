# Evolve Python SDK

Run CLI agents ([Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-code), [OpenCode](https://github.com/anomalyco/opencode), [Droid](https://docs.factory.ai/cli/droid-exec/overview), [Pi](https://github.com/earendil-works/pi), [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent), [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [Z Code](https://github.com/zai-org/ZCode), [Antigravity](https://antigravity.google/docs/cli/overview/)) in secure sandboxes with built-in observability.

---

## Installation

**Requirements:** [Python 3.10+](https://python.org/) and [Node.js 18+](https://nodejs.org/) (the SDK uses a lightweight Node.js bridge).

```bash
pip install evolvingmachines-evolve
```

Storage & checkpointing is available in [gateway mode](./03-runtime.md#storage--checkpointing) (`EVOLVE_API_KEY`) — no additional dependencies needed.

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

```python
from evolve import Evolve, IntegrationsSetup

evolve = Evolve(
    system_prompt='You are Manus Evolve, a powerful AI agent. You can execute code, browse the web, manage files, and solve complex tasks.',
    browser={'provider': 'agent-browser', 'remote': True},  # optional: remote managed browser automation in Gateway mode
    skills=['anthropics/skills', './my-skill'],  # skills.sh / git / local references
    integrations=IntegrationsSetup(user_id='root', apps=['gmail', 'notion']),  # optional; managed integrations in Gateway mode
)

result = await evolve.run(
    prompt='Go to Hacker News top posts. Spawn 5 parallel sub-agents to screenshot each of the top 5 posts.'
)

print(result.stdout)

output = await evolve.get_output_files()
for name, content in output.files.items():
    print(name)

# Once done, destroy sandbox
await evolve.kill()
```

### Core Lifecycle

Every Evolve application follows this pattern:

```
Evolve()  →  run()  →  get_output_files()  →  kill()
 setup       execute    retrieve results      ALWAYS cleanup
```

> **Always call `kill()` when done.** The first run creates a sandbox; later runs reuse it. Use `try/finally` to clean up even when a run fails:

```python
evolve = Evolve(config=AgentConfig(type='claude'))
try:
    await evolve.run(prompt='Analyze the dataset')
    output = await evolve.get_output_files()
    print(output.files)            # All files from output/
    print(output.data)             # Parsed result.json (if schema set)
finally:
    await evolve.kill()            # Always destroy sandbox
```

- `run()` can be called multiple times — each continues in the same sandbox session with full context/history.
- `get_output_files()` returns files from the `output/` folder. If `schema=` was set, `output.data` contains the validated result.
- `kill()` destroys the sandbox. The next `run()` creates a fresh one.

### Streaming

Subscribe to real-time agent output:

```python
evolve.on('content', lambda event: print(event['update']))
evolve.on('lifecycle', lambda event: print(event['reason'], event['sandbox'], event['agent']))
```

See [Streaming Events](./04-streaming.md) for all event types, type definitions, and a full UI integration example.

### Gateway Features

When using `EVOLVE_API_KEY`:

- **Tracing:** Automatic tracing and agent analytics at [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) for observability and replay — no extra setup needed. Use `session_tag_prefix` to label sessions for easy filtering.
- **Browser Automation:** Use `browser={'provider': 'agent-browser', 'remote': True}` for the default and recommended managed browser path with dashboard live view and replay.
- **Checkpointing:** Snapshot sandbox state to Evolve-managed storage with `storage=StorageConfig()` — no S3 credentials needed. See [Storage & Checkpointing](./03-runtime.md#storage--checkpointing).
- **Hosted Evals:** Score agents against datasets of tasks on managed infrastructure with `jobs()` and `datasets()`, or the `evolve` CLI. See https://docs.evolvingmachines.ai.

---

## Authentication

| | Gateway Mode | Managed BYO Provider Keys | Direct Provider Key Mode |
|---|---------|---------------------------|--------------------------|
| Setup | `EVOLVE_API_KEY` | `EVOLVE_API_KEY` + provider key saved in Dashboard → Secrets → BYO Provider Keys | [Model provider credentials](#direct-provider-credentials) + [sandbox provider credentials](./02-configuration.md#sandbox-providers) |
| Provider key location | Evolve-managed | Encrypted Dashboard secret | Your local environment or app config |
| Sandbox receives | Evolve gateway runtime config | A short-lived, sandbox-scoped credential — never your raw provider key or `EVOLVE_API_KEY` for that route | Your provider credentials |
| Observability | [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) | [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) | `~/.evolve-sdk/observability/` |
| Browser | `browser={'provider': 'agent-browser', 'remote': True}` is the default and recommended managed browser path with live view and replay. | Same as Gateway Mode | Self-managed browser runtime; no managed live/replay |
| Model billing | Evolving Machines | Your provider account for enabled providers | Your provider accounts |

---

### Gateway Mode (EVOLVE_API_KEY)

Get API key from [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai).

```bash
# .env
EVOLVE_API_KEY=sk-...
```

```python
from evolve import Evolve, AgentConfig

evolve = Evolve(
    config=AgentConfig(type='claude'),
)

await evolve.run(prompt='Hello')
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

```python
import os
from evolve import Evolve, AgentConfig, E2BProvider

sandbox = E2BProvider(
    api_key=os.getenv('E2B_API_KEY'),
)

evolve = Evolve(
    config=AgentConfig(
        type='claude',
        provider_api_key=os.getenv('ANTHROPIC_API_KEY'),
    ),
    sandbox=sandbox,
)
```

---

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

```python
import os
from evolve import Evolve, AgentConfig, E2BProvider

sandbox = E2BProvider(
    api_key=os.getenv('E2B_API_KEY'),
)

evolve = Evolve(
    config=AgentConfig(
        type='claude',
        # SDK reads token from CLAUDE_CODE_OAUTH_TOKEN automatically
    ),
    sandbox=sandbox,
)
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

```python
import os
from evolve import Evolve, AgentConfig, E2BProvider

sandbox = E2BProvider(
    api_key=os.getenv('E2B_API_KEY'),
)

evolve = Evolve(
    config=AgentConfig(
        type='codex',
        # SDK reads auth file from CODEX_OAUTH_FILE_PATH automatically
    ),
    sandbox=sandbox,
)
```

---

### Agent Reference

Choose an agent with `AgentConfig(type=...)` and a model with `model`. The [model and effort reference](https://docs.evolvingmachines.ai/core-concepts/models#model-and-effort-reference) lists exact model names, SDK model defaults, and verified reasoning choices for Evolve model access with `EVOLVE_API_KEY`. Direct Provider Key Mode can have different model and reasoning support.

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

Set `reasoning_effort` for an exact harness and model. Check the [model and effort reference](https://docs.evolvingmachines.ai/core-concepts/models#model-and-effort-reference) for supported values, defaults, and settings that are ignored or not yet verified. For Direct Provider Key Mode, check the provider and harness documentation too.

`no-thinking` is a legacy Agent SDK option. It does not reliably disable thinking across models and is not accepted by managed evaluation jobs.

#### Native Configuration and Presets

For `claude` and `codex`, `config` accepts a local file path or an inline dict. Use it for permissions, sandbox settings, and tool behavior. Codex configuration must be representable as TOML, so it cannot contain `None`.

Model, reasoning, gateway, and MCP settings take precedence over your configuration. Other agents reject `config`.

```python
evolve = Evolve(config=AgentConfig(
    type='claude',
    config={'permissions': {'deny': ['WebSearch', 'WebFetch']}},
))
```

Presets are available on `claude` and `codex`:

| Preset | Effect |
| --- | --- |
| `no-internet` | Disables the harness's server-side web tools. It does not block all sandbox networking. |
| `pinned-context` | Sets a 200,000-token effective context window. |

A preset takes precedence over conflicting `config` settings. Other agents reject `preset`. Use [sandbox network options](./02-configuration.md#sandbox-create-options) to restrict network access from the sandbox.

```python
evolve = Evolve(config=AgentConfig(type='codex', preset='no-internet'))
```

#### Harness and Model Pairing

- **Qwen:** choose a Qwen model from its tab in the model reference. Other model families can reject Qwen Code's thinking parameters.

- **OpenCode:** use the complete model ID from its tab. Additional OpenRouter IDs use `openrouter/<vendor>/<model>`; arbitrary provider prefixes do not select a separate direct provider.

- **Kimi:** the SDK supplies a context ceiling. K3 and K3 Raptor use 1,048,576 tokens; K2.7 uses 262,144. Other models default to 128,000. Kimi Code also sends this value as the request's completion limit, so a provider can reject a ceiling above its own limit.

Set `max_context_size` when you know the model's limit:

```python
evolve = Evolve(config=AgentConfig(
    type='kimi',
    model='kimi-k3',
    max_context_size=1048576,
))
```

`max_context_size` is an SDK option, not an environment variable. Harnesses that do not send a ceiling ignore it.

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

```python
# claude (auto-picks ANTHROPIC_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='claude'),
)

evolve = Evolve(
    config=AgentConfig(type='claude', model='opus'),
)

evolve = Evolve(
    config=AgentConfig(type='claude', model='fable'),
)
```

```python
# codex (auto-picks OPENAI_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='codex'),
)

evolve = Evolve(
    config=AgentConfig(type='codex', model='gpt-5.3-codex'),
)

evolve = Evolve(
    config=AgentConfig(type='codex', model='gpt-6-sol', reasoning_effort='high'),
)
```

```python
# qwen (auto-picks OPENAI_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='qwen'),
)

evolve = Evolve(
    config=AgentConfig(type='qwen', model='qwen3.8-max'),
)
```

```python
# kimi (auto-picks KIMI_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='kimi'),
)

evolve = Evolve(
    config=AgentConfig(type='kimi', model='kimi-k3'),
)

# Gateway mode: set EVOLVE_API_KEY for Kimi K3 Raptor.
evolve = Evolve(
    config=AgentConfig(
        type='kimi',
        model='kimi-k3-raptor',
    ),
)
```

```python
# opencode — OpenRouter (auto-picks OPENROUTER_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='opencode'),
)

evolve = Evolve(
    config=AgentConfig(type='opencode', model='openrouter/openai/gpt-6-sol'),
)

evolve = Evolve(
    config=AgentConfig(type='opencode', model='openrouter/anthropic/claude-fable-5.1'),
)
```

```python
# droid (auto-picks FACTORY_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='droid'),
)

evolve = Evolve(
    config=AgentConfig(type='droid', model='claude-opus-5-5'),
)
```

```python
# Pi (auto-picks OPENROUTER_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='pi'),
)

evolve = Evolve(
    config=AgentConfig(type='pi', model='openrouter/openai/gpt-6-sol'),
)

# prime-agent (the same key and the same model ids)
evolve = Evolve(
    config=AgentConfig(type='prime-agent', model='openrouter/anthropic/claude-sonnet-5'),
)

# dsh — DeepSeek Harness (auto-picks OPENROUTER_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='dsh'),
)

evolve = Evolve(
    config=AgentConfig(type='dsh', model='openrouter/deepseek/deepseek-v4-pro-0813'),
)

# zcode (auto-picks OPENROUTER_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='zcode'),
)

evolve = Evolve(
    config=AgentConfig(type='zcode', model='openrouter/z-ai/glm-5.3-flash'),
)

# antigravity (auto-picks GEMINI_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='antigravity'),
)

evolve = Evolve(
    config=AgentConfig(type='antigravity', model='gemini-3.5-flash-lite'),
)
```

#### Harness-specific Behavior

| Agent | Tools and configuration |
| --- | --- |
| `pi` | Built-in tools are `read`, `bash`, `edit`, and `write`. MCP tools are available through the `mcp` proxy tool. `grep`, `find`, and `ls` are not enabled by default. |
| `prime-agent` | Actions run through `ipython` in a persistent Python kernel. For stdio MCP servers, use `envVars` to name sandbox variables; literal `env` values are rejected. |
| `dsh` | Supports stdio and streamable HTTP MCP servers. SSE servers are rejected. |

Pi, Prime Agent, and dsh read `AGENTS.md`. Pi installs skills in `~/.pi/agent/skills`; Prime Agent uses `~/.prime/agent/skills`. See [Agent Skills](./02-configuration.md#agent-skills) for skill installation and [Configuration](./02-configuration.md#evolve-instance) for MCP settings.

Pi, Prime Agent, and Z Code can return process exit code `0` despite a failed outcome. Evolve also checks the last model call for Pi and Prime Agent, and the final turn status for Z Code.

A failed final outcome produces `run_failed` and agent status `error`. Failure details appear as `error` updates; the response's `exit_code` still records the process exit code. See [Streaming](./04-streaming.md#harness-reported-failures-error).

---

## Where to go next

- [Configuration](./02-configuration.md) shapes the sandbox: which provider, which image, which skills, secrets and integrations.
- [Runtime](./03-runtime.md) covers everything after `run()` — files in and out, sessions, checkpointing, cost.
- [Streaming](./04-streaming.md) is the event surface a UI subscribes to.
- [Swarm & Pipeline](./05-swarm-pipeline.md) runs many agents in parallel and chains the results.
- [Hosted evals](https://docs.evolvingmachines.ai) is the other half of the SDK, and the part that is easiest to miss. Instead of driving one agent yourself, you hand Evolve datasets and a list of agents and read back scored trials — `jobs()` and `datasets()`, or the `evolve` CLI, with no `Evolve` instance involved. Start with `datasets().list()`: what comes back is whatever the platform has published to your account. If that list is empty, you have not hit a wall — [Bring your own dataset](https://docs.evolvingmachines.ai/core-concepts/datasets) publishes a corpus of your own.
