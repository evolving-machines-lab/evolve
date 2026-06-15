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
    skills=['pdf', 'docx', 'pptx'],
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

---

## Authentication

| | Gateway Mode | BYOK Mode |
|---|---------|---------------|
| Setup | `EVOLVE_API_KEY` | Model provider keys + [`E2B_API_KEY`](https://e2b.dev) |
| Observability | [dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai) | `~/.evolve-sdk/observability/` |
| Browser | `browser={'provider': 'agent-browser', 'remote': True}` is the default and recommended managed browser path with live view and replay. | Self-managed browser runtime; no managed live/replay |
| Billing | Evolving Machines | Your provider accounts |

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

### BYOK Mode

Use your own provider keys. Requires [`E2B_API_KEY`](https://e2b.dev) for sandbox.

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

| type | models | default | Gateway | BYOK |
|------|--------|---------|---------|------|
| `'claude'` | `'fable'` `'opus'` `'sonnet'` `'haiku'` `'opus[1m]'` `'sonnet[1m]'` | `'opus'` | `EVOLVE_API_KEY` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |
| `'codex'` | `'gpt-5.5'` `'gpt-5.4'` `'gpt-5.4-mini'` `'gpt-5.3-codex'` `'gpt-5.2'` | `'gpt-5.4'` | `EVOLVE_API_KEY` | `OPENAI_API_KEY` or `CODEX_OAUTH_FILE_PATH` |
| `'gemini'` | `'gemini-3.1-pro-preview'` `'gemini-3.1-flash-lite-preview'` `'gemini-3.5-flash'` `'gemini-3-flash-preview'` `'gemini-2.5-pro'` `'gemini-2.5-flash'` `'gemini-2.5-flash-lite'` | `'gemini-3.1-pro-preview'` | `EVOLVE_API_KEY` | `GEMINI_API_KEY` or `GEMINI_OAUTH_FILE_PATH` |
| `'qwen'` | `'qwen3.7-max'` `'qwen3.7-plus'` `'qwen3.6-flash'` `'qwen3.6-plus'` | `'qwen3.7-max'` | `EVOLVE_API_KEY` | `OPENAI_API_KEY` |
| `'kimi'` | `'kimi-k2.6'` `'kimi-k2.6-turbo'` `'kimi-k2.5'` | `'kimi-k2.6'` | `EVOLVE_API_KEY` | `KIMI_API_KEY` |
| `'opencode'` | `'openrouter/anthropic/claude-fable-5'` `'openrouter/anthropic/claude-opus-4.8'` `'openrouter/anthropic/claude-sonnet-4.6'` `'openrouter/anthropic/claude-haiku-4.5'` `'openrouter/openai/gpt-5.5'` `'openrouter/openai/gpt-5.4'` `'openrouter/openai/gpt-5.4-mini'` `'openrouter/openai/gpt-5.3-codex'` `'openrouter/openai/gpt-5.2'` `'openrouter/google/gemini-3.1-pro-preview'` `'openrouter/google/gemini-3.5-flash'` `'openrouter/google/gemini-3-flash-preview'` `'openrouter/qwen/qwen3-coder-next'` `'openrouter/qwen/qwen3-coder-plus'` `'openrouter/moonshotai/kimi-k2.6'` `'openrouter/moonshotai/kimi-k2.5'` `'openrouter/z-ai/glm-5'` | `'openrouter/anthropic/claude-sonnet-4.6'` | `EVOLVE_API_KEY` | `OPENROUTER_API_KEY` |
| `'droid'` | `'claude-opus-4-8'` `'claude-opus-4-8-fast'` `'claude-sonnet-4-6'` `'claude-opus-4-6'` `'claude-opus-4-6-fast'` `'claude-opus-4-5'` `'claude-sonnet-4-5'` `'claude-haiku-4-5'` `'gpt-5.5'` `'gpt-5.5-fast'` `'gpt-5.5-pro'` `'gpt-5.4'` `'gpt-5.4-fast'` `'gpt-5.4-mini'` `'gpt-5.3-codex'` `'gpt-5.3-codex-fast'` `'gpt-5.2'` `'gpt-5.2-codex'` `'gemini-3.1-pro-preview'` `'gemini-3-pro-preview'` `'gemini-3-flash-preview'` `'kimi-k2.6'` `'kimi-k2.5'` `'deepseek-v4-pro'` `'minimax-m2.7'` `'minimax-m2.5'` `'glm-5.1'` | `'gpt-5.5'` | `EVOLVE_API_KEY` | `FACTORY_API_KEY` |

Agent-specific option: `reasoning_effort` controls how much reasoning/thinking the selected agent uses when that agent supports it.

| Agent | Default when omitted | Supported `reasoning_effort` |
|-------|----------------------|------------------------------|
| `'claude'` | Claude/model default | `'low'` `'medium'` `'high'` `'xhigh'` `'max'` |
| `'codex'` | OpenAI model default | `'low'` `'medium'` `'high'` `'xhigh'` |
| `'gemini'` | Gemini CLI/model default | Not supported |
| `'qwen'` | `'thinking'` | `'thinking'` `'no-thinking'` |
| `'kimi'` | `'thinking'` | `'thinking'` `'no-thinking'` |
| `'opencode'` | `'thinking'` + `'medium'` | `'thinking'` `'no-thinking'` `'minimal'` `'low'` `'medium'` `'high'` `'xhigh'` `'max'` |
| `'droid'` | Droid/model default | `'off'` `'minimal'` `'low'` `'medium'` `'high'` `'xhigh'` `'max'`; exact values depend on the Droid model |

Kimi Code has provider-dependent internal effort settings, but the Moonshot/Kimi API documents thinking on/off and preserved-thinking controls, not public effort levels.

For Claude Fable 5, use `model='fable'`. For OpenCode via OpenRouter, use `model='openrouter/anthropic/claude-fable-5'`. For Claude 1M context window, use `model='sonnet[1m]'` or `model='opus[1m]'`.

#### Evolve-Provided Gateway Models

These models require Gateway mode (`EVOLVE_API_KEY`) and are routed by Evolve for latency-sensitive runs. BYOK provider keys do not apply.

| Agent | Model | Use |
|-------|-------|-----|
| `'kimi'` | `'kimi-k2.6-turbo'` | Kimi K2.6 turbo for interactive coding and agent runs |

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
    config=AgentConfig(type='kimi', model='kimi-k2.6'),
)

evolve = Evolve(
    config=AgentConfig(
        type='kimi',
        model='kimi-k2.6-turbo',
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
    config=AgentConfig(type='opencode', model='openrouter/openai/gpt-5.2'),
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
