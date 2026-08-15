# Configuration

## Sandbox Providers

Works with both Gateway mode (`EVOLVE_API_KEY`) and Direct Provider Key Mode (local BYOK provider keys). With `EVOLVE_API_KEY` only, sandbox defaults to **E2B**. Add a sandbox provider key to auto-resolve to that provider.

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

# .env - Direct Provider Key Mode with E2B (auto-resolves to E2B)
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

### Managed Sandboxes

With `EVOLVE_API_KEY` and no provider key, the platform runs the sandbox for you: Evolve
authenticates your key, creates the box on its own account, and records who owns it. You never
hold an E2B, Daytona, or Modal credential, and you are never billed by them directly.

That is already what auto-resolution does when only `EVOLVE_API_KEY` is set — it gives you a
managed **E2B** sandbox. To run on a different provider, say which one:

```python
from evolve import AgentConfig, Evolve, ManagedProvider

evolve = Evolve(
    config=AgentConfig(type='claude'),
    sandbox=ManagedProvider(provider='daytona'),
)

await evolve.run(prompt='Hello')
```

`ManagedProvider()` with no argument is managed E2B — the same sandbox auto-resolution gives you.
The provider is an argument rather than an environment variable on purpose: which provider your
program runs on is part of the program.

Beyond the provider name, `ManagedProvider` carries the Evolve key (when it should not come
from `EVOLVE_API_KEY`) plus sandbox-shape defaults applied to every sandbox it creates.
Every default rides the same validated path as a create-time option — a provider or managed
door that cannot enforce a value refuses it loudly, never silently ignores it:

```python
sandbox = ManagedProvider(
    provider='daytona',
    api_key='sk-...',              # (optional) Default: EVOLVE_API_KEY
    timeout_ms=7_200_000,          # (optional) Lifetime cap for every create
    resources={'cpu': 2},          # (optional) Sizing; refused where not enforceable
)
```

Managed Daytona carries both of Daytona's planes through the Dashboard — creating and listing
sandboxes, and every command and file operation the agent performs, including streamed command
output. Images come from the snapshots the platform publishes: a managed create names one and
never builds one, so a `resources` request that an existing snapshot cannot honor is refused
rather than silently ignored.

Managed Modal — `ManagedProvider(provider='modal')` — runs commands and file operations through
the Dashboard's Modal door. Command output streams live, chunk by chunk, and each command's
duration is bounded by the door: 60 minutes by default, 120 minutes at most — a longer
`timeout_ms` is refused with an error naming the bound, never silently shortened. Two Modal
traits carry over: there is no pause — persist progress with Evolve checkpoints instead — and
a running command cannot be interrupted. Sizing, network policy, and the sandbox user are the
platform's; a create that asks for them is refused rather than silently ignored. File writes
ride the door one JSON body at a time, capped at 1 MiB per request — and the cap is on WIRE
bytes, base64 inflation included, so the largest binary payload one write can carry is about
768 KiB (text rides as-is and gets the full 1 MiB). An over-cap write is refused with a typed
error before anything is sent; split the payload into smaller writes.

---

### E2B (default)
```bash
# .env - Gateway mode
EVOLVE_API_KEY=sk-...
E2B_API_KEY=e2b_...              # Optional with EVOLVE_API_KEY (auto-resolves)

# .env - Direct Provider Key Mode
ANTHROPIC_API_KEY=sk-ant-...     # Or OPENAI_API_KEY, GEMINI_API_KEY, CLAUDE_CODE_OAUTH_TOKEN
E2B_API_KEY=e2b_...              # Required in Direct Provider Key Mode
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

# .env - Direct Provider Key Mode
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

# .env - Direct Provider Key Mode
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
    snapshot_name='my-snapshot',            # (optional) Default: the current release snapshot ('evolve-all-c-<12hex>', tag derived from the image build inputs); explicit names pass through untouched. Custom snapshots via build.sh daytona
)
```

If a snapshot is found in a terminally failed state, the SDK deletes it and rebuilds it, so one bad build does not leave the name unusable. It only does this when it can rebuild the image itself — the reference carries a real tag or digest — and never for a bare name that resolves to no image, such as `my-team-env`.


---

## Sandbox Create Options

`sandbox_create_options` sets provider-neutral options used whenever Evolve creates a fresh sandbox — image, env vars, metadata, timeout, working directory, outbound network policy, and the user/home the agent runs as:

```python
from evolve import Evolve

evolve = Evolve(
    sandbox_create_options={
        'image': 'my-eval-template',        # (optional) Sandbox image/template ID (provider default if omitted)
        'envs': {'TASK_ID': 'swe-042'},     # (optional) Extra env vars (Evolve-owned runtime vars win on conflict)
        'metadata': {'suite': 'nightly'},   # (optional) Provider metadata
        'timeoutMs': 3600000,               # (optional) Sandbox timeout
        'workingDirectory': '/repo',        # (optional) Working directory for agent commands
        'network': {                        # (optional) Outbound network policy applied at boot
            'outbound': 'blocked',          # 'open' | 'blocked'
            'allowedDestinations': ['registry.npmjs.org', '10.0.0.0/8'],
        },
        'user': 'root',                     # (optional) Run all commands and file ops as this user
        'homeDir': '/root',                 # (optional) Home dir for agent config paths
    },
)
```

**Network policy.** `'outbound': 'blocked'` denies all outbound traffic except `allowedDestinations` (hostnames, IPs, or CIDR ranges). Providers that cannot enforce a requested policy reject it with an error — a policy is never silently ignored.

**User and home directory.** `user` runs every command and file operation as that user; providers that cannot enforce it reject it (E2B supports run-as-root). `homeDir` controls where agent config files (settings, session state, skills) are written. Defaults: `/root` when `user` is `'root'`, `/home/<user>` for other users, `/home/user` when no user is given. The default working directory follows as `<homeDir>/workspace`.

Constraints:

- A `user` can only be enforced at sandbox creation — combining it with `sandbox_id=`/`set_session()` (an existing sandbox) raises.
- Checkpoint storage (`storage=`) and managed browser features require the default `/home/user` home; combining them with a custom `user`/`homeDir` raises.
- `envs` entries are validated like `secrets=` values — Evolve-reserved variable names are rejected.

---

## Workspace Modes

`workspace_mode` controls what Evolve sets up in the working directory on first run:

| Mode | Workspace setup | Use it for |
|------|-----------------|------------|
| `'knowledge'` (default) | Creates `context/`, `scripts/`, `temp/`, `output/` + writes the system prompt file | General agent work with structured deliverables |
| `'swe'` | Same as knowledge + `repo/` for code repositories | Software-engineering tasks on cloned repos |

```python
evolve = Evolve(
    workspace_mode='swe',
    sandbox_create_options={'image': 'my-ci-template'},
)
```

---

## Evolve Instance

```python
import os
from evolve import Evolve, AgentConfig, E2BProvider, StorageConfig, IntegrationsSetup, ManagedSecretRef

# Sandbox provider (auto-resolved from E2B_API_KEY, or explicit)
sandbox = E2BProvider(
    api_key=os.getenv('E2B_API_KEY'),   # (optional) Auto-resolves from E2B_API_KEY env var
    timeout_ms=3600000,                  # (optional) Default sandbox timeout (default: 1 hour)
)
```

```python
import os

evolve = Evolve(

    # Agent configuration (optional if EVOLVE_API_KEY set, defaults to claude)
    config=AgentConfig(
        type='codex',                        # 'claude' | 'codex' | 'gemini' | 'qwen' | 'kimi' | 'opencode' | 'droid' - defaults to 'claude'
        model='gpt-5.3-codex',               # (optional) Uses default if omitted. Use 'fable' for Claude Fable 5 or 'sonnet[1m]' / 'opus[1m]' for 1M context (Claude only)
        reasoning_effort='medium',           # (optional) Native reasoning/thinking control; valid values vary by agent/model. Omitted = Evolve stamps its pinned per-harness default (see Getting Started → Agent Reference)
        # max_context_size=128000,           # (optional) Context/completion ceiling for CLIs that must be told one (see Getting Started → Harness and Model Pairing)
        api_key=os.getenv('EVOLVE_API_KEY'), # (optional) Gateway mode - auto-resolves from env
        # provider_api_key=os.getenv('ANTHROPIC_API_KEY'), # (optional) Direct Provider Key Mode
        # oauth_token=os.getenv('CLAUDE_CODE_OAUTH_TOKEN'), # (optional) Claude Max subscription
    ),

    # Sandbox provider (auto-resolved from E2B_API_KEY, or use sandbox from above)
    sandbox=sandbox,

    # (optional) Workspace mode: 'knowledge' (default) | 'swe' (see Workspace Modes above)
    workspace_mode='knowledge',

    # (optional) Provider-neutral options for fresh sandbox creation (see Sandbox Create Options above)
    sandbox_create_options={
        'image': 'my-task-image',
        'network': {'outbound': 'blocked', 'allowedDestinations': ['pypi.org']},
        'user': 'root',
    },

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

    # (optional) Gateway browser automation
    browser={'provider': 'agent-browser', 'remote': True},

    # (optional) Install plugins/extensions for the selected agent before first run
    plugins={
        'marketplace': 'https://github.com/org/codex-plugins.git',
        'sparse': ['.agents/plugins'],
    },

    # (optional) Skills for the agent — skills.sh / git / local references
    skills=['anthropics/skills', './my-skill'],

    # (optional) Managed integrations (gateway mode only)
    integrations=IntegrationsSetup(user_id='root', apps=['gmail', 'notion']),

    # (optional) Dashboard-stored managed secrets (gateway mode only)
    managed_secrets=[
        ManagedSecretRef(name='GITHUB_TOKEN'),
        ManagedSecretRef(name='SLACK_BOT_TOKEN', as_name='SLACK_TOKEN'),
    ],

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

## Browser Automation

Browser automation is opt-in. Use `browser={'provider': 'agent-browser', 'remote': True}` for browser, QA, dogfooding, and website automation tasks.

```python
Evolve(browser={'provider': 'agent-browser', 'remote': True})  # managed browser with dashboard live view and replay
```

Evolve automatically configures the browser runtime. In Gateway mode, the managed browser gives you:

- `event["browser"]["live_url"]` from the `browser_ready` lifecycle event
- `result.browser["live_url"]` after `run()` returns
- `result.session_id`, which is the id to use for traces and browser replay
- `sessions().browser_replay(session_id)`, which returns replay and raw `.mp4` download URLs after cleanup
- `replay.suggested_start_seconds`, when present, which is the recommended replay start time in seconds
- `replay.size_bytes` and `replay.ready_at`, when present, which describe the raw recording size and replay readiness time

`remote` controls where the browser session runs:

- `remote: True` creates an Evolve-managed cloud browser session, wires it into the sandbox, and exposes dashboard live view plus replay.
- `remote: False` runs browser automation locally inside the sandbox. Use it only when you do not need managed live view or replay.

Use the default managed remote browser unless you have a reason not to:

```python
Evolve(browser={'provider': 'agent-browser', 'remote': True})
# recommended: managed remote browser

Evolve(browser={'provider': 'agent-browser', 'remote': False})
# local agent-browser, no managed live/replay
```

Use a browser profile to reuse logged-in browser state across managed browser sessions:

```python
evolve = Evolve(
    browser={'profile': 'ramp-qa'},
)
```

Profiles are gateway-only and work only with managed remote browser sessions. Evolve stores and resolves profile state server-side; the SDK never receives raw browser state.

Profile lifecycle:

- First use: if the profile does not exist for the authenticated Evolve user, Dashboard creates an empty server-side browser profile and starts the managed browser with it.
- Reuse: if the profile already exists, Dashboard starts the browser with the existing state and updates `last_used_at`.
- Persist: browser state changes made during the session, such as successful logins, are saved when the managed browser is stopped. Call `kill()` when done so cleanup and replay processing run.
- Visibility: the profile appears in Dashboard **Secrets** under Browser Profiles and in `browser_profiles().list()`. Only metadata is returned; cookies and storage stay server-side.

Recommended profile creation flow:

1. Add the browser login in Dashboard **Secrets**, or manage browser logins from the SDK and note the `account_label`.
2. Start a managed browser with both a `profile` and scoped browser credentials.
3. Ask the agent to sign in with the saved login.
4. Call `kill()` when done so the authenticated browser state is saved into the profile.

```python
from evolve import Evolve, BrowserCredentialsConfig

evolve = Evolve(
    browser={'profile': 'ramp-qa'},
    browser_credentials=BrowserCredentialsConfig(
        allow=[{'website': 'github.com', 'account_label': 'qa-admin'}],
    ),
)

try:
    await evolve.run(
        prompt='Open GitHub, sign in with the saved qa-admin login, and confirm the account is authenticated.'
    )
finally:
    await evolve.kill()
```

Future runs can reuse the saved state with `browser={'profile': 'ramp-qa'}`; include `browser_credentials` again only when the agent needs access to saved login tools.

List or delete profiles from the SDK:

```python
from evolve import browser_profiles

profiles = await browser_profiles().list()

await browser_profiles().delete(profile='ramp-qa')
```

To disable browser automation, omit the `browser` argument.

Full browser run with live view and replay:

```python
from evolve import Evolve, sessions

evolve = Evolve(
    browser={'provider': 'agent-browser', 'remote': True},
    session_tag_prefix='checkout-qa',
)

browser_session = {'id': None}
session_id = None

def on_lifecycle(event):
    if event['reason'] == 'browser_ready' and event.get('browser'):
        show_live_browser(event['browser']['live_url'])
        browser_session['id'] = event['browser']['session_id']

evolve.on('lifecycle', on_lifecycle)

try:
    result = await evolve.run(
        prompt='Open the app, test the checkout flow, and report issues.'
    )

    session_id = result.session_id or browser_session['id']
    if result.browser and result.browser.get('live_url'):
        show_live_browser(result.browser['live_url'])
finally:
    await evolve.kill()

if not session_id:
    raise RuntimeError('Missing dashboard session id')

async with sessions() as session:
    replay = await session.browser_replay(
        session_id,
        timeout_ms=600_000,
        interval_ms=5_000,
    )

show_replay(replay.replay_url)
save_download_link(replay.download_url)
set_replay_start_time(replay.suggested_start_seconds or 0)
show_replay_metadata(
    size_bytes=replay.size_bytes,
    ready_at=replay.ready_at,
)
```

Replay processing starts when the managed browser is cleaned up, usually during `kill()`.
If replay is not ready before `timeout_ms`, call `browser_replay()` again later with the same `session_id`.
The `replay_url` already applies `suggested_start_seconds`; use the field separately only if your UI needs to display or store the recommended start time.
The `status` is `'ready'` once `browser_replay()` returns.

## Browser Credentials

Browser credentials let managed remote `agent-browser` runs sign in with saved website logins without exposing passwords to the agent.

Availability:

- Requires Gateway mode and managed remote `agent-browser`.
- Use `browser={'provider': 'agent-browser', 'remote': True}`.
- Not available with local browser mode, Direct Provider Key Mode, or existing sandbox sessions.

Dashboard setup:

1. Open the Evolve Dashboard.
2. Go to **Secrets**.
3. Add a browser login with `Account label`, `Website`, `Email`, and `Password`.
4. Use `Website` for the domain, such as `github.com`; use `Account label` as one word with no spaces, such as `qa-admin`, `work`, or `personal`, to distinguish multiple saved accounts for the same website. It is not the website username or email.

Passwords are encrypted client-side with RSA-OAEP-SHA256 against the dashboard's published public key before upload — the SDK verifies it is handed a genuine `rsaEncryption` key before encrypting, and a plaintext password never leaves the machine. The dashboard and SDK list only login metadata: account label, website, email, and last-used time.

Expose saved logins to a run:

```python
from evolve import Evolve, BrowserCredentialsConfig

evolve = Evolve(
    browser={'provider': 'agent-browser', 'remote': True},
    browser_credentials=BrowserCredentialsConfig(
        allow=[{'website': 'github.com', 'account_label': 'qa-admin'}],
    ),
)

await evolve.run(
    prompt='Open GitHub, sign in with the saved qa-admin login, and verify the repository settings page.'
)

await evolve.kill()
```

If `allow` is omitted, all enabled browser logins for the Evolve account are available to that run:

```python
from evolve import Evolve, BrowserCredentialsConfig

evolve = Evolve(
    browser={'provider': 'agent-browser', 'remote': True},
    browser_credentials=BrowserCredentialsConfig(),
)
```

The agent receives a run-scoped `browser-login` MCP server with these tools:

- `browser_list_logins` lists available website logins: website, account_label, and email only.
- `browser_login` fills the stored password and submits the current browser sign-in tab.
- `browser_complete_signup` generates a password, submits the current browser signup tab, and saves the new login.

Manage browser logins from the SDK:

```python
import os
from evolve import browser_credentials

credentials = browser_credentials()

await credentials.create(
    website='github.com',
    account_label='qa-admin',
    email='qualityassurance@example.com',
    password=os.environ['QA_GITHUB_PASSWORD'],
)

page = await credentials.list(website='github.com')

await credentials.delete(
    website='github.com',
    account_label='qa-admin',
)
```

## Agent Plugins

`plugins=` installs plugins/extensions into the sandbox user profile before the first agent command. The selected agent determines the accepted shape:

```python
# droid
plugins={
    'marketplace': 'https://github.com/Factory-AI/factory-plugins',
    'plugin': 'droid-control@factory-plugins',
}

# claude
plugins={
    'marketplace': 'anthropics/claude-code',
    'plugin': 'commit-commands@anthropics-claude-code',
}

# gemini
plugins={
    'source': 'https://github.com/org/gemini-extension',
    'ref': 'main',
}

# codex marketplace registration
plugins={
    'marketplace': 'https://github.com/org/codex-plugins.git',
    'sparse': ['.agents/plugins'],
}
```

If `config=AgentConfig(...)` is omitted, plugins target the default agent (`claude`).

## Agent Skills

Skills are folders of instructions and helper files — a `SKILL.md` manifest plus anything it needs — that the agent's harness discovers natively. The `skills` option takes real references; there is no built-in catalog:

```python
from evolve import Evolve

evolve = Evolve(
    skills=[
        'skills.sh/vercel-labs/agent-skills/frontend-design',     # one named skill from a skills.sh-listed repo
        'anthropics/skills',                                      # every skill a GitHub repo publishes
        'anthropics/skills@main',                                 # pinned to a branch, tag, or commit
        'https://github.com/org/repo/tree/main/skills/my-skill',  # any https git URL, down to a subfolder
        './my-skill',                                             # a local folder containing SKILL.md
    ],
)

await evolve.run(prompt='Create a slide deck summarizing the uploaded notes.')
```

Browse [skills.sh](https://skills.sh) for published skills. The SKILL.md format is the open standard described at [agentskills.io](https://agentskills.io/home).

How references resolve:

- Git references are pinned to their exact commit, fetched as a sparse checkout of only the skill content, and cached by commit under `~/.cache/evolve/skills` — the same reference always mounts the same bytes.
- A whole-repo reference discovers skills in the ecosystem's standard places: a `SKILL.md` at the repo root (one skill, named after the repo), `skills/`, `skills/.curated/`, `skills/.experimental/`, `skills/.system/`, and `.claude/skills/`.
- A local path, or an explicit `/tree/<ref>/<subdir>` URL, must be one skill folder containing `SKILL.md` — or a root whose immediate child directories each contain one. A child without `SKILL.md` is a loud refusal naming the child.
- Duplicate skill names resolve last-wins, and each skill mounts into the harness's native skills directory (for example `~/.claude/skills/<name>`), where the agent discovers it on its own.

## Managed Secrets

Managed secrets are available only in gateway mode (`EVOLVE_API_KEY`). Store the secret with a **Name**, an optional **Label**, and a **delivery mode** — in Dashboard **Secrets**, or programmatically through the SDK's `set()` / the CLI's `evolve secrets set` (below). Secrets are unique by `(name, label)` — several values of one name live side by side (`API_KEY` at `staging` and at `prod`) and a run attaches one by label. The SDK can list available names and attach the selected secrets to a run.

The delivery mode is chosen when the secret is saved and decides how the value reaches the sandbox:

- **`brokered`** — the value never enters any sandbox. The sandbox sees an opaque placeholder, and Evolve substitutes the real value only for HTTPS egress toward the secret's allowed hosts, paths, and methods (required for brokered secrets). This works for header-based HTTPS APIs.
- **`direct`** — the raw value is placed in the sandbox environment. This is the mode for keys the HTTPS broker cannot carry: URL-parameter keys, gRPC, websockets. Direct secrets carry no host/path/method scoping — nothing brokers a raw env value.

```python
from evolve import Evolve, ManagedSecretRef, managed_secrets

available = await managed_secrets().list()  # includes label + delivery

evolve = Evolve(
    managed_secrets=[
        ManagedSecretRef(name='GITHUB_TOKEN'),                          # 'default'-labeled row
        ManagedSecretRef(name='API_KEY', label='prod'),                 # a specific labeled row
        ManagedSecretRef(name='SLACK_BOT_TOKEN', as_name='SLACK_TOKEN'),  # renamed in the sandbox
    ],
)
```

An omitted `label` resolves by the server's one shared law (the same law hosted-evals job secrets use): the `default`-labeled row when one exists, the single row when exactly one exists, and a typed refusal naming every label when several match and none is `default` — never a guess.

Runtime behavior:

- Brokered secrets: the sandbox receives the requested env var names with opaque sandbox-scoped values; code and tools read them normally, and Evolve validates allowed host, path, method, and live sandbox binding before substituting the real value on egress. Request and response bodies are limited to 10 MiB each.
- Direct secrets: the sandbox receives the raw value as a plain env var. When every attached secret is direct, the in-sandbox egress proxy is not started at all.
- `secrets` is still for local raw env injection; `managed_secrets` is for Dashboard-stored values.

### Storing secrets programmatically

`managed_secrets()` also writes: `set()` creates an env secret (or updates one — see the collision rule), and `delete()` removes one. The value travels in the HTTPS request body and is sealed server-side with the platform vault cipher; no read ever returns it. Values are limited to 190 bytes.

```python
import os
from evolve import managed_secrets

secrets = managed_secrets()

await secrets.set(
    name='GITHUB_TOKEN',
    value=os.environ['GITHUB_TOKEN'],
    delivery='brokered',
    allowed_hosts=['api.github.com'],
    allowed_path_prefixes=['/'],
    allowed_methods=['GET'],
)

await secrets.set(
    name='STRIPE_KEY',
    label='staging',
    value=os.environ['STRIPE_TEST_KEY'],
    delivery='direct',              # direct secrets carry no scoping
)

await secrets.delete(name='STRIPE_KEY', label='staging')
```

Or from the terminal — the value comes from `--value` or piped stdin (piping keeps it out of shell history):

```bash
printf %s "$GITHUB_TOKEN" | evolve secrets set GITHUB_TOKEN \
    --delivery brokered \
    --allowed-host api.github.com --allowed-path-prefix / --allowed-method GET

evolve secrets list
evolve secrets delete GITHUB_TOKEN
```

The write rules, all typed and machine-readable (the HTTP error body carries a `code`):

- `delivery` is required. `brokered` requires at least one allowed host, path prefix, and method; `direct` refuses scoping fields — an unscoped value in the sandbox environment cannot honor them.
- An existing `(name, label)` is **never overwritten with a different value**: the request is refused (`secret_exists`, HTTP 409). Rotate by `delete` + `set`, or store the new value under another label. Restating the **same value byte-for-byte** succeeds as an update — that is where the delivery mode and scoping are editable, and every runtime grant already minted against the row is revoked.
- `delete` with a bare name resolves the label like everything else (the `default` row, else the single row, else a typed ambiguity refusal naming every label).
- A **read-only API key** can `list` but not `set`/`delete` (`read_only_key`, HTTP 403).
- **LLM provider keys (BYOK) cannot be stored through this door.** A provider key gates billing — the routing preference behind it decides whose account pays for model traffic — so provider keys are managed only in the signed-in Dashboard **Secrets** page.

---

## Managed Integrations

Managed integrations are available only in gateway mode (`EVOLVE_API_KEY`); integration credentials stay server-side and agents receive an Evolve-scoped MCP proxy.

Available apps:

| `apps` value | App | What agents can do |
| --- | --- | --- |
| `gmail` | Gmail | Read, search, draft, and send email. |
| `agent_mail` | Agent Mail | Use an agent inbox to send, receive, and act on email. |
| `slack` | Slack | Search channels, read conversations, and send team messages. |
| `github` | GitHub | Work with repositories, issues, pull requests, and code. |
| `googlecalendar` | Google Calendar | Read and manage calendar events. |
| `notion` | Notion | Read and update pages, databases, docs, and workspace content. |
| `linear` | Linear | Read and manage issues, teams, projects, and comments. |

```bash
# .env
EVOLVE_API_KEY=sk-...
```

```python
from evolve import Evolve, IntegrationsSetup

evolve = Evolve(
    integrations=IntegrationsSetup(
        user_id='root',
        apps=['github', 'gmail'],
    ),
)

await evolve.run(prompt='Create a GitHub issue for the login bug')
```

### Root vs SDK Users

Use `user_id='root'` for accounts connected in the Evolve dashboard for private agents and test accounts.

For an application with end users, pass your stable SDK user ID. Evolve namespaces that ID under the authenticated Evolve account before creating private integration sessions.

```python
from evolve import Evolve, IntegrationsSetup

link = await Evolve.integrations.auth(
    user_id='customer_123',
    app='gmail',
    account_label='work',
)

evolve = Evolve(
    integrations=IntegrationsSetup(
        user_id='customer_123',
        apps=['gmail'],
    ),
)
```

### Account Helpers

```python
accounts = await Evolve.integrations.accounts.list(
    user_ids=['customer_123'],
    app='gmail',
    statuses=['ACTIVE'],
)

await Evolve.integrations.accounts.update(
    account_id='account_id_from_list',
    account_label='work',
)

# If the user connected multiple Gmail accounts, choose an account label or account ID returned by accounts.list().
evolve = Evolve(
    integrations=IntegrationsSetup(
        user_id='customer_123',
        apps=['gmail'],
        accounts={'gmail': ['work']},
    ),
)

# Disconnect by account ID.
await Evolve.integrations.accounts.delete(account_id='account_id_from_list')
```

### Custom Auth Configs and API Keys

Use `auth_configs` to select a custom auth config for an app. For apps with an API-key auth config, pass the matching key in `keys`; Evolve creates the connected account server-side and does not store the raw key in the session.

```python
evolve = Evolve(
    integrations=IntegrationsSetup(
        user_id='customer_123',
        apps=['github'],
        auth_configs={'github': 'ac_custom_github'},
        keys={'github': os.environ['GITHUB_TOKEN']},
    ),
)
```

### Type Reference

```python
@dataclass
class IntegrationsSetup:
    user_id: str  # "root" or your stable SDK user ID
    apps: List[str]
    accounts: Optional[Dict[str, List[str]]] = None  # app -> account labels or account IDs
    auth_configs: Optional[Dict[str, str]] = None  # app -> custom auth config ID
    keys: Optional[Dict[str, str]] = None          # app -> API key, requires auth_configs[app]
```

---
