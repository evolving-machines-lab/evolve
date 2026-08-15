# Evolve Python SDK

Run CLI agents ([Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi Code](https://github.com/MoonshotAI/kimi-code), [OpenCode](https://github.com/anomalyco/opencode), [Droid](https://docs.factory.ai/cli/droid-exec/overview)) in secure sandboxes with built-in observability.

---

## Installation

**Requirements:** [Python 3.10+](https://python.org/) and [Node.js 18+](https://nodejs.org/) (the SDK uses a lightweight Node.js bridge).

```bash
pip install evolve-sdk
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

> **IMPORTANT: Always call `kill()` when done.** Each `run()` creates a cloud sandbox that bills until destroyed. Forgetting `kill()` leaves sandboxes running indefinitely. Use try/finally to guarantee cleanup:

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
- **Hosted Evals:** Score agents against datasets of tasks on managed infrastructure with `jobs()` and `datasets()`, or the `evolve` CLI. See [Hosted Evals](./06-hosted-evals.md).

---

## Authentication

| | Gateway Mode | Managed BYO Provider Keys | Direct Provider Key Mode |
|---|---------|---------------------------|--------------------------|
| Setup | `EVOLVE_API_KEY` | `EVOLVE_API_KEY` + provider key saved in Dashboard → Secrets → BYO Provider Keys | Model provider keys + [`E2B_API_KEY`](https://e2b.dev) |
| Provider key location | Evolve-managed | Encrypted Dashboard secret | Your local environment or app config |
| Sandbox receives | Evolve gateway runtime config | A short-lived, sandbox-scoped credential — never your raw provider key or `EVOLVE_API_KEY` for that route | Raw provider key environment variable |
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

**You can save a key for Anthropic and OpenAI.** Those are the two providers this route serves today, so a Claude run or a Codex run can bill your own account. The gateway itself reaches seven providers — Anthropic, OpenAI, Gemini, DashScope, Kimi, OpenRouter, and Droid/Factory — but the other five have no bring-your-own path, and a run that routes through one of them is billed to Evolve whether or not you have a key saved. That is not a silent fallback so much as arithmetic: an Anthropic key cannot pay for a Moonshot call.

When enabled, Evolve routes supported provider calls through a short-lived, sandbox-scoped credential. The SDK does not receive the raw provider key, and the sandbox does not receive `EVOLVE_API_KEY` for that provider route. If no managed key is enabled for that provider, gateway mode falls back to Evolve-managed model routing.

---

### Direct Provider Key Mode (Local BYOK)

Use this when you want to pass provider keys from your own local environment or app config. Requires [`E2B_API_KEY`](https://e2b.dev) for sandbox.

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

```python
import os
from evolve import Evolve, AgentConfig, E2BProvider

sandbox = E2BProvider(
    api_key=os.getenv('E2B_API_KEY'),
)

evolve = Evolve(
    config=AgentConfig(
        type='gemini',
        # SDK reads credentials file from GEMINI_OAUTH_FILE_PATH automatically
    ),
    sandbox=sandbox,
)
```

---

### Auto-resolve from Environment

Set env vars and the SDK picks them up automatically — no need to pass explicitly.

### Agent Reference

> **IMPORTANT: Only use the exact model names listed below.** The SDK will error on unrecognized model names. Do not invent or guess model identifiers.

The Direct key column applies to Direct Provider Key Mode. Managed BYO Provider Keys use Gateway Mode plus Dashboard-stored provider keys.

| type | models | default | Gateway | Direct key |
|------|--------|---------|---------|------|
| `'claude'` | `'fable'` `'opus'` `'sonnet'` `'haiku'` `'opus[1m]'` `'sonnet[1m]'` | `'opus'` | `EVOLVE_API_KEY` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |
| `'codex'` | `'gpt-5.6-sol'` `'gpt-5.6-terra'` `'gpt-5.6-luna'` `'gpt-5.5'` `'gpt-5.3-codex'` | `'gpt-5.6-sol'` | `EVOLVE_API_KEY` | `OPENAI_API_KEY` or `CODEX_OAUTH_FILE_PATH` |
| `'gemini'` | `'gemini-3.7-flash'` `'gemini-3.5-flash-lite'` `'gemini-3.1-pro-preview'` | `'gemini-3.7-flash'` | `EVOLVE_API_KEY` | `GEMINI_API_KEY` or `GEMINI_OAUTH_FILE_PATH` |
| `'qwen'` | `'qwen3.7-max'` `'qwen3.7-plus'` `'qwen3.6-flash'` | `'qwen3.7-max'` | `EVOLVE_API_KEY` | `OPENAI_API_KEY` |
| `'kimi'` | `'kimi-k3'` `'kimi-k2.7-code'` `'kimi-k3-raptor'` `'kimi-k2p7-code-raptor'` | `'kimi-k3'` | `EVOLVE_API_KEY` | `KIMI_API_KEY` |
| `'opencode'` | `'openrouter/anthropic/claude-fable-5'` `'openrouter/anthropic/claude-opus-5'` `'openrouter/anthropic/claude-sonnet-5'` `'openrouter/anthropic/claude-haiku-4.5'` `'openrouter/openai/gpt-5.6-sol'` `'openrouter/openai/gpt-5.6-terra'` `'openrouter/openai/gpt-5.6-luna'` `'openrouter/google/gemini-3.6-flash'` `'openrouter/qwen/qwen3.7-max'` `'openrouter/moonshotai/kimi-k3'` `'openrouter/z-ai/glm-5.2'` | `'openrouter/anthropic/claude-opus-5'` | `EVOLVE_API_KEY` | `OPENROUTER_API_KEY` |
| `'droid'` | `'claude-fable-5'` `'claude-opus-5'` `'claude-sonnet-5'` `'claude-haiku-4-5'` `'gpt-5.6-sol'` `'gpt-5.6-terra'` `'gpt-5.6-luna'` `'gemini-3.6-flash'` `'qwen3.7-max'` `'kimi-k3'` `'glm-5.2'` | `'claude-opus-5'` | `EVOLVE_API_KEY` | `FACTORY_API_KEY` |

Model names route by themselves: pass just the name from the table and Evolve serves it on its default provider, or pass a provider-prefixed name (`openai/gpt-5.5`, `openrouter/moonshotai/kimi-k3`) to pick the provider explicitly. The table's names are the supported, priced set — prefixed routing beyond it works for advanced use but is outside the supported lineup.

Agent-specific option: `reasoning_effort` controls how much reasoning/thinking the selected agent uses when that agent supports it.

| Agent | Default when omitted (pinned by Evolve) | Supported `reasoning_effort` |
|-------|------------------------------------------|------------------------------|
| `'claude'` | `'high'` — Claude Code's documented default | `'low'` `'medium'` `'high'` `'xhigh'` `'max'` |
| `'codex'` | `'high'` — pinned by Evolve (owner policy: graded harnesses run high) | `'none'` `'low'` `'medium'` `'high'` `'xhigh'` `'max'` (`'none'` and `'max'` are GPT-5.6 values) |
| `'gemini'` | No effort control | Not supported |
| `'qwen'` | `'thinking'` | `'thinking'` `'no-thinking'` |
| `'kimi'` | `'thinking'` at `'max'` effort — the Kimi K3 API default | `'thinking'` `'no-thinking'` `'low'` `'medium'` `'high'` `'xhigh'` `'max'` |
| `'opencode'` | `'thinking'` + `'high'` | `'thinking'` `'no-thinking'` `'minimal'` `'low'` `'medium'` `'high'` `'xhigh'` `'max'` |
| `'droid'` | `'high'` — matches Droid’s own default for Opus 5, pinned by Evolve | `'off'` `'minimal'` `'low'` `'medium'` `'high'` `'xhigh'` `'max'`; exact values depend on the Droid model |

When you omit `reasoning_effort`, Evolve does not leave the choice to the CLI. For every harness with an effort control, the SDK stamps the pinned default from the table explicitly on the run — as a flag, an environment variable, or a config-file entry, whatever that CLI reads. This keeps runs reproducible: the effort a run used is always recorded in the run itself, never implied by a vendor default that could change under you. Where the vendor documents a default, the pin matches it; `gemini` has no effort control, so nothing is stamped there.

Note that thinking cannot be disabled on Kimi K3 at the API level — `'no-thinking'` applies to the K2-generation models.

Agent-specific option: `config` supplies the harness's own native settings — a local file path or an inline dict. Claude receives it as a settings JSON passed through `--settings`; Codex receives it as the base `~/.codex/config.toml` (an inline dict must be losslessly representable as TOML — no `None` values). Your document is the base layer: Evolve's own inputs — gateway routing, MCP servers, the model and effort stamps — always land on top of it, so a config can tune permissions, sandbox settings, or tool behavior but never re-route where the model traffic goes. Only `claude` and `codex` support a native config; naming one on any other agent type raises rather than being silently ignored.

```python
evolve = Evolve().with_agent(AgentConfig(
    type='claude',
    config={'permissions': {'deny': ['WebSearch', 'WebFetch']}},
))
```

Instead of hand-writing such a config, `preset` names a bundle Evolve ships and guarantees. `preset='no-internet'` turns off the vendor's server-side web tools — Claude gets that exact `permissions.deny` stamp, Codex gets `-c web_search=disabled` on its command line (Codex's default is `'cached'`, an OpenAI-maintained web index, so only the explicit flag removes the tool). `preset='pinned-context'` pins one fixed effective context window (200000 tokens) — Claude via `autoCompactWindow`, Codex via `-c model_context_window` — so vendor-side window tuning never changes what a run had to work with. A preset is stamped **on top** of any `config` you also pass, and a preset stamp always wins where the two disagree: your document cannot undo the guarantee. Only `claude` and `codex` can guarantee the presets today; naming one on any other agent type raises rather than running without its guarantee.

```python
evolve = Evolve().with_agent(AgentConfig(type='codex', preset='no-internet'))
```

For Claude Fable 5, use `model='fable'`. For OpenCode via OpenRouter, use `model='openrouter/anthropic/claude-fable-5'`. For Claude 1M context window, use `model='sonnet[1m]'` or `model='opus[1m]'`.

#### Harness and Model Pairing

A harness and its model are chosen together, and a few harnesses only accept models from their own family:

- **`qwen`** must run a Qwen-native model (the `qwen3.x` aliases, routed via DashScope). Qwen Code injects the DashScope-only `enable_thinking` request parameter on every call, which OpenAI-family models reject with a `400` — so pointing the `qwen` harness at a non-Qwen model fails.
- **`opencode`** routes every model through OpenRouter, so its models are the `openrouter/…` ids in the table above (a bare id is prefixed with `openrouter/` for you).
- **`kimi`** must be told a context ceiling, which Kimi Code sends as the request's `max_tokens`. Its own models get Kimi's 262144; any other model (say `gpt-5.5` behind an OpenAI-compatible gateway) gets a conservative 128000 instead, because an oversized `max_tokens` is rejected outright — LiteLLM answers `400 max_tokens is too large`. Pass the model's real ceiling to skip the guess:

```python
AgentConfig(
    type='kimi',
    model='gpt-5.5',
    max_context_size=128000,   # (optional) the model's real completion ceiling, used verbatim
)
```

`max_context_size` is an SDK option, never an environment variable. Harnesses that do not send a ceiling ignore it.

Two harness quirks the SDK handles automatically, with nothing for you to set: the `claude` harness runs with `IS_SANDBOX=1` so Claude Code's `--dangerously-skip-permissions` is allowed under root, and the `gemini` harness boots with workspace trust set so Gemini CLI runs headless instead of refusing an untrusted workspace.

#### Evolve-Provided Gateway Models

These models require Gateway mode (`EVOLVE_API_KEY`) and are routed by Evolve for latency-sensitive runs. Direct provider keys do not apply.

| Agent | Model | Use |
|-------|-------|-----|
| `'kimi'` | `'kimi-k3-raptor'` | Kimi K3 fast route for latency-sensitive agent runs |
| `'kimi'` | `'kimi-k2p7-code-raptor'` | Kimi K2.7 Code Raptor route for interactive coding and agent runs |

### Agent Examples

```bash
# .env - set env vars for auto-pickup
ANTHROPIC_API_KEY=sk-...   # claude
OPENAI_API_KEY=sk-...      # codex, qwen
GEMINI_API_KEY=...         # gemini
KIMI_API_KEY=...           # kimi
OPENROUTER_API_KEY=sk-...  # opencode
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

evolve = Evolve(
    config=AgentConfig(type='claude', reasoning_effort='max'),
)

evolve = Evolve(
    config=AgentConfig(
        type='claude',
        model='sonnet[1m]',  # 1M context window
    ),
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
    config=AgentConfig(type='codex', reasoning_effort='high'),
)
```

```python
# gemini (auto-picks GEMINI_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='gemini'),
)

evolve = Evolve(
    config=AgentConfig(type='gemini', model='gemini-3.1-pro-preview'),
)
```

```python
# qwen (auto-picks OPENAI_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='qwen'),
)

evolve = Evolve(
    config=AgentConfig(type='qwen', model='qwen3.7-max'),
)

evolve = Evolve(
    config=AgentConfig(type='qwen', reasoning_effort='no-thinking'),
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

evolve = Evolve(
    config=AgentConfig(
        type='kimi',
        model='kimi-k2p7-code-raptor',
        reasoning_effort='thinking',
    ),
)
```

```python
# opencode — OpenRouter (auto-picks OPENROUTER_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='opencode'),
)

evolve = Evolve(
    config=AgentConfig(type='opencode', model='openrouter/openai/gpt-5.6-sol'),
)

evolve = Evolve(
    config=AgentConfig(type='opencode', model='openrouter/anthropic/claude-fable-5'),
)

evolve = Evolve(
    config=AgentConfig(type='opencode', reasoning_effort='xhigh'),
)
```

```python
# droid (auto-picks FACTORY_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='droid'),
)

evolve = Evolve(
    config=AgentConfig(type='droid', model='gpt-5.5'),
)
```

---

## Where to go next

- [Configuration](./02-configuration.md) shapes the sandbox: which provider, which image, which skills, secrets and integrations.
- [Runtime](./03-runtime.md) covers everything after `run()` — files in and out, sessions, checkpointing, cost.
- [Streaming](./04-streaming.md) is the event surface a UI subscribes to.
- [Swarm & Pipeline](./05-swarm-pipeline.md) runs many agents in parallel and chains the results.
- [Hosted Evals](./06-hosted-evals.md) is the other half of the SDK, and the part that is easiest to miss. Instead of driving one agent yourself, you hand Evolve datasets and a list of agents and read back scored trials — `jobs()` and `datasets()`, or the `evolve` CLI, with no `Evolve` instance involved. Start with `datasets().list()`: what comes back is whatever the platform has published to your account. If that list is empty, you have not hit a wall — the same chapter's [Bring your own dataset](./06-hosted-evals.md#bring-your-own-dataset) section publishes a corpus of your own.
