# Evolve Python SDK

Run CLI agents ([Claude Code](https://github.com/anthropics/claude-code), [Codex](https://github.com/openai/codex), [Gemini CLI](https://github.com/google-gemini/gemini-cli), [Qwen Code](https://github.com/QwenLM/qwen-code), [Kimi CLI](https://github.com/MoonshotAI/kimi-cli), [OpenCode](https://github.com/anomalyco/opencode)) in secure sandboxes with built-in observability.

---

## Installation

**Requirements:** [Python 3.10+](https://python.org/) and [Node.js 18+](https://nodejs.org/) (the SDK uses a lightweight Node.js bridge).

```bash
pip install evolve-sdk
```

Optional dependencies (only needed for [S3 checkpointing](./03-runtime.md#storage--checkpointing) in BYOK mode):

```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner
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

```python
from evolve import Evolve, ComposioSetup, ComposioConfig

evolve = Evolve(
    system_prompt='You are Manus Evolve, a powerful AI agent. You can execute code, browse the web, manage files, and solve complex tasks.',
    skills=['pdf', 'docx', 'pptx'],  # browser-use included by default
    composio=ComposioSetup(
        user_id='user_123',
        config=ComposioConfig(toolkits=['gmail', 'notion', 'exa']),
    ),
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
- **Browser Automation:** `browser-use` integration included — agents can browse the web, take screenshots, fill forms, and interact with pages out of the box.
- **Checkpointing:** Snapshot sandbox state to Evolve-managed storage with `storage=StorageConfig()` — no S3 credentials needed. See [Storage & Checkpointing](./03-runtime.md#storage--checkpointing).

---

## Authentication

| | Gateway Mode | BYOK Mode |
|---|---------|---------------|
| Setup | `EVOLVE_API_KEY` | Model provider keys + [`E2B_API_KEY`](https://e2b.dev) |
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

| type | models | default | env var (BYOK) |
|------|--------|---------|----------------|
| `'claude'` | `'opus'` `'sonnet'` `'haiku'` | `'sonnet'` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |
| `'codex'` | `'gpt-5.2'` `'gpt-5.2-codex'` `'gpt-5.1-codex-max'` `'gpt-5.1-mini'` | `'gpt-5.2'` | `OPENAI_API_KEY` or `CODEX_OAUTH_FILE_PATH` |
| `'gemini'` | `'gemini-3.1-pro-preview'` `'gemini-3-pro-preview'` `'gemini-3-flash-preview'` `'gemini-2.5-pro'` `'gemini-2.5-flash'` `'gemini-2.5-flash-lite'` | `'gemini-3-flash-preview'` | `GEMINI_API_KEY` or `GEMINI_OAUTH_FILE_PATH` |
| `'qwen'` | `'qwen3.5-plus'` `'qwen3-coder-plus'` `'qwen3-vl-plus'` | `'qwen3.5-plus'` | `OPENAI_API_KEY` |
| `'kimi'` | `'moonshot/kimi-k2.5'` `'moonshot/kimi-k2-turbo-preview'` | `'moonshot/kimi-k2.5'` | `KIMI_API_KEY` |
| `'opencode'` | `'openrouter/anthropic/claude-sonnet-4.6'` `'openrouter/anthropic/claude-opus-4-6'` `'openrouter/openai/gpt-5.2'` `'openrouter/google/gemini-2.5-pro'` `'openrouter/deepseek/deepseek-r1'` | `'openrouter/anthropic/claude-sonnet-4.6'` | `OPENROUTER_API_KEY` |

> **Note:** In Gateway mode (`EVOLVE_API_KEY`), the default claude model is `'opus'`. In BYOK mode, it defaults to `'sonnet'`.

Agent-specific options: `reasoning_effort` (Codex: `'low'` `'medium'` `'high'` `'xhigh'`), `betas` (Claude Sonnet: `['context-1m-2025-08-07']`)

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

```python
# claude (auto-picks ANTHROPIC_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='claude'),
)

evolve = Evolve(
    config=AgentConfig(type='claude', model='opus'),
)

evolve = Evolve(
    config=AgentConfig(
        type='claude',
        model='sonnet',
        betas=['context-1m-2025-08-07'],
    ),
)
```

```python
# codex (auto-picks OPENAI_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='codex'),
)

evolve = Evolve(
    config=AgentConfig(type='codex', model='gpt-5.2-codex'),
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
    config=AgentConfig(type='gemini', model='gemini-3-pro-preview'),
)
```

```python
# qwen (auto-picks OPENAI_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='qwen'),
)

evolve = Evolve(
    config=AgentConfig(type='qwen', model='qwen3-coder-plus'),
)
```

```python
# kimi (auto-picks KIMI_API_KEY + E2B_API_KEY)
evolve = Evolve(
    config=AgentConfig(type='kimi'),
)

evolve = Evolve(
    config=AgentConfig(type='kimi', model='moonshot/kimi-k2-turbo-preview'),
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
```

---
