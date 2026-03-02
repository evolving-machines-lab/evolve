# Configuration

## Sandbox Providers

Works with both Gateway mode (`EVOLVE_API_KEY`) and BYOK mode (provider API keys). With `EVOLVE_API_KEY` only, sandbox defaults to **E2B**. Add a sandbox provider key to auto-resolve to that provider.

All providers use the `evolve-all` image with pre-installed CLIs.

| Provider | Env Vars | Auto-Resolves When | First Time Setup |
|----------|----------|-------------------|------------------|
| E2B | `E2B_API_KEY` | Default, or `E2B_API_KEY` set | None — instant |
| Modal | `MODAL_TOKEN_ID` + `MODAL_TOKEN_SECRET` | Both Modal vars set | None — auto-builds image on first run (~2 min) |
| Daytona | `DAYTONA_API_KEY` | `DAYTONA_API_KEY` set | None — auto-creates snapshot on first run (~5 min) |

See [assets/README.md](https://github.com/evolving-machines-lab/evolve/blob/main/assets/README.md) for detailed setup instructions.

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
    image_name='evolve-all',              # (optional) Default: 'evolve-all'
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
    snapshot_name='evolve-all',             # (optional) Default: 'evolve-all'. Custom snapshots via build.sh daytona
)
```

---

## Evolve Instance

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
        type='codex',                        # 'claude' | 'codex' | 'gemini' | 'qwen' | 'kimi' | 'opencode' - defaults to 'claude'
        model='gpt-5.2-codex',               # (optional) Uses default if omitted. Use 'sonnet[1m]' / 'opus[1m]' for 1M context (Claude only)
        reasoning_effort='medium',           # (optional) 'low' | 'medium' | 'high' | 'xhigh' - Codex only
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

    # (optional) Storage for checkpoint persistence (gateway feature — requires EVOLVE_API_KEY)
    storage=StorageConfig(),

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
