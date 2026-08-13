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

Set env vars and the SDK auto-resolves the provider—no `.withSandbox()` needed:

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

```ts
import { Evolve } from "@evolvingmachines/sdk";

// No .withSandbox() needed — SDK picks the right provider from env
const evolve = new Evolve()
    .withAgent({ type: "claude" });

await evolve.run({ prompt: "Hello" });
```

Only use explicit provider creation (below) if you need custom settings like timeout or app name.

---

### Managed Sandboxes

With `EVOLVE_API_KEY` and no provider key, the platform runs the sandbox for you: Evolve
authenticates your key, creates the box on its own account, and records who owns it. You never
hold an E2B, Daytona, or Modal credential, and you are never billed by them directly.

That is already what auto-resolution does when only `EVOLVE_API_KEY` is set — it gives you a
managed **E2B** sandbox. To run on a different provider, say which one:

```ts
import { Evolve, managedSandbox } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withAgent({ type: "claude" })
    .withSandbox(await managedSandbox("daytona"));

await evolve.run({ prompt: "Hello" });
```

`managedSandbox()` with no argument is managed E2B — the same sandbox auto-resolution gives you.
The provider is an argument rather than an environment variable on purpose: which provider your
program runs on is part of the program.

The second argument is an options bag: the Evolve key (when it should not come from
`EVOLVE_API_KEY`) plus sandbox-shape defaults applied to every sandbox the provider creates.
Per-run options from `.withSandboxCreateOptions()` still win, and every default rides the same
validated path as a create-time option — a provider or managed door that cannot enforce a value
refuses it loudly, never silently ignores it:

```ts
const provider = await managedSandbox("daytona", {
    apiKey: "sk-...",              // (optional) Default: EVOLVE_API_KEY
    timeoutMs: 7_200_000,          // (optional) Lifetime cap for every create
    resources: { cpu: 2 },         // (optional) Sizing; refused where not enforceable
});
```

Managed Daytona carries both of Daytona's planes through the Dashboard — creating and listing
sandboxes, and every command and file operation the agent performs, including streamed command
output. Images come from the snapshots the platform publishes: a managed create names one and
never builds one, so a `resources` request that an existing snapshot cannot honor is refused
rather than silently ignored.

Managed Modal — `managedSandbox("modal")` — runs commands and file operations through the
Dashboard's Modal door. Command output streams live, chunk by chunk, and each command's
duration is bounded by the door: 60 minutes by default, 120 minutes at most — a longer
`timeoutMs` is refused with an error naming the bound, never silently shortened. Two Modal
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

```ts
import { Evolve, createE2BProvider } from "@evolvingmachines/sdk";

const sandbox = createE2BProvider({
    apiKey: process.env.E2B_API_KEY,    // (optional) Auto-resolves from env
    defaultTimeoutMs: 3600000,           // (optional) Default: 3600000 (1 hour)
    templateId: "my-custom-template",    // (optional) E2B template ID. Default: "evolve-all"
});
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

```ts
import { Evolve, createModalProvider } from "@evolvingmachines/sdk";

const sandbox = createModalProvider({
    tokenId: process.env.MODAL_TOKEN_ID,       // (optional) Auto-resolves from env
    tokenSecret: process.env.MODAL_TOKEN_SECRET, // (optional) Auto-resolves from env
    appName: "my-app",                   // (optional) Default: "evolve-sandbox"
    defaultTimeoutMs: 3600000,           // (optional) Default: 3600000 (1 hour)
    endpoint: "https://api.modal.com:443", // (optional) Default: https://api.modal.com:443
    imageName: "evolve-all",             // (optional) Default: "evolve-all"
});
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

```ts
import { Evolve, createDaytonaProvider } from "@evolvingmachines/sdk";

const sandbox = createDaytonaProvider({
    apiKey: process.env.DAYTONA_API_KEY,  // (optional) Auto-resolves from env
    apiUrl: "https://app.daytona.io/api", // (optional) Default: https://app.daytona.io/api
    target: "us",                          // (optional) Target region. Default: "us"
    defaultTimeoutMs: 3600000,             // (optional) Default: 3600000 (1 hour) - converted to minutes for auto-stop
    snapshotName: "my-snapshot",           // (optional) Default: the current release snapshot ("evolve-all-c-<12hex>", tag derived from the image build inputs); explicit names pass through untouched. Custom snapshots via build.sh daytona
});
```

---

## Sandbox Create Options

`.withSandboxCreateOptions()` sets provider-neutral options used whenever Evolve creates a fresh sandbox — image, env vars, metadata, timeout, working directory, outbound network policy, and the user/home the agent runs as:

```ts
const evolve = new Evolve()
    .withSandboxCreateOptions({
        image: "my-eval-template",          // (optional) Sandbox image/template ID (provider default if omitted)
        envs: { TASK_ID: "swe-042" },       // (optional) Extra env vars (Evolve-owned runtime vars win on conflict)
        metadata: { suite: "nightly" },     // (optional) Provider metadata
        timeoutMs: 3_600_000,               // (optional) Sandbox timeout
        workingDirectory: "/repo",          // (optional) Working directory for agent commands
        network: {                          // (optional) Outbound network policy applied at boot
            outbound: "blocked",            // "open" | "blocked"
            allowedDestinations: ["registry.npmjs.org", "10.0.0.0/8"],
        },
        user: "root",                       // (optional) Run all commands and file ops as this user
        homeDir: "/root",                   // (optional) Home dir for agent config paths
    });
```

**Network policy.** `outbound: "blocked"` denies all outbound traffic except `allowedDestinations` (hostnames, IPs, or CIDR ranges). Providers that cannot enforce a requested policy reject it with an error — a policy is never silently ignored.

**User and home directory.** `user` runs every command and file operation as that user; providers that cannot enforce it reject it (E2B supports run-as-root). `homeDir` controls where agent config files (settings, session state, skills) are written. Defaults: `/root` when `user` is `"root"`, `/home/<user>` for other users, `/home/user` when no user is given. The default working directory follows as `<homeDir>/workspace`.

Constraints:

- A `user` can only be enforced at sandbox creation — combining it with `.withSession()`/`setSession()` (an existing sandbox) throws.
- Checkpoint storage (`.withStorage()`) and managed browser features require the default `/home/user` home; combining them with a custom `user`/`homeDir` throws.
- `envs` entries are validated like `.withSecrets()` values — Evolve-reserved variable names are rejected.

---

## Workspace Modes

`.withWorkspaceMode()` controls what Evolve sets up in the working directory on first run:

| Mode | Workspace setup | Use it for |
|------|-----------------|------------|
| `"knowledge"` (default) | Creates `context/`, `scripts/`, `temp/`, `output/` + writes the system prompt file | General agent work with structured deliverables |
| `"swe"` | Same as knowledge + `repo/` for code repositories | Software-engineering tasks on cloned repos |

```ts
const evolve = new Evolve()
    .withWorkspaceMode("swe")
    .withSandboxCreateOptions({ image: "my-ci-template" });
```

---

## Evolve Instance

```ts
const evolve = new Evolve()

    // Agent configuration (optional if EVOLVE_API_KEY set, defaults to claude)
    .withAgent({
        type: "codex",                        // "claude" | "codex" | "gemini" | "qwen" | "kimi" | "opencode" | "droid" - defaults to "claude"
        model: "gpt-5.3-codex",               // (optional) Uses default if omitted. Use "fable" for Claude Fable 5 or "sonnet[1m]" / "opus[1m]" for 1M context (Claude only)
        reasoningEffort: "medium",            // (optional) Native reasoning/thinking control; valid values vary by agent/model. Omitted = Evolve stamps its pinned per-harness default (see Getting Started → Agent Reference)
        // maxContextSize: 128000,            // (optional) Context/completion ceiling for CLIs that must be told one (see Getting Started → Harness and Model Pairing)
        apiKey: process.env.EVOLVE_API_KEY!, // (optional) Gateway mode - auto-resolves from env
        // providerApiKey: process.env.ANTHROPIC_API_KEY!, // (optional) Direct Provider Key Mode
        // oauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN!, // (optional) Claude Max subscription
    })

    // Sandbox provider (see 2.1 above, or auto-resolves from env)
    .withSandbox(sandbox)

    // (optional) Workspace mode: "knowledge" (default) | "swe" (see Workspace Modes above)
    .withWorkspaceMode("knowledge")

    // (optional) Uploads to /home/user/workspace/context/ on first run
    .withContext({
        "docs/readme.txt": "User provided context...",
        "data.json": JSON.stringify({ key: "value" }),
    })

    // (optional) System prompt appended to default instructions
    .withSystemPrompt("You are a careful pair programmer.")

    // (optional) Schema for structured output (agent writes result.json, validated on getOutputFiles())
    // Accepts Zod schemas or JSON Schema objects
    .withSchema(z.object({
        summary: z.string(),
        score: z.number(),
    }))

    // Or with JSON Schema:
    // .withSchema({
    //     type: "object",
    //     properties: {
    //         summary: { type: "string" },
    //         score: { type: "number" },
    //     },
    //     required: ["summary", "score"],
    // })

    // (optional) Gateway browser automation (.withBrowser() defaults to remote managed agent-browser)
    .withBrowser()

    // (optional) Install plugins/extensions for the selected agent before first run
    .withPlugins({
        marketplace: "https://github.com/org/codex-plugins.git",
        sparse: [".agents/plugins"],
    })

    // (optional) Skills for the agent — skills.sh / git / local references
    .withSkills(["anthropics/skills", "./my-skill"])

    // (optional) Managed integrations (gateway mode only)
    .withIntegrations({
        userId: "root",
        apps: ["github", "gmail"],
    })

    // (optional) Dashboard-stored managed secrets (gateway mode only)
    .withManagedSecrets([
        { name: "GITHUB_TOKEN" },
        { name: "SLACK_BOT_TOKEN", as: "SLACK_TOKEN" },
    ])

    // (optional) Prefix for observability logs
    .withSessionTagPrefix("my-agent")

    // (optional) Storage for checkpoint persistence (gateway feature — requires EVOLVE_API_KEY)
    .withStorage()

    // ─── Advanced ───────────────────────────────────────────────────────────────

    // (optional) Provider-neutral options for fresh sandbox creation (see Sandbox Create Options above)
    .withSandboxCreateOptions({
        image: "my-task-image",
        network: { outbound: "blocked", allowedDestinations: ["pypi.org"] },
        user: "root",
    })

    // (optional) MCP servers for agent tools
    .withMcpServers({
        exa: {
            command: "npx",
            args: ["-y", "exa-mcp-server"],
            env: { EXA_API_KEY: "..." },
        },
        api: {
            type: "http",
            url: "https://example.com/mcp",
            headers: { "x-api-key": "..." },
        },
    })

    // (optional) Environment variables injected into sandbox
    .withSecrets({
        GITHUB_TOKEN: process.env.GITHUB_TOKEN!
    })

    // (optional) Uploads to /home/user/workspace/ on first run
    .withFiles({
        "scripts/setup.sh": "#!/bin/bash\necho hello",
    });
```

**Note:**
- Configuration methods can be chained in any order.
- The sandbox is created on the first `run()` or `executeCommand()` call (see below).
- Context files, workspace files, MCP servers, and system prompt are set up once on the first call.
- Using `.withSession()` to reconnect skips setup since the sandbox already exists.
- `withSchema()` accepts both Zod schemas and JSON Schema objects.

**McpServerConfig** — MCP server connection (STDIO or HTTP/SSE):

| Fields | Transport |
|--------|-----------|
| `command` | stdio (local subprocess) |
| `url` + `type: "http"` | HTTP (remote) |
| `url` (no type) | SSE (remote, default) |

```ts
interface McpServerConfig {
    type?: "stdio" | "http" | "sse";
    command?: string;  args?: string[];  cwd?: string;   // STDIO
    url?: string;  headers?: Record<string, string>;     // HTTP/SSE
    env?: Record<string, string>;                        // Common
}
```

## Browser Automation

Browser automation is opt-in. Use `.withBrowser()` for browser, QA, dogfooding, and website automation tasks.

```ts
new Evolve().withBrowser(); // managed browser with dashboard live view and replay
```

Evolve automatically configures the browser runtime. In Gateway mode, the managed browser gives you:

- `event.browser.liveUrl` from the `browser_ready` lifecycle event
- `result.browser?.liveUrl` after `run()` returns
- `result.sessionId`, which is the id to use for traces and browser replay
- `sessions().browserReplay(sessionId)`, which returns replay and raw `.mp4` download URLs after cleanup
- `replay.suggestedStartSeconds`, when present, which is the recommended replay start time in seconds
- `replay.sizeBytes` and `replay.readyAt`, when present, which describe the raw recording size and replay readiness time

`remote` controls where the browser session runs:

- `.withBrowser()` uses `remote: true` by default. Evolve creates and manages a cloud browser session, wires it into the sandbox, and exposes dashboard live view plus replay.
- `remote: false` runs browser automation locally inside the sandbox. Use it only when you do not need managed live view or replay.

Use the default unless you have a reason not to:

```ts
new Evolve().withBrowser();
// recommended: managed remote browser

new Evolve().withBrowser({
    provider: "agent-browser",
    remote: false,
});
// local agent-browser, no managed live/replay
```

Use a browser profile to reuse logged-in browser state across managed browser sessions:

```ts
const evolve = new Evolve()
    .withBrowser({
        profile: "ramp-qa",
    });
```

Profiles are gateway-only and work only with managed remote browser sessions. Evolve stores and resolves profile state server-side; the SDK never receives raw browser state.

Profile lifecycle:

- First use: if the profile does not exist for the authenticated Evolve user, Dashboard creates an empty server-side browser profile and starts the managed browser with it.
- Reuse: if the profile already exists, Dashboard starts the browser with the existing state and updates `lastUsedAt`.
- Persist: browser state changes made during the session, such as successful logins, are saved when the managed browser is stopped. Call `kill()` when done so cleanup and replay processing run.
- Visibility: the profile appears in Dashboard **Secrets** under Browser Profiles and in `Evolve.browserProfiles().list()`. Only metadata is returned; cookies and storage stay server-side.

Recommended profile creation flow:

1. Add the browser login in Dashboard **Secrets**, or manage browser logins from the SDK and note the `accountLabel`.
2. Start a managed browser with both a `profile` and scoped browser credentials.
3. Ask the agent to sign in with the saved login.
4. Call `kill()` when done so the authenticated browser state is saved into the profile.

```ts
const evolve = new Evolve()
    .withBrowser({
        profile: "ramp-qa",
    })
    .withBrowserCredentials({
        allow: [{ website: "github.com", accountLabel: "qa-admin" }],
    });

try {
    await evolve.run({
        prompt: "Open GitHub, sign in with the saved qa-admin login, and confirm the account is authenticated.",
    });
} finally {
    await evolve.kill();
}
```

Future runs can reuse the saved state with `.withBrowser({ profile: "ramp-qa" })`; include `.withBrowserCredentials()` again only when the agent needs access to saved login tools.

List or delete profiles from the SDK:

```ts
const profiles = await Evolve.browserProfiles().list();

await Evolve.browserProfiles().delete({
    profile: "ramp-qa",
});
```

To disable browser automation, omit `.withBrowser()`.

Full browser run with live view and replay:

```ts
import { Evolve, sessions } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withBrowser()
    .withSessionTagPrefix("checkout-qa");

let sessionId: string | undefined;

evolve.on("lifecycle", (event) => {
    if (event.reason === "browser_ready" && event.browser) {
        showLiveBrowser(event.browser.liveUrl);
        sessionId = event.browser.sessionId;
    }
});

try {
    const result = await evolve.run({
        prompt: "Open the app, test the checkout flow, and report issues.",
    });

    sessionId = result.sessionId ?? sessionId;
    if (result.browser?.liveUrl) {
        showLiveBrowser(result.browser.liveUrl);
    }
} finally {
    await evolve.kill();
}

if (!sessionId) throw new Error("Missing dashboard session id");

const replay = await sessions().browserReplay(sessionId, {
    timeoutMs: 600_000,
    intervalMs: 5_000,
});

showReplay(replay.replayUrl);
saveDownloadLink(replay.downloadUrl);
setReplayStartTime(replay.suggestedStartSeconds ?? 0);
showReplayMetadata({
    sizeBytes: replay.sizeBytes,
    readyAt: replay.readyAt,
});
```

Replay processing starts when the managed browser is cleaned up, usually during `kill()`.
If replay is not ready before `timeoutMs`, call `browserReplay()` again later with the same `sessionId`.
The `replayUrl` already applies `suggestedStartSeconds`; use the field separately only if your UI needs to display or store the recommended start time.
The `status` is `"ready"` once `browserReplay()` returns.

## Browser Credentials

Browser credentials let managed remote `agent-browser` runs sign in with saved website logins without exposing passwords to the agent.

Availability:

- Requires Gateway mode and managed remote `agent-browser`.
- `.withBrowser()` uses that recommended remote setup by default.
- Not available with local browser mode, Direct Provider Key Mode, or `.withSession()`.

Dashboard setup:

1. Open the Evolve Dashboard.
2. Go to **Secrets**.
3. Add a browser login with `Account label`, `Website`, `Email`, and `Password`.
4. Use `Website` for the domain, such as `github.com`; use `Account label` as one word with no spaces, such as `qa-admin`, `work`, or `personal`, to distinguish multiple saved accounts for the same website. It is not the website username or email.

Passwords are encrypted client-side with RSA-OAEP-SHA256 against the dashboard's published public key before upload — the SDK verifies it is handed a genuine `rsaEncryption` key before encrypting, and a plaintext password never leaves the machine. The dashboard and SDK list only login metadata: account label, website, email, and last-used time.

Expose saved logins to a run:

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withBrowser()
    .withBrowserCredentials({
        allow: [{ website: "github.com", accountLabel: "qa-admin" }],
    });

await evolve.run({
    prompt: "Open GitHub, sign in with the saved qa-admin login, and verify the repository settings page.",
});

await evolve.kill();
```

If `allow` is omitted, all enabled browser logins for the Evolve account are available to that run:

```ts
const evolve = new Evolve()
    .withBrowser()
    .withBrowserCredentials();
```

The agent receives a run-scoped `browser-login` MCP server with these tools:

- `browser_list_logins` lists available website logins: website, account_label, and email only.
- `browser_login` fills the stored password and submits the current browser sign-in tab.
- `browser_complete_signup` generates a password, submits the current browser signup tab, and saves the new login.

Manage browser logins from the SDK:

```ts
import { Evolve } from "@evolvingmachines/sdk";

const credentials = Evolve.browserCredentials();

await credentials.create({
    website: "github.com",
    accountLabel: "qa-admin",
    email: "qualityassurance@example.com",
    password: process.env.QA_GITHUB_PASSWORD!,
});

const page = await credentials.list({ website: "github.com" });

await credentials.delete({
    website: "github.com",
    accountLabel: "qa-admin",
});
```

## Agent Plugins

`.withPlugins()` installs plugins/extensions into the sandbox user profile before the first agent command. The currently selected agent determines the accepted shape:

```ts
// droid
.withPlugins({
    marketplace: "https://github.com/Factory-AI/factory-plugins",
    plugin: "droid-control@factory-plugins",
})

// claude
.withPlugins({
    marketplace: "anthropics/claude-code",
    plugin: "commit-commands@anthropics-claude-code",
})

// gemini
.withPlugins({
    source: "https://github.com/org/gemini-extension",
    ref: "main",
})

// codex marketplace registration
.withPlugins({
    marketplace: "https://github.com/org/codex-plugins.git",
    sparse: [".agents/plugins"],
})
```

If `.withAgent()` is omitted, plugins target the default agent (`claude`).

## Agent Skills

Skills are folders of instructions and helper files — a `SKILL.md` manifest plus anything it needs — that the agent's harness discovers natively. `.withSkills()` takes real references; there is no built-in catalog:

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withSkills([
        "skills.sh/vercel-labs/agent-skills/frontend-design",     // one named skill from a skills.sh-listed repo
        "anthropics/skills",                                      // every skill a GitHub repo publishes
        "anthropics/skills@main",                                 // pinned to a branch, tag, or commit
        "https://github.com/org/repo/tree/main/skills/my-skill",  // any https git URL, down to a subfolder
        "./my-skill",                                             // a local folder containing SKILL.md
    ]);

await evolve.run({ prompt: "Create a slide deck summarizing the uploaded notes." });
```

Browse [skills.sh](https://skills.sh) for published skills. The SKILL.md format is the open standard described at [agentskills.io](https://agentskills.io/home).

How references resolve:

- Git references are pinned to their exact commit, fetched as a sparse checkout of only the skill content, and cached by commit under `~/.cache/evolve/skills` — the same reference always mounts the same bytes.
- A whole-repo reference discovers skills in the ecosystem's standard places: a `SKILL.md` at the repo root (one skill, named after the repo), `skills/`, `skills/.curated/`, `skills/.experimental/`, `skills/.system/`, and `.claude/skills/`.
- A local path, or an explicit `/tree/<ref>/<subdir>` URL, must be one skill folder containing `SKILL.md` — or a root whose immediate child directories each contain one. A child without `SKILL.md` is a loud refusal naming the child.
- Duplicate skill names resolve last-wins, and each skill mounts into the harness's native skills directory (for example `~/.claude/skills/<name>`), where the agent discovers it on its own.

After a run, `evolve.resolvedSkills()` reports exactly what mounted: each skill's name, source reference, exact git commit for git-backed skills, and content digest.

## Managed Secrets

Managed secrets are available only in gateway mode (`EVOLVE_API_KEY`). Save the secret in Dashboard **Secrets** with a unique **Name** plus allowed hosts, paths, and methods. The SDK can list available names and attach the selected secrets to a run; raw values stay server-side.

```ts
import { Evolve } from "@evolvingmachines/sdk";

const secrets = await Evolve.managedSecrets().list();

const evolve = new Evolve()
    .withManagedSecrets([
        { name: "GITHUB_TOKEN" },
        { name: "SLACK_BOT_TOKEN", as: "SLACK_TOKEN" },
    ]);
```

Runtime behavior:

- The sandbox receives the requested env var names with opaque sandbox-scoped values.
- Code and tools read those env vars normally; Evolve substitutes real values only for allowed HTTPS egress.
- Evolve validates allowed host, path, method, and live sandbox binding before injecting the real value.
- Managed-secret egress is for API calls; request and response bodies are limited to 10 MiB each.
- `.withSecrets()` is still for local raw env injection; `.withManagedSecrets()` is for Dashboard-stored values.

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

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withIntegrations({
        userId: "customer_123",
        apps: ["github", "gmail"],
    });

await evolve.run({ prompt: "Create a GitHub issue for the login bug" });
```

### Root vs SDK Users

Use `userId: "root"` for accounts connected in the Evolve dashboard for private agents and test accounts.

For an application with end users, pass your stable SDK user ID. Evolve namespaces that ID under the authenticated Evolve account before creating private integration sessions.

```ts
const link = await Evolve.integrations.auth({
    userId: "customer_123",
    app: "gmail",
    accountLabel: "work",
});

// Show link.url to the user.
const evolve = new Evolve()
    .withIntegrations({
        userId: "customer_123",
        apps: ["gmail"],
    });
```

### Account Helpers

```ts
const accounts = await Evolve.integrations.accounts.list({
    userIds: ["customer_123"],
    app: "gmail",
    statuses: ["ACTIVE"],
});

await Evolve.integrations.accounts.update({
    accountId: "account_id_from_list",
    accountLabel: "work",
});

// If the user connected multiple Gmail accounts, choose an account label or account ID returned by accounts.list().
const evolve = new Evolve()
    .withIntegrations({
        userId: "customer_123",
        apps: ["gmail"],
        accounts: { gmail: ["work"] },
    });

// Disconnect by account ID.
await Evolve.integrations.accounts.delete({ accountId: "account_id_from_list" });
```

### Custom Auth Configs and API Keys

Use `authConfigs` to select a custom auth config for an app. For apps with an API-key auth config, pass the matching key in `keys`; Evolve creates the connected account server-side and does not store the raw key in the session.

```ts
const evolve = new Evolve()
    .withIntegrations({
        userId: "customer_123",
        apps: ["github"],
        authConfigs: { github: "ac_custom_github" },
        keys: { github: process.env.GITHUB_TOKEN! },
    });
```

### Type Reference

```ts
interface IntegrationsSetup {
    userId: string;            // "root" or your stable SDK user ID
    apps: string[];
    accounts?: Record<string, string[]>; // app -> account labels or account IDs
    authConfigs?: Record<string, string>; // app -> custom auth config ID
    keys?: Record<string, string>;        // app -> API key, requires authConfigs[app]
}
```

---
