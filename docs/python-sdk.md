# Evolve Python SDK

Run terminal-based AI agents in secure sandboxes with built-in observability.

> See the [main README](../README.md) for installation and API keys.
>
> **Note:** Requires [Node.js 18+](https://nodejs.org/) (the SDK uses a lightweight Node.js bridge).

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

```python
import os
from evolve import Evolve, AgentConfig, ComposioSetup, ComposioConfig

evolve = Evolve(
    config=AgentConfig(
        api_key=os.getenv('EVOLVE_API_KEY'),
    ),
    session_tag_prefix='my-app',
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

## Gateway Features

When using `EVOLVE_API_KEY`:

- **Tracing:** Automatic tracing and agent analytics at [dashboard.evolvingmachines.ai/traces](https://dashboard.evolvingmachines.ai/traces) for observability and replay—no extra setup needed. Use `session_tag_prefix` to label sessions for easy filtering.
- **Browser Automation:** `browser-use` integration included—agents can browse the web, take screenshots, fill forms, and interact with pages out of the box.
- **Checkpointing:** Snapshot sandbox state to Evolve-managed storage with `storage=StorageConfig()`—no S3 credentials needed. See [Storage & Checkpointing](#51-storage--checkpointing).

---

## 1.1 Authentication

| | Gateway Mode | BYOK Mode |
|---|---------|---------------|
| Setup | `EVOLVE_API_KEY` | Model provider keys + [`E2B_API_KEY`](https://e2b.dev) |
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

```python
import os
from evolve import Evolve, AgentConfig

evolve = Evolve(
    config=AgentConfig(
        type='claude',
        api_key=os.getenv('EVOLVE_API_KEY'),
    ),
)

await evolve.run(prompt='Hello')
```

---

### 1.1.2 BYOK Mode

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

Set env vars and the SDK picks them up automatically—no need to pass explicitly. See [Agent Reference](#113-agent-reference) below for env var names.

### 1.1.3 Agent Reference

| type | models | default | env var (BYOK) |
|------|--------|---------|----------------|
| `'claude'` | `'opus'` `'sonnet'` `'haiku'` | `'opus'` | `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` |
| `'codex'` | `'gpt-5.2'` `'gpt-5.2-codex'` `'gpt-5.1-codex-max'` `'gpt-5.1-mini'` | `'gpt-5.2'` | `OPENAI_API_KEY` or `CODEX_OAUTH_FILE_PATH` |
| `'gemini'` | `'gemini-3-pro-preview'` `'gemini-3-flash-preview'` `'gemini-2.5-pro'` `'gemini-2.5-flash'` `'gemini-2.5-flash-lite'` | `'gemini-3-flash-preview'` | `GEMINI_API_KEY` or `GEMINI_OAUTH_FILE_PATH` |
| `'qwen'` | `'qwen3-coder-plus'` `'qwen3-vl-plus'` | `'qwen3-coder-plus'` | `OPENAI_API_KEY` |

Agent-specific options: `reasoning_effort` (Codex: `'low'` `'medium'` `'high'` `'xhigh'`), `betas` (Claude Sonnet: `['context-1m-2025-08-07']`)

### Agent Examples

```bash
# .env - set env vars for auto-pickup
ANTHROPIC_API_KEY=sk-...   # claude
OPENAI_API_KEY=sk-...      # codex, qwen
GEMINI_API_KEY=...         # gemini
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

---

## 2. Full Configuration

### 2.1 Sandbox Providers

Works with both Gateway mode (`EVOLVE_API_KEY`) and BYOK mode (provider API keys). With `EVOLVE_API_KEY` only, sandbox defaults to **E2B**. Add a sandbox provider key to auto-resolve to that provider.

All providers use the `evolve-all` image with pre-installed CLIs.

| Provider | Env Vars | Auto-Resolves When | First Time Setup |
|----------|----------|-------------------|------------------|
| E2B | `E2B_API_KEY` | Default, or `E2B_API_KEY` set | None — instant |
| Modal | `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` | Both Modal vars set | Run `cd assets && ./build.sh modal` once |
| Daytona | `DAYTONA_API_KEY` | `DAYTONA_API_KEY` set | Run `cd assets && ./build.sh daytona` once |

See [assets/README.md](../assets/README.md) for detailed setup instructions.

---

### Auto-Resolution

Set env vars and the SDK auto-resolves the provider—no `sandbox=` needed:

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

```python
from evolve import Evolve, AgentConfig

# No sandbox= needed — SDK picks the right provider from env
evolve = Evolve(
    agent=AgentConfig(type="claude"),
)

await evolve.run(prompt="Hello")
```

Only use explicit provider creation (below) if you need custom settings like timeout or app name.

---

### E2B (default)
```bash
# .env - Gateway mode
EVOLVE_API_KEY=sk-...
E2B_API_KEY=e2b_...              # Optional with EVOLVE_API_KEY (auto-resolves)

# .env - BYOK mode
ANTHROPIC_API_KEY=sk-ant-...     # Or OPENAI_API_KEY, GEMINI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN
E2B_API_KEY=e2b_...              # Required in BYOK mode
```

```python
from evolve import E2BProvider

sandbox = E2BProvider(
    api_key=os.getenv('E2B_API_KEY'),    # (optional) Auto-resolves from env
    timeout_ms=3600000,                   # (optional) Default: 3600000 (1 hour)
    template_id='my-custom-template',     # (optional) E2B template ID. Default: 'evolve-all'
)
```

### Modal
```bash
# .env - Gateway mode
EVOLVE_API_KEY=sk-...
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...

# .env - BYOK mode
ANTHROPIC_API_KEY=sk-ant-...     # Or OPENAI_API_KEY, GEMINI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN
MODAL_TOKEN_ID=ak-...
MODAL_TOKEN_SECRET=as-...
```

```python
from evolve import ModalProvider

sandbox = ModalProvider(
    token_id=os.getenv('MODAL_TOKEN_ID'),       # (optional) Auto-resolves from env
    token_secret=os.getenv('MODAL_TOKEN_SECRET'), # (optional) Auto-resolves from env
    app_name='my-app',                    # (optional) Default: 'evolve-sandbox'
    timeout_ms=3600000,                   # (optional) Default: 3600000 (1 hour)
    endpoint='https://api.modal.com:443', # (optional) Default: https://api.modal.com:443
)
```

### Daytona
```bash
# .env - Gateway mode
EVOLVE_API_KEY=sk-...
DAYTONA_API_KEY=...

# .env - BYOK mode
ANTHROPIC_API_KEY=sk-ant-...     # Or OPENAI_API_KEY, GEMINI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN
DAYTONA_API_KEY=...
```

```python
from evolve import DaytonaProvider

sandbox = DaytonaProvider(
    api_key=os.getenv('DAYTONA_API_KEY'),  # (optional) Auto-resolves from env
    api_url='https://app.daytona.io/api',  # (optional) Default: https://app.daytona.io/api
    target='us',                            # (optional) Target region. Default: 'us'
    timeout_ms=3600000,                     # (optional) Default: 3600000 (1 hour) - converted to minutes for auto-stop
)
```

---

### 2.2 Evolve Instance

```python
import os
from evolve import Evolve, AgentConfig, E2BProvider, StorageConfig, ComposioSetup, ComposioConfig

# Sandbox provider (auto-resolved from E2B_API_KEY, or explicit)
sandbox = E2BProvider(
    api_key=os.getenv('E2B_API_KEY'),   # (optional) Auto-resolves from E2B_API_KEY env var
    timeout_ms=3600000,                  # (optional) Default sandbox timeout (default: 1 hour)
)
```

```python
evolve = Evolve(

    # Agent configuration (optional if EVOLVE_API_KEY set, defaults to claude)
    config=AgentConfig(
        type='codex',                        # 'claude' | 'codex' | 'gemini' | 'qwen' - defaults to 'claude'
        model='gpt-5.2-codex',               # (optional) Uses default if omitted
        reasoning_effort='medium',           # (optional) 'low' | 'medium' | 'high' | 'xhigh' - Codex only
        # betas=['context-1m-2025-08-07'],   # (optional) Claude Sonnet only
        api_key=os.getenv('EVOLVE_API_KEY'), # (optional) Gateway mode - auto-resolves from env
        # provider_api_key=os.getenv('ANTHROPIC_API_KEY'), # (optional) Direct mode (BYOK)
        # oauth_token=os.getenv('CLAUDE_CODE_OAUTH_TOKEN'), # (optional) Claude Max subscription
    ),

    # Sandbox provider (auto-resolved from E2B_API_KEY, or use sandbox from above)
    sandbox=sandbox,

    # (optional) Uploads to /home/user/workspace/context/ on first run
    context={
        'docs/readme.txt': 'User provided context...',
        'data.json': '{"key": "value"}',
    },

    # (optional) System prompt appended to default instructions
    system_prompt='You are a careful pair programmer.',

    # (optional) Schema for structured output (agent writes result.json, validated on get_output_files())
    # Accepts Pydantic models or JSON Schema dicts
    schema=MyPydanticModel,

    # (optional) Skills for the agent (browser-use included by default)
    skills=['pdf', 'docx', 'pptx'],

    # (optional) Composio Tool Router for 1000+ integrations
    composio=ComposioSetup(
        user_id='user_123',
        config=ComposioConfig(toolkits=['gmail', 'notion', 'stripe']),
    ),

    # (optional) Prefix for observability logs
    session_tag_prefix='my-agent',

    # (optional) Storage for checkpoint persistence — snapshot sandbox to S3
    storage=StorageConfig(url='s3://my-bucket/agent-snapshots/'),  # BYOK — your own S3 bucket
    # storage=StorageConfig(),                                      # Gateway — Evolve-managed (requires EVOLVE_API_KEY)

    # ─────────────────────────────────────────────────────────────
    # Advanced
    # ─────────────────────────────────────────────────────────────

    # (optional) MCP servers for agent tools
    mcp_servers={
        'exa': {
            'command': 'npx',
            'args': ['-y', 'exa-mcp-server'],
            'env': {'EXA_API_KEY': '...'},
        },
        'api': {
            'type': 'http',
            'url': 'https://example.com/mcp',
            'headers': {'x-api-key': '...'},
        },
    },

    # (optional) Environment variables injected into sandbox
    secrets={'GITHUB_TOKEN': os.getenv('GITHUB_TOKEN')},

    # (optional) Uploads to /home/user/workspace/ on first run
    files={
        'scripts/setup.sh': '#!/bin/bash\necho hello',
    },
)
```

**Note:**
- Configuration parameters can be combined in any order.
- The sandbox is created on the first `run()` or `execute_command()` call (see below).
- Context files, workspace files, MCP servers, and system prompt are set up once on the first call.
- Using `sandbox_id` parameter to reconnect skips setup since the sandbox already exists.
- `schema` accepts both Pydantic model classes and JSON Schema dicts.

**McpServerConfig** — MCP server connection (STDIO or HTTP/SSE):

| Fields | Transport |
|--------|-----------|
| `command` | stdio (local subprocess) |
| `url` + `type: "http"` | HTTP (remote) |
| `url` (no type) | SSE (remote, default) |

```python
McpServerConfig = {
    'type': str,                          # "stdio" | "http" | "sse" (auto-detected)
    'command': str, 'args': list, 'cwd': str,        # STDIO
    'url': str, 'headers': dict[str, str],           # HTTP/SSE
    'env': dict[str, str],                           # Common
}
```

## Agent Skills

Skills extend agent capabilities with specialized tools and workflows. See [agentskills.io](https://agentskills.io/home) for the open standard.

```bash
# .env
EVOLVE_API_KEY=sk-...
COMPOSIO_API_KEY=...
```

```python
from evolve import Evolve

evolve = Evolve(
    skills=['pptx'],  # browser-use included by default
)

await evolve.run(prompt='Browse Hacker News top 5 articles and create a slide deck summarizing each')
```

### Documents
| Skill | Description | Source |
|-------|-------------|--------|
| `pdf` | Read, extract, and analyze PDF documents | [skills/pdf](https://github.com/evolving-machines-lab/evolve/tree/main/skills/pdf) |
| `docx` | Create and edit Word documents | [skills/docx](https://github.com/evolving-machines-lab/evolve/tree/main/skills/docx) |
| `pptx` | Create and edit PowerPoint presentations | [skills/pptx](https://github.com/evolving-machines-lab/evolve/tree/main/skills/pptx) |
| `xlsx` | Create and edit Excel spreadsheets | [skills/xlsx](https://github.com/evolving-machines-lab/evolve/tree/main/skills/xlsx) |

### Browser Automation

> **Note:** `browser-use` is included by default with Gateway mode (when using `EVOLVE_API_KEY`). These skills provide additional browser capabilities.

| Skill | Description | Source |
|-------|-------------|--------|
| `agent-browser` | CLI-based headless browser automation for AI agents | [skills/agent-browser](https://github.com/evolving-machines-lab/evolve/tree/main/skills/agent-browser) |
| `dev-browser` | Browser automation with persistent page state | [skills/dev-browser](https://github.com/evolving-machines-lab/evolve/tree/main/skills/dev-browser) |
| `webapp-testing` | Test web applications | [skills/webapp-testing](https://github.com/evolving-machines-lab/evolve/tree/main/skills/webapp-testing) |

### Research & Analysis
| Skill | Description | Source |
|-------|-------------|--------|
| `content-research-writer` | Research and write content | [skills/content-research-writer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/content-research-writer) |
| `lead-research-assistant` | Research and qualify leads | [skills/lead-research-assistant](https://github.com/evolving-machines-lab/evolve/tree/main/skills/lead-research-assistant) |
| `meeting-insights-analyzer` | Analyze meeting insights | [skills/meeting-insights-analyzer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/meeting-insights-analyzer) |
| `developer-growth-analysis` | Analyze developer growth metrics | [skills/developer-growth-analysis](https://github.com/evolving-machines-lab/evolve/tree/main/skills/developer-growth-analysis) |
| `competitive-ads-extractor` | Extract and analyze competitor ads | [skills/competitive-ads-extractor](https://github.com/evolving-machines-lab/evolve/tree/main/skills/competitive-ads-extractor) |

### Design & Media
| Skill | Description | Source |
|-------|-------------|--------|
| `canvas-design` | Canvas and design creation | [skills/canvas-design](https://github.com/evolving-machines-lab/evolve/tree/main/skills/canvas-design) |
| `image-enhancer` | Enhance and process images | [skills/image-enhancer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/image-enhancer) |
| `theme-factory` | Create themes and styles | [skills/theme-factory](https://github.com/evolving-machines-lab/evolve/tree/main/skills/theme-factory) |
| `video-downloader` | Download videos from URLs | [skills/video-downloader](https://github.com/evolving-machines-lab/evolve/tree/main/skills/video-downloader) |
| `slack-gif-creator` | Create GIFs for Slack | [skills/slack-gif-creator](https://github.com/evolving-machines-lab/evolve/tree/main/skills/slack-gif-creator) |

### Business & Productivity
| Skill | Description | Source |
|-------|-------------|--------|
| `file-organizer` | Organize files and directories | [skills/file-organizer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/file-organizer) |
| `invoice-organizer` | Organize and process invoices | [skills/invoice-organizer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/invoice-organizer) |
| `brand-guidelines` | Brand asset and guidelines management | [skills/brand-guidelines](https://github.com/evolving-machines-lab/evolve/tree/main/skills/brand-guidelines) |
| `internal-comms` | Internal communications tools | [skills/internal-comms](https://github.com/evolving-machines-lab/evolve/tree/main/skills/internal-comms) |
| `tailored-resume-generator` | Generate tailored resumes | [skills/tailored-resume-generator](https://github.com/evolving-machines-lab/evolve/tree/main/skills/tailored-resume-generator) |
| `domain-name-brainstormer` | Brainstorm domain names | [skills/domain-name-brainstormer](https://github.com/evolving-machines-lab/evolve/tree/main/skills/domain-name-brainstormer) |

### Development
| Skill | Description | Source |
|-------|-------------|--------|
| `mcp-builder` | Build MCP servers | [skills/mcp-builder](https://github.com/evolving-machines-lab/evolve/tree/main/skills/mcp-builder) |
| `skill-creator` | Create new skills | [skills/skill-creator](https://github.com/evolving-machines-lab/evolve/tree/main/skills/skill-creator) |
| `skill-share` | Share skills with others | [skills/skill-share](https://github.com/evolving-machines-lab/evolve/tree/main/skills/skill-share) |
| `changelog-generator` | Generate changelogs from commits | [skills/changelog-generator](https://github.com/evolving-machines-lab/evolve/tree/main/skills/changelog-generator) |
| `artifacts-builder` | Build artifacts and deliverables | [skills/artifacts-builder](https://github.com/evolving-machines-lab/evolve/tree/main/skills/artifacts-builder) |

### Other
| Skill | Description | Source |
|-------|-------------|--------|
| `raffle-winner-picker` | Pick raffle winners randomly | [skills/raffle-winner-picker](https://github.com/evolving-machines-lab/evolve/tree/main/skills/raffle-winner-picker) |

---

## Composio (Tool Router)

Access 1000+ integrations (GitHub, Gmail, Slack, etc.) via [Composio](https://composio.dev).

[Tool Router Overview](https://docs.composio.dev/tool-router/overview) — How Tool Router works and integration guide.

[Available Toolkits](https://docs.composio.dev/toolkits/introduction) — Browse all 1000+ supported integrations.

```bash
# .env
EVOLVE_API_KEY=sk-...      # Evolve gateway key
COMPOSIO_API_KEY=...         # Get from https://app.composio.dev
```

```python
from evolve import Evolve, ComposioSetup

evolve = Evolve(
    composio=ComposioSetup(user_id='user_123'),  # All tools, in-chat OAuth
)

await evolve.run(prompt='Create a GitHub issue for the login bug')
```

### Authentication Paths

**1. In-chat auth (default)** — Composio prompts user to authenticate via agent output:
```python
from evolve import Evolve, ComposioSetup

evolve = Evolve(
    composio=ComposioSetup(user_id='user_123'),  # Agent prompts "Connect to GitHub" when needed
)

await evolve.run(prompt='Star my favorite repos on GitHub')
```

**2. API key auth** — Bypass OAuth for tools that support API keys:
```python
import os
from evolve import Evolve, ComposioSetup, ComposioConfig

evolve = Evolve(
    composio=ComposioSetup(
        user_id='user_123',
        config=ComposioConfig(
            toolkits=['stripe', 'sendgrid'],
            keys={
                'stripe': os.getenv('STRIPE_API_KEY'),
                'sendgrid': os.getenv('SENDGRID_API_KEY'),
            },
        ),
    ),
)

await evolve.run(prompt='List my recent Stripe payments')
```

**3. Manual OAuth (app UI)** — Get OAuth URL to show in your settings page:
```python
from evolve import Evolve, ComposioSetup, ComposioConfig

# Get OAuth URL for "Connect GitHub" button
result = await Evolve.composio.auth('user_123', 'github')
# Render: <a href={result.url}>Connect GitHub</a>

# Check connection status (simple)
status = await Evolve.composio.status('user_123')
# {'github': True, 'gmail': False, 'slack': True}

# Check single toolkit
is_github_connected = await Evolve.composio.status('user_123', 'github')
# True | False

# Get detailed connection info (with account IDs)
connections = await Evolve.composio.connections('user_123')
# [ComposioConnectionStatus(toolkit='github', connected=True, account_id='ca_...'), ...]

# Then use in agent (user already connected via UI)
evolve = Evolve(
    composio=ComposioSetup(
        user_id='user_123',
        config=ComposioConfig(toolkits=['github']),
    ),
)

await evolve.run(prompt='List my open PRs')
```

**4. White-label OAuth** — Use custom OAuth configs from [Composio dashboard](https://app.composio.dev):
```python
from evolve import Evolve, ComposioSetup, ComposioConfig

evolve = Evolve(
    composio=ComposioSetup(
        user_id='user_123',
        config=ComposioConfig(
            toolkits=['github'],
            auth_configs={'github': 'ac_your_custom_oauth_app'},
        ),
    ),
)

await evolve.run(prompt='Create a new private repo')
```

### Tool Filtering

```python
from evolve import Evolve, ComposioSetup, ComposioConfig

evolve = Evolve(
    composio=ComposioSetup(
        user_id='user_123',
        config=ComposioConfig(
            toolkits=['github', 'gmail', 'slack'],
            tools={
                'github': ['github_create_issue', 'github_list_repos'],  # Enable only these
                'gmail': {'disable': ['gmail_delete_email']},            # Disable dangerous tools
                'slack': {'tags': ['readOnlyHint']},                     # Filter by behavior tags
            },
        ),
    ),
)

await evolve.run(prompt='Send a Slack message about the GitHub issue')
```

### Type Reference

**ComposioSetup** — configuration for `composio=ComposioSetup(...)`:
```python
@dataclass
class ComposioSetup:
    user_id: str                                            # User's unique identifier
    config: Optional[ComposioConfig] = None                 # Optional configuration

@dataclass
class ComposioConfig:
    toolkits: Optional[List[str]] = None                    # e.g. ['gmail', 'notion', 'stripe']
    tools: Optional[Dict[str, ToolsFilter]] = None          # Per-toolkit tool filtering
    keys: Optional[Dict[str, str]] = None                   # API keys (bypasses OAuth)
    auth_configs: Optional[Dict[str, str]] = None           # Custom OAuth auth config IDs

ToolsFilter = Union[
    List[str],                                              # Enable only these tools
    EnableFilter,                                           # {'enable': [...]}
    DisableFilter,                                          # {'disable': [...]}
    TagsFilter,                                             # {'tags': [...]}
]
```

---

## 3. Runtime Methods

`run()` and `execute_command()` are async and return `AgentResponse`. `status()` is async and returns `SessionStatus`. `interrupt()` returns `bool`.

```python
@dataclass
class AgentResponse:
    sandbox_id: str
    exit_code: int
    stdout: str
    stderr: str
    checkpoint: CheckpointInfo | None  # Present when storage= configured and run succeeded — see Section 5.1

@dataclass
class SessionStatus:
    sandbox_id: str | None
    sandbox: str
    agent: str
    active_process_id: str | None
    has_run: bool
    timestamp: str
```

### 3.1 run

Runs the agent with a given prompt.

```python
result = await evolve.run(
    prompt='Analyze the data and create a report',
    timeout_ms=15 * 60 * 1000,                # (optional) Default 1 hour
    background=False,                          # (optional) Run in background
    from_checkpoint='ckpt_abc123',             # (optional) Restore from checkpoint ID or 'latest'
    checkpoint_comment='after analysis',       # (optional) Label for the auto-checkpoint
)

print(result.exit_code)
print(result.stdout)
print(result.checkpoint.id if result.checkpoint else None)  # Checkpoint ID (if storage= configured)
```

- If `timeout_ms` is omitted the agent uses the default of 3_600_000 ms (1 hour).
- If `background` is `True`, the call returns immediately with a start handshake (`exit_code=0`), not final completion. Completion is delivered asynchronously via `lifecycle` events (`run_background_complete` or `run_background_failed`) or by polling `status()`.
- If `from_checkpoint` is set, the SDK restores a checkpoint into a fresh sandbox before running. Pass a checkpoint ID or `'latest'` to restore the most recent. Requires `storage=`. Cannot be used with `sandbox_id=`.
- If `checkpoint_comment` is set, the auto-checkpoint created after a successful run is labeled with this string. Requires `storage=`.
- Calling `run()` multiple times maintains the agent context / history.
- Calling `run()` while another run or command is active throws immediately. Call `interrupt()` first or wait for the active operation to finish.

### 3.2 execute_command

Runs a direct shell command in the sandbox working directory.

```python
# Run shell command directly in sandbox
result = await evolve.execute_command(
    command='pytest',
    timeout_ms=10 * 60 * 1000,                # (optional) Default 1 hour
    background=False,                          # (optional) Run in background
)
```

- If `background` is `True`, returns a start handshake (`exit_code=0`). Completion arrives via `lifecycle` events (`command_background_complete` or `command_background_failed`).

### 3.3 Streaming Events

Both `run()` and `execute_command()` stream output in real-time:

```python
from evolve import Evolve, AgentConfig

evolve = Evolve(config=AgentConfig(type='claude'))

# Parsed events (recommended)
evolve.on('content', lambda event: print(event['update']['sessionUpdate']))
evolve.on('lifecycle', lambda event: print(event['reason'], event['sandbox']))

# Raw output (debugging)
evolve.on('stdout', lambda data: print(data, end=''))
evolve.on('stderr', lambda data: print(f'[ERR] {data}', end=''))

await evolve.run(prompt='Hello')
```

| Event | Type | Description |
|-------|------|-------------|
| `content` | `OutputEvent` | Parsed ACP-style events (recommended) |
| `lifecycle` | `dict` (`LifecycleEvent` shape below) | Sandbox and agent state transitions |
| `stdout` | `str` | Raw JSONL output |
| `stderr` | `str` | Error output |

`evolve.on(...)` supports only: `stdout`, `stderr`, `content`, `lifecycle`.
Passing any other event name raises `ValueError`.

---

### LifecycleEvent (TypedDict shape)

```python
class LifecycleEvent(TypedDict):
    sandbox_id: str | None
    sandbox: Literal["booting", "error", "ready", "running", "paused", "stopped"]
    agent: Literal["idle", "running", "interrupted", "error"]
    timestamp: str
    reason: Literal[
        "sandbox_boot",
        "sandbox_connected",
        "sandbox_ready",
        "sandbox_pause",
        "sandbox_resume",
        "sandbox_killed",
        "sandbox_error",
        "run_start",
        "run_complete",
        "run_interrupted",
        "run_failed",
        "run_background_complete",
        "run_background_failed",
        "command_start",
        "command_complete",
        "command_interrupted",
        "command_failed",
        "command_background_complete",
        "command_background_failed",
    ]
```

---

### Type Definitions

Use these `TypedDict` definitions for type hints:

```python
from typing import TypedDict, Literal, Union, NotRequired

# =============================================================================
# Content Types
# =============================================================================

class TextContent(TypedDict):
    type: Literal["text"]
    text: str

class ImageContent(TypedDict):
    type: Literal["image"]
    data: str          # Base64-encoded
    mimeType: str      # "image/png", "image/jpeg"
    uri: NotRequired[str]

ContentBlock = Union[TextContent, ImageContent]

class DiffContent(TypedDict):
    type: Literal["diff"]
    path: str
    oldText: str | None  # None for new files
    newText: str

class WrappedContent(TypedDict):
    type: Literal["content"]
    content: ContentBlock

ToolCallContent = Union[WrappedContent, DiffContent]

# =============================================================================
# Tool Types
# =============================================================================

ToolKind = Literal[
    "read",        # Read, NotebookRead
    "edit",        # Edit, Write, NotebookEdit
    "delete",      # (future)
    "move",        # (future)
    "search",      # Glob, Grep, LS
    "execute",     # Bash, BashOutput, KillShell
    "think",       # Task (subagent)
    "fetch",       # WebFetch, WebSearch
    "switch_mode", # ExitPlanMode
    "other",       # MCP tools (including browser-use), unknown
]

# IMPORTANT: Browser-use MCP tools have kind="other", not "browser" or "fetch".
# To identify browser tools in your UI, check if title starts with "browser-use:"
# (e.g., "browser-use: browser_task", "browser-use: monitor_task")

def is_browser_use_tool(title: str | None) -> bool:
    """Helper to detect browser-use tools."""
    return "browser-use" in (title or "").lower()

ToolCallStatus = Literal["pending", "in_progress", "completed", "failed"]

class ToolCallLocation(TypedDict):
    path: str
    line: NotRequired[int]

# =============================================================================
# Session Update Types
# =============================================================================

class AgentMessageChunk(TypedDict):
    sessionUpdate: Literal["agent_message_chunk"]
    content: ContentBlock

class AgentThoughtChunk(TypedDict):
    sessionUpdate: Literal["agent_thought_chunk"]
    content: ContentBlock

class UserMessageChunk(TypedDict):
    sessionUpdate: Literal["user_message_chunk"]
    content: ContentBlock

class ToolCall(TypedDict):
    sessionUpdate: Literal["tool_call"]
    toolCallId: str
    title: str
    kind: ToolKind
    status: ToolCallStatus
    rawInput: NotRequired[dict]
    content: NotRequired[list[ToolCallContent]]
    locations: NotRequired[list[ToolCallLocation]]

class ToolCallUpdate(TypedDict):
    sessionUpdate: Literal["tool_call_update"]
    toolCallId: str
    status: NotRequired[ToolCallStatus]
    title: NotRequired[str]
    content: NotRequired[list[ToolCallContent]]
    locations: NotRequired[list[ToolCallLocation]]

PlanEntryStatus = Literal["pending", "in_progress", "completed"]

class PlanEntry(TypedDict):
    content: str
    status: PlanEntryStatus
    priority: Literal["high", "medium", "low"]

class Plan(TypedDict):
    sessionUpdate: Literal["plan"]
    entries: list[PlanEntry]

SessionUpdate = Union[
    AgentMessageChunk,
    AgentThoughtChunk,
    UserMessageChunk,
    ToolCall,
    ToolCallUpdate,
    Plan,
]

# =============================================================================
# Top-Level Event
# =============================================================================

class OutputEvent(TypedDict):
    sessionId: NotRequired[str]
    update: SessionUpdate

# =============================================================================
# Browser-Use Response (First-Party Integration)
# =============================================================================

class BrowserUseResponse(TypedDict):
    """Browser automation response embedded in ToolCallUpdate.content[].content.text as JSON string."""
    task_id: NotRequired[str]         # Task ID for monitoring
    session_id: NotRequired[str]      # Browser session ID
    live_url: NotRequired[str]        # VNC live view URL
    screenshot_url: NotRequired[str]  # Final screenshot URL
    steps: NotRequired[list[dict]]    # Per-step screenshots with url, memory, screenshot_url
    is_success: NotRequired[bool]     # Task completion status
    task_output: NotRequired[str]     # Final task result
```

---

### BrowserUseResponse Extraction

Browser automation (`browser-use`) is included by default in Gateway mode. Browser tool responses embed a **JSON string** inside `ToolCallUpdate["content"][].content.text`. You must extract and parse it.

> **Detection:** Browser-use tools arrive with `kind="other"` and `title` like `"browser-use: browser_task"` or `"browser-use: monitor_task"`. Use `is_browser_use_tool(title)` to identify them, then extract URLs from the tool output.

**Extraction function** (use regex first for speed and malformed JSON tolerance, then JSON fallback):

```python
import re
import json
from typing import Optional

def extract_browser_use_urls(text: str) -> dict[str, Optional[str]]:
    """Extract browser-use URLs from tool response text.

    Returns:
        {"live_url": str | None, "screenshot_url": str | None}
    """
    live_url: Optional[str] = None
    screenshot_url: Optional[str] = None

    # 1. Regex extraction (fast, handles malformed JSON)
    live_match = re.search(r'"live_url"\s*:\s*"([^"]+)"', text)
    if live_match:
        live_url = live_match.group(1)

    screenshot_match = re.search(r'"screenshot_url"\s*:\s*"([^"]+)"', text)
    if screenshot_match:
        screenshot_url = screenshot_match.group(1)

    # 2. JSON fallback (for steps[].screenshot_url)
    if not live_url or not screenshot_url:
        try:
            parsed: BrowserUseResponse = json.loads(text)
            if not live_url:
                live_url = parsed.get("live_url")
            if not screenshot_url:
                steps = parsed.get("steps", [])
                screenshot_url = parsed.get("screenshot_url") or (
                    steps[-1].get("screenshot_url") if steps else None
                )
        except (json.JSONDecodeError, IndexError, KeyError):
            pass

    return {"live_url": live_url, "screenshot_url": screenshot_url}
```

---

### Event Types Summary

| Type | `sessionUpdate` | Description |
|------|-----------------|-------------|
| `AgentMessageChunk` | `"agent_message_chunk"` | Text/image streaming from agent |
| `AgentThoughtChunk` | `"agent_thought_chunk"` | Reasoning (Codex) or thinking (Claude) |
| `UserMessageChunk` | `"user_message_chunk"` | User message echo (Gemini) |
| `ToolCall` | `"tool_call"` | Tool execution started |
| `ToolCallUpdate` | `"tool_call_update"` | Tool execution finished |
| `Plan` | `"plan"` | TodoWrite updates (replaces entire list) |

---

### ToolKind Reference

| Kind | Tools | Icon |
|------|-------|------|
| `read` | Read, NotebookRead | :page_facing_up: |
| `edit` | Edit, Write, NotebookEdit | :pencil2: |
| `search` | Glob, Grep, LS | :mag: |
| `execute` | Bash, BashOutput, KillShell | :zap: |
| `think` | Task (subagent) | :brain: |
| `fetch` | WebFetch, WebSearch | :globe_with_meridians: |
| `switch_mode` | ExitPlanMode | :twisted_rightwards_arrows: |
| `other` | MCP tools, unknown | :grey_question: |

---

### UI Integration Example

```python
from typing import cast

def handle_event(event: OutputEvent) -> None:
    update = event["update"]
    event_type = update["sessionUpdate"]

    if event_type == "agent_message_chunk":
        msg = cast(AgentMessageChunk, update)
        if msg["content"]["type"] == "text":
            ui.append_message(msg["content"]["text"])
        else:
            img = cast(ImageContent, msg["content"])
            ui.append_image(img["data"], img["mimeType"])

    elif event_type == "agent_thought_chunk":
        thought = cast(AgentThoughtChunk, update)
        ui.append_thought(thought["content"])

    elif event_type == "user_message_chunk":
        # Gemini echo - typically ignored
        pass

    elif event_type == "tool_call":
        tool = cast(ToolCall, update)
        ui.add_tool(
            id=tool["toolCallId"],
            title=tool["title"],
            kind=tool["kind"],
            status=tool["status"],
            locations=tool.get("locations"),
        )

    elif event_type == "tool_call_update":
        update_data = cast(ToolCallUpdate, update)

        # 1. Always update tool card with result
        ui.update_tool(
            update_data["toolCallId"],
            status=update_data.get("status"),
            content=update_data.get("content"),
        )

        # 2. Extract browser-use URLs if present (first-party integration)
        for c in update_data.get("content") or []:
            if c.get("type") == "content":
                inner = c.get("content", {})
                if inner.get("type") == "text":
                    urls = extract_browser_use_urls(inner["text"])
                    if urls["live_url"]:
                        ui.show_live_view_button(urls["live_url"])
                    if urls["screenshot_url"]:
                        ui.show_screenshot(urls["screenshot_url"])

    elif event_type == "plan":
        plan = cast(Plan, update)
        ui.render_plan(plan["entries"])

evolve.on("content", handle_event)
```

---

### Key Patterns

1. **Handle all 6 event types** — Don't silently drop unknown events
2. **Match tools by ID** — `tool_call` and `tool_call_update` share `toolCallId`
3. **Handle out-of-order** — `tool_call_update` may arrive before `tool_call`
4. **Concatenate chunks** — Message text arrives incrementally
5. **Support images** — `ContentBlock` includes `ImageContent`
6. **Use `kind` for icons** — Categorize tools visually (read, edit, execute, etc.)
7. **Track `locations`** — Show affected file paths in UI
8. **Use `cast()` for narrowing** — TypedDict unions need explicit casting after checking `sessionUpdate`
9. **Detect browser-use by title** — Browser-use MCP tools have `kind="other"`, check `"browser-use" in title.lower()` to identify them

### 3.4 Upload: Local → Sandbox

**Format:** `{"destination": content}` — directories created automatically

| Method | Destination |
|--------|-------------|
| `upload_context()` | `/home/user/workspace/context/{path}` |
| `upload_files()` | `/home/user/workspace/{path}` |

```python
# Single file
await evolve.upload_context({'spec.json': json.dumps(data)})

# Multiple files
await evolve.upload_files({
    'scripts/setup.sh': '#!/bin/bash\necho hello',
    'data/input.csv': csv_bytes,
})

# From local directory (helper)
from evolve import read_local_dir
await evolve.upload_context(read_local_dir('./input', recursive=True))
```

> **Setup alternative:** Constructor parameters `context` and `files` use the same format but upload on first `run()` instead of immediately.

### 3.5 Download: Sandbox → Local

**Flow:** `get_output_files()` → `save_local_dir()`

```python
# Return type
@dataclass
class OutputResult:
    files: dict          # All files from output/ folder
    data: Any | None     # Parsed result.json (if schema was set via schema=)
    error: str | None    # Validation error message (if schema validation failed)
    raw_data: str | None # Raw result.json content when parse/validation failed (for debugging)
```

```python
from pydantic import BaseModel
from evolve import Evolve, save_local_dir

class ResultSchema(BaseModel):
    summary: str
    score: float

evolve = Evolve(
    config=AgentConfig(...),
    schema=ResultSchema,  # Agent will be prompted to write result.json
)

await evolve.run(prompt='Analyze and score the document')

output = await evolve.get_output_files(recursive=True)  # recursive=True for nested dirs

# Access all fields
save_local_dir('./output', output.files)  # Save files locally
print(output.data)                         # ResultSchema(summary='...', score=85.0)
print(output.error)                        # None (or validation error message)
```

- **`files`** — dict of all files from `output/` folder
- **`data`** — Parsed `result.json` validated against schema (None if no schema or validation failed). For Pydantic schemas, returns a model instance.
- **`error`** — Validation error message if schema validation failed (None otherwise)
- **`raw_data`** — Raw result.json content when parse/validation failed (for debugging)

Files created before the last `run()` or `execute_command()` are filtered out.

### 3.6 Session controls

```python
session_id = await evolve.get_session()  # Returns sandbox ID (str) or None

status = await evolve.status()  # Runtime status snapshot
# status.sandbox           -> "stopped" | "booting" | "ready" | "running" | "paused" | "error"
# status.agent             -> "idle" | "running" | "interrupted" | "error"
# status.has_run           -> bool
# status.sandbox_id        -> str | None
# status.active_process_id -> str | None
# status.timestamp         -> str (ISO 8601)

ok = await evolve.interrupt()  # Interrupts active run() or execute_command() process; keeps sandbox alive. Returns bool.

# Steer a running task: interrupt, then reprompt in same session.
# The next run() auto-continues conversation history/context for this sandbox session.
await evolve.run(prompt='Do a full migration plan', background=True)
await evolve.interrupt()
await evolve.run(prompt='Change direction: only auth migration.')

await evolve.pause()   # Suspends sandbox (stops billing, preserves state)
await evolve.resume()  # Reactivates same sandbox

await evolve.kill()    # Destroys sandbox; next run() creates a new sandbox

await evolve.set_session('existing-sandbox-id')  # Sets sandbox ID; reconnection happens on next run()

# Checkpointing (requires storage= — see Section 5.1)
ckpt = await evolve.checkpoint(comment='before refactor')   # Explicit snapshot of current sandbox
checkpoints = await evolve.list_checkpoints(limit=10)       # List checkpoints, newest first
```

`sandbox_id` is a constructor parameter for initialization—it sets the sandbox ID before the first `run()`. `set_session()` is a runtime method that actively interrupts any running process, flushes the session log, resets checkpoint lineage, and switches to the new sandbox. They are **not** interchangeable: use `sandbox_id=` when constructing, `set_session()` when switching mid-session.

**Provider caveats:**
- **E2B / Daytona** — full support for `pause()`, `resume()`, `interrupt()`.
- **Modal** — does not support `pause()`. `interrupt()` is effectively unsupported and returns `False` for active processes.

### 3.7 get_host

Expose a forwarded port:

```python
url = await evolve.get_host(8000)
print(f'Workspace service available at {url}')
```
---

## 4. Workspace Setup & Structured Output

Calling `run` or `execute_command` for the first time provisions a sandbox with the following filesystem:

```
/home/user/workspace/
├── context/     # Input files (read-only) provided by the user
├── scripts/     # Your code goes here
├── temp/        # Scratch space
├── output/      # Final deliverables
└── CLAUDE.md    # System prompt (or AGENT.md, GEMINI.md, QWEN.md depending on agent)
```

Files passed to `context` are uploaded to `context/`. Files passed to `files` are uploaded relative to the working directory.

## Filesystem Instructions
Evolve writes a default filesystem instructions to the agent's config file in the workspace (`CLAUDE.md`, `AGENT.md`, `GEMINI.md`, or `QWEN.md`):

```
## FILESYSTEM INSTRUCTIONS

You are running in a sandbox environment.

Present working directory: /home/user/workspace/

IMPORTANT - Directory structure:
/home/user/workspace/
├── context/   # Input files (read-only) provided by the user
├── scripts/   # Your code goes here
├── temp/      # Scratch space
└── output/    # Final deliverables

## OUTPUT RESULTS (DELIVERABLES) MUST BE SAVED to `output/` as files.
```

Any string passed to `system_prompt` is automatically appended to the agent's config file in the workspace (`CLAUDE.md`, `AGENT.md`, `GEMINI.md`, or `QWEN.md`) after this default.

## Structured Output

When you provide a `schema`, Evolve instructs the agent to write structured JSON output.

```python
from pydantic import BaseModel

class CREData(BaseModel):
    property_name: str
    units: int
    total_rent: float
    occupancy_rate: float

evolve = Evolve(
    schema=CREData,
    context={
        'rent_roll.pdf': open('rent_roll.pdf', 'rb').read(),
    },
)

await evolve.run(prompt='Extract CRE data from the rent roll')

output = await evolve.get_output_files()
print(output.data)  # CREData(property_name='...', units=120, ...)
```

When a schema is provided, `get_output_files()` automatically validates `output/result.json` and returns `OutputResult` (see [Section 3.5](#35-download-sandbox--local)).

```python
# Type-safe access to validated data
if output.data:
    print(output.data.property_name)  # Pydantic model instance
else:
    print(output.error)               # "Schema validation failed: ..."
    print(output.raw_data)            # Raw JSON for debugging
```

The SDK automatically appends the following to the agent's config file in the workspace (`CLAUDE.md`, `AGENT.md`, `GEMINI.md`, or `QWEN.md`):

~~~
## STRUCTURED OUTPUT

Your final result MUST be saved to `output/result.json` following this schema:

```json
{
  "type": "object",
  "properties": {
    "property_name": { "type": "string" },
    "units": { "type": "integer" },
    "total_rent": { "type": "number" },
    "occupancy_rate": { "type": "number" }
  },
  "required": ["property_name", "units", "total_rent", "occupancy_rate"]
}
```

You are free to:
- Reason through the problem step by step
- Read and analyze context files
- Use any available tools
- Process incrementally
- Create intermediate files in `temp/` or `scripts/`

But your final `output/result.json` MUST conform to the schema above.

### OUTPUT RESULTS (DELIVERABLES) MUST BE WRITTEN to `output/result.json` as files.
### Never just state results as text.
~~~

---

## 5. Cleaning up and session management

**Multi-turn conversations** (most common):

```python
evolve = Evolve(
    config=AgentConfig(...),
)

await evolve.run(prompt='Analyze data.csv')
output = await evolve.get_output_files()

# Still same session, automatically maintains context / history
await evolve.run(prompt='Now create visualization')
output2 = await evolve.get_output_files()

# Still same session, automatically maintains context / history
await evolve.run(prompt='Export to PDF')
output3 = await evolve.get_output_files()

await evolve.kill()  # When done
```

**One-shot tasks** (automatic cleanup):

```python
async with evolve:
    result = await evolve.run(prompt='...')
    output = await evolve.get_output_files()
# Calls kill() automatically via __aexit__()
```

**Pause and resume** (same instance):

```python
evolve = Evolve(
    config=AgentConfig(...),
)

await evolve.run(prompt='Start analysis')
await evolve.pause()  # Suspend billing, keep state
# Do other work...
await evolve.resume()  # Reactivate same sandbox
await evolve.run(prompt='Continue analysis')  # Session intact

await evolve.kill()  # Kill the Sandbox when done
```

**Save and reconnect** (different script/session):

```python
# Script 1: Save session for later
evolve = Evolve(
    config=AgentConfig(...),
)

await evolve.run(prompt='Start analysis')

session_id = await evolve.get_session()
# Save to file, database, environment variable, etc.
with open('session.txt', 'w') as f:
    f.write(session_id)

# Script 2: Reconnect to saved session
with open('session.txt') as f:
    saved_id = f.read()

evolve2 = Evolve(
    config=AgentConfig(...),
    sandbox_id=saved_id  # Reconnect
)

await evolve2.run(prompt='Continue analysis')  # Session continues from Script 1
```

**Switch between sandboxes** (same instance):

```python
evolve = Evolve(
    config=AgentConfig(...),
)

# Work with first sandbox
await evolve.run(prompt='Analyze dataset A')
session_a = await evolve.get_session()

# Switch to different sandbox
await evolve.set_session('existing-sandbox-b-id')
await evolve.run(prompt='Analyze dataset B')  # Now working with sandbox B

# Switch back to first sandbox
await evolve.set_session(session_a)
await evolve.run(prompt='Compare results')  # Back to sandbox A
```

---

## 5.1 Storage & Checkpointing

Persist sandbox state beyond sandbox lifetime. Checkpoints archive specific directories under `/home/user/` to S3-compatible storage and can be restored into a fresh sandbox.

**What gets checkpointed:**
- `/home/user/workspace/` — your project files
- `/home/user/.<agent>/` — agent settings and session history (e.g. `.claude/`, `.codex/`, `.gemini/`, `.qwen/`)

- **Auto-checkpoint:** Every successful `run()` with `storage=` creates a checkpoint automatically.
- **Content-addressed dedup:** Archives are hashed (SHA-256). Same content = skip upload.
- **Lineage tracking:** Each checkpoint records its `parent_id`, forming a chain across runs and restores.

### Modes

| | BYOK | Gateway |
|---|------|---------|
| Setup | `storage=StorageConfig(url='s3://...')` + AWS credentials | `storage=StorageConfig()` + `EVOLVE_API_KEY` |
| Storage | Your S3/R2/MinIO bucket | Evolve-managed |
| Metadata | JSON files in S3 | Dashboard database |

### Configuration

```python
from evolve import Evolve, AgentConfig, StorageConfig, StorageCredentials

# BYOK — your own S3 bucket
evolve = Evolve(
    config=AgentConfig(type='claude'),
    storage=StorageConfig(
        url='s3://my-bucket/agent-snapshots/',  # S3 URL (bucket + prefix)
        region='us-west-2',                      # (optional) Default: AWS_REGION env or us-east-1
    ),
)

# BYOK — Cloudflare R2 / MinIO / custom endpoint
evolve = Evolve(
    config=AgentConfig(type='claude'),
    storage=StorageConfig(
        url='s3://my-bucket/prefix/',
        endpoint='https://acct.r2.cloudflarestorage.com',
    ),
)

# Gateway — Evolve-managed storage (no S3 credentials needed)
evolve = Evolve(
    config=AgentConfig(type='claude'),
    storage=StorageConfig(),  # Reads EVOLVE_API_KEY from env
)
```

**StorageConfig:**

```python
@dataclass
class StorageConfig:
    url: str | None = None          # 's3://bucket/prefix' or 'https://endpoint/bucket/prefix'
    bucket: str | None = None       # Explicit bucket (overrides URL parsing)
    prefix: str | None = None       # Key prefix (overrides URL parsing)
    region: str | None = None       # AWS region (default: AWS_REGION env or 'us-east-1')
    endpoint: str | None = None     # Custom S3 endpoint (R2, MinIO, GCS)
    credentials: StorageCredentials | None = None  # StorageCredentials(access_key_id='...', secret_access_key='...') (default: AWS SDK chain)
```

**BYOK prerequisites:**

```bash
# The Python SDK bridges to Node.js — AWS SDK packages must be installed for BYOK storage
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner

# Set credentials (or use any method supported by the AWS SDK credential chain)
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
```

> The AWS SDK packages are loaded dynamically at runtime by the Node.js bridge. If they are not installed, the SDK throws a clear error with install instructions.

### Auto-Checkpoint (via `run()`)

Every successful foreground `run()` auto-creates a checkpoint:

```python
evolve = Evolve(
    config=AgentConfig(type='claude'),
    storage=StorageConfig(url='s3://my-bucket/snapshots/'),
)

result = await evolve.run(
    prompt='Build the report',
    checkpoint_comment='initial draft',  # (optional) Label
)

print(result.checkpoint.id)       # 'ckpt_m5abc_xyz123'
print(result.checkpoint.hash)     # SHA-256 of archive
print(result.checkpoint.comment)  # 'initial draft'
```

**Behavior notes:**

- **Non-fatal:** Auto-checkpoint failures are logged but never cause `run()` to throw. The run result will have `checkpoint` as `None`.
- **Foreground only:** Background runs (`background=True`) skip auto-checkpointing entirely.
- **Exclusions:** The archive excludes `node_modules/`, `__pycache__/`, `*.pyc`, `.cache/`, `.npm/`, `.pip/`, `.venv/`, `venv/`, and `{workspace}/temp/` to keep snapshots lean.
- **Dedup:** Archives are content-addressed by SHA-256 hash. If the hash matches an existing archive in storage, the upload is skipped—only the metadata entry is written.
- **`from_checkpoint='latest'` edge case:** If no checkpoints exist globally (across all sessions/tags), `from_checkpoint='latest'` throws an error. Note that `'latest'` resolves to the globally newest checkpoint, not scoped to the current session tag. Use `list_checkpoints()` first to check availability.

### Explicit Checkpoint

Snapshot at any point (between runs, after manual setup, etc.):

```python
ckpt = await evolve.checkpoint(comment='before refactor')
print(ckpt.id)  # 'ckpt_m5def_abc456'
```

Requires an active sandbox (`run()` must have been called first).

### Restore from Checkpoint

Pass `from_checkpoint` to `run()` to restore a checkpoint into a fresh sandbox before running:

```python
# Restore by checkpoint ID
result = await evolve.run(
    prompt='Continue where we left off',
    from_checkpoint='ckpt_m5abc_xyz123',
)

# Restore the most recent checkpoint
result = await evolve.run(
    prompt='Pick up from latest state',
    from_checkpoint='latest',
)
```

- `from_checkpoint` creates a fresh sandbox, downloads the archive, verifies hash integrity, and extracts it.
- Cannot be used with `sandbox_id=` (restore requires a fresh sandbox).
- The restored checkpoint becomes the `parent_id` for the next checkpoint, maintaining lineage.
- Agent type and workspace mode must match the checkpoint (model changes are fine).

### Listing Checkpoints

**Instance method** (uses storage config from `storage=`):

```python
checkpoints = await evolve.list_checkpoints(
    limit=10,                    # (optional) Max results (default: 100, max: 500)
    tag='my-session-tag',        # (optional) Filter by session tag
)

for ckpt in checkpoints:
    print(ckpt.id, ckpt.comment, ckpt.timestamp)
```

**Standalone function** (no Evolve instance needed):

```python
from evolve import list_checkpoints, StorageConfig

# BYOK — same limit=/tag= options as evolve.list_checkpoints()
all_checkpoints = await list_checkpoints(
    StorageConfig(url='s3://my-bucket/snapshots/'),
    limit=10, tag='my-session',
)

# Gateway (reads EVOLVE_API_KEY from env)
recent = await list_checkpoints(StorageConfig(), limit=5)
```

Results are sorted newest first.

### Checkpoint Lineage

Each checkpoint records `parent_id`—the checkpoint it was created from. Consecutive runs build a chain:

```python
r1 = await evolve.run(prompt='Step 1')
# r1.checkpoint.parent_id → None (first checkpoint)

r2 = await evolve.run(prompt='Step 2')
# r2.checkpoint.parent_id → r1.checkpoint.id

r3 = await evolve.run(prompt='Step 3')
# r3.checkpoint.parent_id → r2.checkpoint.id
```

Restoring from a checkpoint sets that checkpoint as the parent for subsequent checkpoints:

```python
# Later: restore from r1 and branch
r4 = await evolve.run(prompt='Branch from step 1', from_checkpoint=r1.checkpoint.id)
# r4.checkpoint.parent_id → r1.checkpoint.id (not r3)
```

### CheckpointInfo

```python
@dataclass
class CheckpointInfo:
    id: str                       # Checkpoint ID — pass as from_checkpoint to restore
    hash: str                     # SHA-256 of tar.gz archive
    tag: str                      # Session tag at checkpoint time
    timestamp: str                # ISO 8601
    size_bytes: int | None        # Archive size in bytes
    agent_type: str | None        # 'claude' | 'codex' | 'gemini' | 'qwen'
    model: str | None             # Model used
    workspace_mode: str | None    # 'knowledge' | 'swe'
    parent_id: str | None         # Parent checkpoint ID (lineage)
    comment: str | None           # User-provided label
```

### End-to-End Example

```python
from evolve import Evolve, AgentConfig, StorageConfig, list_checkpoints

# 1. Create and checkpoint
evolve = Evolve(
    config=AgentConfig(type='claude'),
    storage=StorageConfig(url='s3://my-bucket/project/'),
)

r1 = await evolve.run(
    prompt="Create a file called report.txt with 'Draft v1'",
    checkpoint_comment='initial draft',
)
print('Checkpoint 1:', r1.checkpoint.id)

# 2. Second run — auto-chains parent_id
r2 = await evolve.run(
    prompt="Append ' - reviewed' to report.txt",
    checkpoint_comment='reviewed',
)
print('Checkpoint 2:', r2.checkpoint.id)
print('Parent:', r2.checkpoint.parent_id)  # → r1.checkpoint.id

await evolve.kill()

# 3. Restore into fresh sandbox
evolve2 = Evolve(
    config=AgentConfig(type='claude'),
    storage=StorageConfig(url='s3://my-bucket/project/'),
)

r3 = await evolve2.run(
    prompt='Read report.txt — what does it say?',
    from_checkpoint=r1.checkpoint.id,  # Restore from checkpoint 1
)
# Agent sees 'Draft v1' (not the reviewed version)

await evolve2.kill()

# 4. List all checkpoints
all_checkpoints = await list_checkpoints(StorageConfig(url='s3://my-bucket/project/'))
print(f'{len(all_checkpoints)} checkpoints (newest first)')
```

---

## 6. Observability

Full execution traces—including tool calls, file operations (read/write/edit), text responses, and reasoning chunks—are logged to your Evolve dashboard at **https://dashboard.evolvingmachines.ai/traces** for debugging and replay.

Additionally, every run and command is logged locally to structured JSON lines under `~/.evolve-sdk/observability/sessions`. File name format:

```
{tag}_{provider}_{sandboxId}_{agent}_{timestamp}.jsonl
```

- `{tag}` – `my-prefix-` + 16 random hex characters (e.g. `my-prefix-a1b2c3d4e5f6g7h8`)
- `{provider}` – the sandbox provider (e.g. `e2b`)
- `{sandboxId}` – the active sandbox ID
- `{agent}` – the agent type (`codex`, `claude`, `gemini`, `qwen`)
- `{timestamp}` – ISO timestamp with `:` and `.` replaced by `-`

Each file contains three entry types:

```json
{"_meta":{"tag":"my-prefix-a1b2c3d4","provider":"e2b","agent":"qwen","model":"qwen-coder-plus-latest","sandbox_id":"sbx_123","timestamp":"2025-10-26T20:15:17.984Z"}}
{"_prompt":{"text":"hello how are you?"}}
{"jsonrpc":"2.0","method":"session/update", ...}
```

- `_meta` – exactly one line per file (sandbox, agent, timestamp)
- `_prompt` – one line per `run()` call with the prompt text
- Raw JSON – every streamed payload (ACP notifications, stdout, etc.)

Attach your own prefix to make logs easy to search:

```python
evolve = Evolve(
    config=AgentConfig(...),
    session_tag_prefix='my-project'
)

await evolve.run(prompt='Kick off analysis')

print(await evolve.get_session_tag())        # "my-project-ab12cd34"
print(await evolve.get_session_timestamp())  # Timestamp for first log file

await evolve.kill()                          # Flushes log file for sandbox A

await evolve.run(prompt='Start fresh')       # New sandbox → new log file

print(await evolve.get_session_tag())        # "my-project-f56789cd"
print(await evolve.get_session_timestamp())  # Timestamp for second log file
```

- `kill()` or `set_session()` flushes the current log; the next `run()` starts a
  fresh file with the new sandbox id.
- Long-running sessions (pause/resume or ACP auto-resume) keep appending to the
  current file, so you always have the full timeline.
- Logging is buffered inside the SDK, so it never blocks streaming output.

Use the tag together with the sandbox id to correlate logs with files saved in
`/output/`.

---

# Swarm Abstractions

Functional programming for AI agents: `map`, `filter`, `reduce`, `best_of`.

```python
from evolve import Swarm, SwarmConfig, AgentConfig, ComposioSetup, ComposioConfig
from pydantic import BaseModel  # Or use plain JSON Schema dicts instead

agent = AgentConfig(type='claude')

swarm = Swarm(SwarmConfig(
    agent=agent,                     # Default agent for all operations
    concurrency=4,                   # Max parallel sandboxes (default: 4)
    timeout_ms=3_600_000,            # Default timeout per worker (default: 1 hour)
    tag='my-pipeline',               # Tag prefix for observability
    skills=['pdf'],                  # Default skills (browser-use included by default)
    composio=ComposioSetup(          # Default Composio config for all workers
        user_id='user_123',
        config=ComposioConfig(toolkits=['gmail', 'notion']),
    ),
    mcp_servers={...},               # Default MCP servers for all workers
    retry=RetryConfig(               # Default retry config for all operations
        max_attempts=3,
        backoff_ms=1000,
        backoff_multiplier=2,
    ),
))
```

> **Defaults**: `agent`, `skills`, `composio`, `mcp_servers`, `timeout_ms`, and `retry` set here are inherited by all operations (`map`, `filter`, `reduce`, `best_of`). Pass these options to individual operations to override.

**SwarmConfig** — configuration for Swarm instance:
```python
SwarmConfig(
    agent=AgentConfig,
    skills=list[str],
    composio=ComposioSetup,
    mcp_servers=dict[str, McpServerConfig],
    concurrency=int,
    timeout_ms=int,
    tag=str,
    retry=RetryConfig,
)
```

| Option | Default | Notes |
|--------|---------|-------|
| `agent.type` | `'claude'` | Auto-resolved from env |
| `agent.model` | per type | `'opus'` (claude), `'gpt-5.2'` (codex), etc. |
| `skills` | `None` | Set here or per-operation |
| `composio` | `None` | Set here or per-operation |
| `mcp_servers` | `None` | Set here or per-operation |
| `concurrency` | `4` | Max parallel sandboxes |
| `timeout_ms` | `3_600_000` | 1 hour per worker |
| `tag` | `'swarm'` | Observability prefix |
| `retry` | `None` | Set here or per-operation |

**Minimal setup** — with `EVOLVE_API_KEY` set (see [1.1 Authentication](#11-authentication)):

```python
from dotenv import load_dotenv
load_dotenv()  # If using .env file

from evolve import Swarm

swarm = Swarm()  # Auto-resolves agent (claude) and sandbox from env
```

**RetryConfig** — auto-retry on error with exponential backoff:
```python
RetryConfig(
    max_attempts=3,
    backoff_ms=1000,
    backoff_multiplier=2,
    retry_on=lambda r: r.status == 'error',        # Custom condition
    on_item_retry=lambda idx, attempt, error: ..., # Callback
)
```

## 1. Input Types

Swarm runs in **knowledge mode** by default—files are uploaded to `context/` in the sandbox.

**FileMap structure:**

```python
# FileMap: dict[path, content]
#   - path: str              → file path in context/ folder
#   - content: str | bytes   → file content

FileMap = dict[str, str | bytes]
```

---

**Case 1: One file per worker**

```python
# 3 workers, each gets 1 file
items: list[FileMap] = [
    {'report.txt': 'Q1 revenue...'},      # → Worker 0: context/report.txt
    {'report.txt': 'Q2 revenue...'},      # → Worker 1: context/report.txt
    {'report.txt': 'Q3 revenue...'},      # → Worker 2: context/report.txt
]

results = await swarm.map(
    items=items,
    prompt='Summarize this report',
)
```

---

**Case 2: Multiple files per worker**

```python
# 3 workers, each gets 2 files
items: list[FileMap] = [
    {                                       # → Worker 0:
        'doc1.pdf': open('./doc1.pdf', 'rb').read(),  #   context/doc1.pdf
        'doc2.pdf': open('./doc2.pdf', 'rb').read(),  #   context/doc2.pdf
    },
    {                                       # → Worker 1:
        'doc3.pdf': open('./doc3.pdf', 'rb').read(),  #   context/doc3.pdf
        'doc4.pdf': open('./doc4.pdf', 'rb').read(),  #   context/doc4.pdf
    },
    {                                       # → Worker 2:
        'doc5.pdf': open('./doc5.pdf', 'rb').read(),  #   context/doc5.pdf
        'doc6.pdf': open('./doc6.pdf', 'rb').read(),  #   context/doc6.pdf
    },
]

results = await swarm.map(
    items=items,
    prompt='Compare these two documents',
)
```

---

**Case 3: Entire folder per worker**

```python
from evolve import read_local_dir

# read_local_dir(path, recursive) → returns FileMap with all files
items: list[FileMap] = [
    read_local_dir('./project-a', recursive=True),   # → Worker 0: all files from project-a
    read_local_dir('./project-b', recursive=True),   # → Worker 1: all files from project-b
    read_local_dir('./project-c', recursive=True),   # → Worker 2: all files from project-c
]

results = await swarm.map(
    items=items,
    prompt='Review this codebase',
)
```

## 2. Abstractions

Two types of operations:

| Operation | Type | Description | Passes On |
|-----------|------|-------------|-----------|
| `best_of` | transform + select | `input` → `output` (best of N candidates) | winner output |
| `map` | transform | `input` → `output` (agent produces new data) | agent output |
| `filter` | gate | `input` → `input` (agent evaluates, condition decides) | original input + status (`success` \| `filtered`) |
| `reduce` | transform | `inputs` → `output` (agent synthesizes) | agent output |

**Transforms** produce new output files. **Filter** passes through original input files unchanged.

**BestOfConfig** — run N candidates in parallel, judge picks the best:
```python
BestOfConfig(
    n=int,
    judge_criteria=str,
    task_agents=list[AgentConfig],
    judge_agent=AgentConfig,
    skills=list[str],
    judge_skills=list[str],
    composio=ComposioSetup,
    judge_composio=ComposioSetup,
    mcp_servers=dict[str, McpServerConfig],
    judge_mcp_servers=dict[str, McpServerConfig],
    on_candidate_complete=Callable[[int, int, str], None],
    on_judge_complete=Callable[[int, int, str], None],
)
```

**VerifyConfig** — LLM-as-judge verifies output, retries with feedback if failed:
```python
VerifyConfig(
    criteria=str,
    max_attempts=int,
    verifier_agent=AgentConfig,
    verifier_skills=list[str],
    verifier_composio=ComposioSetup,
    verifier_mcp_servers=dict[str, McpServerConfig],
    on_worker_complete=Callable[[int, int, str], None],
    on_verifier_complete=Callable[[int, int, bool, str | None], None],
)
```

### 2.1 best_of

Run N agents on the same `item` in parallel, then a judge picks the best. `Agent[i]` outputs `candidates[i]`, judge selects `winner`.

```
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│    Sandbox 0    │ │    Sandbox 1    │ │    Sandbox 2    │
│    Agent 0      │ │    Agent 1      │ │    Agent 2      │
│                 │ │                 │ │                 │
│  context/       │ │  context/       │ │  context/       │
│    item         │ │    item         │ │    item         │
│  output/        │ │  output/        │ │  output/        │
│    candidates[0]│ │    candidates[1]│ │    candidates[2]│
└───────┬─────────┘ └───────┬─────────┘ └───────┬─────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
                    ┌───────────────┐
                    │     Judge     │
                    └───────┬───────┘
                            │
                            ▼
                         winner
```

```python
# Signature
await swarm.best_of(
    item=FileMap | SwarmResult,
    prompt=str,
    config=BestOfConfig(                    # n?, judge_criteria, task_agents?, judge_agent?, callbacks
        judge_criteria='...',
        n=3,
        on_candidate_complete=lambda idx, cand_idx, status: ...,
        on_judge_complete=lambda idx, winner_idx, reasoning: ...,
    ),
    name=str,                               # Operation name for observability (appears in meta.operation_name)
    schema=PydanticModel | dict,            # Optional
    system_prompt=str,                      # Optional
    retry=RetryConfig(...),                 # Per-candidate retry (judge uses default)
    timeout_ms=int,                         # Optional
) -> BestOfResult
```

```python
input_item = {'task.txt': 'Complex problem...'}

result = await swarm.best_of(
    item=input_item,
    prompt='Solve this problem',
    config=BestOfConfig(
        n=3,
        judge_criteria='Most accurate and well-explained solution',
        on_candidate_complete=lambda idx, cand_idx, status: print(f'Candidate {cand_idx}: {status}'),
        on_judge_complete=lambda idx, winner_idx, reasoning: print(f'Winner: {winner_idx}'),
    ),
)

print(result.winner)          # Best SwarmResult
print(result.winner_index)    # 0, 1, or 2
print(result.judge_reasoning) # Why this was chosen
print(result.candidates)      # All candidate results
```

Use different agents per candidate:

```python
claude_agent = AgentConfig(type='claude', model='opus')
codex_agent = AgentConfig(type='codex', model='gpt-5.2-codex')
gemini_agent = AgentConfig(type='gemini', model='gemini-3-flash')

result = await swarm.best_of(
    item=input_item,
    prompt='Solve this',
    config=BestOfConfig(
        task_agents=[claude_agent, codex_agent, gemini_agent],
        judge_criteria='Best solution quality',
        judge_agent=claude_agent,
        mcp_servers={...},           # (optional) MCP servers for candidates
        judge_mcp_servers={...},     # (optional) MCP servers for judge
        skills=['pdf'],              # (optional) Skills for candidates
        judge_skills=['pdf'],        # (optional) Skills for judge
        composio=ComposioSetup(...), # (optional) Composio config for candidates
        judge_composio=ComposioSetup(...),  # (optional) Composio config for judge
    ),
)
```

### 2.2 map

Process items in parallel. `Agent[i]` sees `items[i]` and outputs `results[i]` (which includes `result.json` if `schema` provided).

```
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│    Sandbox 0    │ │    Sandbox 1    │ │    Sandbox 2    │
│    Agent 0      │ │    Agent 1      │ │    Agent 2      │
│                 │ │                 │ │                 │
│  context/       │ │  context/       │ │  context/       │
│    items[0]     │ │    items[1]     │ │    items[2]     │
│  output/        │ │  output/        │ │  output/        │
│    results[0]   │ │    results[1]   │ │    results[2]   │
└───────┬─────────┘ └───────┬─────────┘ └───────┬─────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
              [results[0], results[1], results[2]]
```

```python
# Signature (schema accepts Pydantic model or JSON Schema dict)
await swarm.map(
    items=list[FileMap] | list[SwarmResult],
    prompt=str | Callable[[FileMap, int], str],
    name=str,                               # Operation name for observability (appears in meta.operation_name)
    schema=PydanticModel | dict,            # Optional
    system_prompt=str,                      # Optional
    agent=AgentConfig,                      # Optional override
    best_of=BestOfConfig,                   # N candidates + judge (mutually exclusive with verify)
    verify=VerifyConfig,                    # LLM-as-judge quality check with retry loop
    retry=RetryConfig,                      # Auto-retry on error with backoff
    mcp_servers=dict[str, McpServerConfig], # Optional
    skills=list[str],                       # Optional - e.g. ['pdf']
    composio=ComposioSetup,                 # Composio Tool Router config
    timeout_ms=int,                         # Optional
) -> SwarmResultList
```

```python
# Basic
results = await swarm.map(
    items=documents,
    prompt='Summarize this document',
)
```

When `schema` is provided, a structured output prompt is automatically embedded—instructing the agent to write `output/result.json` matching the schema.

```python
# With Pydantic schema
class SummarySchema(BaseModel):
    title: str
    key_points: list[str]

results = await swarm.map(
    items=documents,
    prompt='Extract summary',
    schema=SummarySchema,
)

# Or with JSON Schema
summary_json_schema = {
    'type': 'object',
    'properties': {
        'title': {'type': 'string'},
        'key_points': {'type': 'array', 'items': {'type': 'string'}},
    },
    'required': ['title', 'key_points'],
}

results = await swarm.map(
    items=documents,
    prompt='Extract summary',
    schema=summary_json_schema,
)

# With dynamic prompt
results = await swarm.map(
    items=documents,
    prompt=lambda files, index: f'Analyze document {index + 1}: focus on revenue',
)

# Access results
for r in results:
    if r.status == 'success':
        print(r.data)   # Parsed schema instance or FileMap
        print(r.files)  # Output files from agent
```

### 2.3 map with best_of

Combine map parallelism with best_of quality:

```python
class AnalysisSchema(BaseModel):
    findings: list[str]
    confidence: float

# Each item gets N candidates, judge picks best per item
results = await swarm.map(
    items=documents,
    prompt='Analyze thoroughly',
    schema=AnalysisSchema,
    best_of=BestOfConfig(
        n=3,
        judge_criteria='Most comprehensive analysis',
        # task_agents=[...],       # Different agent per candidate
        # judge_agent=...,         # Override judge agent
        # mcp_servers={...},       # MCP servers for candidates
        # judge_mcp_servers={...}, # MCP servers for judge
        # skills=[...],            # Skills for candidates
        # judge_skills=[...],      # Skills for judge
    ),
)

# Results contain only winners (one per input item)
```

### 2.4 filter

Two-step evaluation (`schema` and `condition` are required):
1. `Agent[i]` sees `items[i]`, assesses it, outputs `result.json` matching `schema`
2. SDK parses `result.json` → `data`, your `condition(data)` applies the threshold
3. Passing items forward their original input files, not agent output

```
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│    Sandbox 0    │ │    Sandbox 1    │ │    Sandbox 2    │
│    Agent 0      │ │    Agent 1      │ │    Agent 2      │
│                 │ │                 │ │                 │
│  context/       │ │  context/       │ │  context/       │
│    items[0]     │ │    items[1]     │ │    items[2]     │
│  output/        │ │  output/        │ │  output/        │
│    result.json  │ │    result.json  │ │    result.json  │
└───────┬─────────┘ └───────┬─────────┘ └───────┬─────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
                   condition(data)
                      ✓    ✗    ✓
                      │         │
                      ▼         ▼
                [items[0], items[2]]
```

```python
# Signature (schema accepts Pydantic model or JSON Schema dict)
await swarm.filter(
    items=list[FileMap] | list[SwarmResult],
    prompt=str,                             # Describe what to assess (agent outputs result.json)
    name=str,                               # Operation name for observability (appears in meta.operation_name)
    schema=PydanticModel | dict,            # Required - defines evaluation output structure
    condition=Callable[[Any], bool],        # Local function applies threshold
    system_prompt=str,                      # Optional
    agent=AgentConfig,                      # Optional override
    verify=VerifyConfig,                    # LLM-as-judge quality check with retry loop
    retry=RetryConfig,                      # Auto-retry on error with backoff
    mcp_servers=dict[str, McpServerConfig], # Optional
    skills=list[str],                       # Optional - e.g. ['pdf']
    composio=ComposioSetup,                 # Composio Tool Router config
    timeout_ms=int,                         # Optional
) -> SwarmResultList
```

```python
class EvalSchema(BaseModel):
    severity: Literal['critical', 'warning', 'info']
    score: float

results = await swarm.filter(
    items=documents,
    prompt='Assess the severity of issues in this document',  # Agent evaluates
    schema=EvalSchema,
    condition=lambda data: data.severity == 'critical',       # Code applies threshold
)

# Three possible statuses:
results.success    # Passed condition
results.filtered   # Evaluated but didn't pass
results.error      # Agent error

# Chain to next step
await swarm.reduce(
    items=results.success,
    prompt='Summarize critical issues',
)
```

### 2.5 reduce

Synthesize many items into one. A single agent sees all `items` as `item_0/`, `item_1/`, etc. and outputs a unified `result` (which includes `result.json` if `schema` provided).

```
        ┌─────────────────────────┐
        │         Sandbox         │
        │         Agent           │
        │                         │
        │  context/               │
        │    item_0/items[0]      │
        │    item_1/items[1]      │
        │    item_2/items[2]      │
        │  output/                │
        │    result               │
        └────────────┬────────────┘
                     │
                     ▼
                  result
```

```python
# Signature (schema accepts Pydantic model or JSON Schema dict)
await swarm.reduce(
    items=list[FileMap] | list[SwarmResult],
    prompt=str,
    name=str,                               # Operation name for observability (appears in meta.operation_name)
    schema=PydanticModel | dict,            # Optional
    system_prompt=str,                      # Optional
    agent=AgentConfig,                      # Optional override
    verify=VerifyConfig,                    # LLM-as-judge quality check with retry loop
    retry=RetryConfig,                      # Auto-retry on error with backoff
    mcp_servers=dict[str, McpServerConfig], # Optional
    skills=list[str],                       # Optional - e.g. ['pdf']
    composio=ComposioSetup,                 # Composio Tool Router config
    timeout_ms=int,                         # Optional
) -> ReduceResult
```

```python
# Agent sees: item_0/, item_1/, item_2/, etc.
report = await swarm.reduce(
    items=results.success,
    prompt='Create a unified report from all analyses',
)

if report.status == 'success':
    print(report.files)  # Final output files
    print(report.data)   # Parsed schema if provided

# With schema
class ReportSchema(BaseModel):
    summary: str
    recommendations: list[str]

report = await swarm.reduce(
    items=items,
    prompt='Create report',
    schema=ReportSchema,
)
```

## 3. Result Types

```python
@dataclass
class SwarmResult:
    """Result from map, filter, best_of candidates."""
    status: Literal['success', 'filtered', 'error']
    data: Any | None        # Parsed schema, or None on error
    files: FileMap          # Output files (map/best_of) or input files (filter)
    meta: IndexedMeta       # operation_id, operation, tag, sandbox_id, item_index
    error: str | None       # Error message if status == 'error'
    raw_data: str | None    # Raw result.json when parse/validation failed
    best_of: BestOfInfo | None  # Present when map used best_of option
    verify: VerifyInfo | None   # Present when verify option was used

# SwarmResultList - from map, filter (extends list)
results.success    # list[SwarmResult] with status 'success'
results.filtered   # list[SwarmResult] with status 'filtered'
results.error      # list[SwarmResult] with status 'error'

@dataclass
class ReduceResult:
    """Result from reduce."""
    status: Literal['success', 'error']
    data: Any | None
    files: FileMap
    meta: ReduceMeta        # operation_id, operation, tag, sandbox_id, input_count, input_indices
    error: str | None
    raw_data: str | None
    verify: VerifyInfo | None

@dataclass
class VerifyInfo:
    """Verification outcome."""
    passed: bool            # Final verification status
    reasoning: str          # Verifier's reasoning
    verify_meta: VerifyMeta # operation_id, operation, tag, sandbox_id, attempts
    attempts: int           # Total attempts made

@dataclass
class BestOfInfo:
    """Present when map used best_of option."""
    winner_index: int
    judge_reasoning: str
    judge_meta: JudgeMeta   # operation_id, operation, tag, sandbox_id, candidate_count
    candidates: list[SwarmResult]

@dataclass
class BestOfResult:
    """Result from best_of."""
    winner: SwarmResult
    winner_index: int
    judge_reasoning: str
    judge_meta: JudgeMeta   # operation_id, operation, tag, sandbox_id, candidate_count
    candidates: list[SwarmResult]
```

## 4. Chaining Operations

When chaining Swarm operations, `result.json` from a previous step is automatically renamed to `data.json`. This avoids confusion when the downstream agent writes its own `result.json`. This also applies to [Pipeline](#7-pipeline).

**Example: map → reduce chain**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  MAP (parallel)                                                             │
│                                                                             │
│  item_0 agent writes:          item_1 agent writes:                         │
│  output/                       output/                                      │
│    result.json ← schema        result.json ← schema                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  REDUCE (single agent)                                                      │
│                                                                             │
│  context/                                                                   │
│    item_0/                                                                  │
│      data.json      ← renamed from result.json                              │
│    item_1/                                                                  │
│      data.json      ← renamed from result.json                              │
│  output/                                                                    │
│    result.json      ← reduce agent writes its own                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

```python
class AnalysisSchema(BaseModel):
    summary: str

class SeveritySchema(BaseModel):
    severity: Literal['critical', 'warning', 'info']

# Full pipeline: map → filter → reduce
analyzed = await swarm.map(
    items=documents,
    prompt='Analyze',
    schema=AnalysisSchema,
)

critical = await swarm.filter(
    items=analyzed.success,
    prompt='Evaluate severity',
    schema=SeveritySchema,
    condition=lambda d: d.severity == 'critical',
)

report = await swarm.reduce(
    items=critical.success,
    prompt='Create summary report',
)

# Combine success and filtered
all_evaluated = [*critical.success, *critical.filtered]
await swarm.reduce(
    items=all_evaluated,
    prompt='Summarize all evaluated items',
)
```

## 5. AgentOverride

Override the default agent for any operation (api_key inherited from Swarm config):

```python
@dataclass
class AgentConfig:
    type: Literal['claude', 'codex', 'gemini', 'qwen']
    api_key: str | None = None
    model: str | None = None
    reasoning_effort: Literal['low', 'medium', 'high', 'xhigh'] | None = None  # Codex only
    betas: list[str] | None = None  # Claude only
```

```python
codex_agent = AgentConfig(
    type='codex',
    reasoning_effort='high',
)

results = await swarm.map(
    items=items,
    prompt='Analyze',
    agent=codex_agent,
)
```

## 6. Concurrency

Global semaphore limits parallel sandboxes across all operations.

```python
swarm = Swarm(SwarmConfig(
    agent=agent,
    concurrency=4,  # Max 4 sandboxes at once (default: 4)
))

# map(10) with best_of(5) = 60 agent calls, but only 4 run at any time
```

**Ordering guarantees:**
- `best_of`: Judge runs only after all candidates complete
- `map` → `filter` → `reduce`: Each phase completes before next starts
- Within a phase: Items run in parallel (up to concurrency limit)

---

## 7. Pipeline

Fluent wrapper over Swarm for chaining operations. **All Swarm features work in Pipeline steps** — `schema`, `best_of`, `verify`, `retry`, `agent`, `mcp_servers`, `skills`, `composio`, dynamic prompts.

```python
from dotenv import load_dotenv
load_dotenv()

from evolve import Swarm, Pipeline

swarm = Swarm()  # See Swarm Abstractions for full config

pipeline = (
    Pipeline(swarm)
    .map(MapConfig(
        name='analyze',
        prompt='Analyze...',
        schema=AnalysisSchema,
    ))
    .filter(FilterConfig(
        name='critical',
        prompt='Rate...',
        schema=SeveritySchema,
        condition=lambda d: d.severity == 'critical',
    ))
    .reduce(ReduceConfig(
        name='report',
        prompt='Summarize...',
    ))
)

# Reusable — run with different data
result1 = await pipeline.run(batch1)
result2 = await pipeline.run(batch2)
```

### Step Configurations

Each step accepts the same options as the corresponding Swarm method, plus `name` for observability:

```python
# Map step — same as swarm.map() + name
MapConfig(
    name=str,                               # Step name (appears in events)
    prompt=str | Callable[[FileMap, int], str],
    schema=PydanticModel | dict,            # Optional
    best_of=BestOfConfig,                   # N candidates + judge
    verify=VerifyConfig,                    # LLM-as-judge quality check
    retry=RetryConfig,                      # Auto-retry on error
    agent=AgentConfig,
    mcp_servers=dict[str, McpServerConfig],
    skills=list[str],                       # Skills for workers
    composio=ComposioSetup,                 # Composio Tool Router config
    system_prompt=str,
    timeout_ms=int,
)

# Filter step — same as swarm.filter() + name + emit
FilterConfig(
    name=str,
    prompt=str,
    schema=PydanticModel | dict,            # Required
    condition=Callable[[Any], bool],        # Required
    emit='success' | 'filtered' | 'all',    # What passes to next step (default: 'success')
    verify=VerifyConfig,
    retry=RetryConfig,
    agent=AgentConfig,
    mcp_servers=dict[str, McpServerConfig],
    skills=list[str],                       # Skills for workers
    composio=ComposioSetup,                 # Composio Tool Router config
    system_prompt=str,
    timeout_ms=int,
)

# Reduce step — same as swarm.reduce() + name (terminal: no steps after)
ReduceConfig(
    name=str,
    prompt=str,
    schema=PydanticModel | dict,            # Optional
    verify=VerifyConfig,
    retry=RetryConfig,
    agent=AgentConfig,
    mcp_servers=dict[str, McpServerConfig],
    skills=list[str],                       # Skills for workers
    composio=ComposioSetup,                 # Composio Tool Router config
    system_prompt=str,
    timeout_ms=int,
)
```

### Full Example

```python
pipeline = (
    Pipeline(swarm)

    .map(MapConfig(
        name='analyze',
        prompt=lambda files, idx: f'Analyze document {idx + 1}',
        schema=AnalysisSchema,
        best_of=BestOfConfig(
            n=3,
            judge_criteria='Most thorough analysis',
        ),
        retry=RetryConfig(max_attempts=2),
        agent=AgentConfig(type='claude', model='opus'),
    ))

    .filter(FilterConfig(
        name='quality-gate',
        prompt='Rate the analysis quality',
        schema=QualitySchema,  # Has score: float, reasoning: str
        condition=lambda d: d.score >= 8,
        emit='success',                     # Only high-quality pass through
        verify=VerifyConfig(
            criteria='Rating must be justified with specific examples',
        ),
    ))

    .reduce(ReduceConfig(
        name='synthesize',
        prompt='Create executive summary from all analyses',
        schema=ReportSchema,
        verify=VerifyConfig(
            criteria='Summary must cover all key findings',
        ),
    ))

    .on('step_complete', lambda e: print(f'{e.name}: {e.success_count}/{e.success_count + e.error_count}'))
)

result = await pipeline.run(documents)
```

### Events

Pipeline unifies all Swarm callbacks at the pipeline level, adding `step_index` and `step_name`:

```python
(
    pipeline
    .on('step_start', lambda e: print(f'Step {e.index} started with {e.item_count} items'))
    .on('step_complete', lambda e: print(f'Step {e.index} done in {e.duration_ms}ms'))
    .on('step_error', lambda e: print(f'Step {e.index} failed: {e.error}'))
)

# Or object style
pipeline.on(PipelineEvents(
    on_step_complete=lambda e: print(f'{e.name}: {e.success_count} success'),
    on_item_retry=lambda e: print(f'Retry: step {e.step_index}, item {e.item_index}'),
    on_verifier_complete=lambda e: print(f"Verify: {'PASS' if e.passed else e.feedback}"),
))
```

| Event | Fields |
|-------|--------|
| `step_start` | `type`, `index`, `name?`, `item_count` |
| `step_complete` | `type`, `index`, `name?`, `duration_ms`, `success_count`, `error_count`, `filtered_count` |
| `step_error` | `type`, `index`, `name?`, `error` |
| `item_retry` | `step_index`, `step_name?`, `item_index`, `attempt`, `error` |
| `worker_complete` | `step_index`, `step_name?`, `item_index`, `attempt`, `status` |
| `verifier_complete` | `step_index`, `step_name?`, `item_index`, `attempt`, `passed`, `feedback?` |
| `candidate_complete` | `step_index`, `step_name?`, `item_index`, `candidate_index`, `status` |
| `judge_complete` | `step_index`, `step_name?`, `item_index`, `winner_index`, `reasoning` |

### Result

```python
@dataclass
class PipelineResult:
    pipeline_run_id: str
    steps: list[StepResult]   # type, index, duration_ms, results
    output: list[SwarmResult] | ReduceResult
    total_duration_ms: int

# Access step results
for step in result.steps:
    print(f'{step.type} took {step.duration_ms}ms')
```

### Terminal Pipeline

After `.reduce()`, no more steps can be added (returns `TerminalPipeline`):

```python
terminal = pipeline.reduce(ReduceConfig(prompt='...'))
terminal.map(MapConfig(prompt='...'))  # Raises: "Cannot add steps after reduce"
```

---
