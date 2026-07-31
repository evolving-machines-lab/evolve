# Evolve TypeScript SDK

Run CLI agents in secure sandboxes with built-in observability.

```bash
npm install @evolvingmachines/sdk
```

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve();
await evolve.run({ prompt: "Hello world" });
```

---

## Reference

### Getting Started

| Topic | Link |
|-------|------|
| Installation (Node.js 18+, npm) | [Getting Started → Installation](./01-getting-started.md#installation) |
| Quick Start (3 steps) | [Getting Started → Quick Start](./01-getting-started.md#quick-start) |
| Core Lifecycle (run → getOutputFiles → kill) | [Getting Started → Core Lifecycle](./01-getting-started.md#core-lifecycle) |
| Streaming basics | [Getting Started → Streaming](./01-getting-started.md#streaming) |
| Gateway, managed BYO provider keys, and direct keys | [Getting Started → Authentication](./01-getting-started.md#authentication) |
| Gateway mode (EVOLVE_API_KEY) | [Getting Started → Gateway Mode](./01-getting-started.md#gateway-mode-evolve_api_key) |
| Managed BYO provider keys | [Getting Started → Managed BYO Provider Keys](./01-getting-started.md#managed-byo-provider-keys) |
| Managed secrets | [Configuration → Managed Secrets](./02-configuration.md#managed-secrets) |
| Direct provider key mode (local BYOK) | [Getting Started → Direct Provider Key Mode](./01-getting-started.md#direct-provider-key-mode-local-byok) |
| BYO Claude Max / Codex / Gemini subscription | [Getting Started → BYO Claude Max Subscription](./01-getting-started.md#byo-claude-max-subscription) |
| Supported agents & models | [Getting Started → Agent Reference](./01-getting-started.md#agent-reference) |
| Agent-specific options (reasoningEffort) | [Getting Started → Agent Reference](./01-getting-started.md#agent-reference) |

### Configuration

| Topic | Link |
|-------|------|
| Sandbox providers (E2B, Modal, Daytona) | [Configuration → Sandbox Providers](./02-configuration.md#sandbox-providers) |
| Provider auto-resolution from env | [Configuration → Sandbox Providers](./02-configuration.md#auto-resolution) |
| `.withSandboxCreateOptions()` (image, network, user, homeDir) | [Configuration → Sandbox Create Options](./02-configuration.md#sandbox-create-options) |
| `.withWorkspaceMode()` (knowledge / swe) | [Configuration → Workspace Modes](./02-configuration.md#workspace-modes) |
| Evolve instance (full `.with*()` API) | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `.withAgent()` | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `.withSandbox()` | [Configuration → Sandbox Providers](./02-configuration.md#sandbox-providers) |
| `.withContext()` / `.withFiles()` | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `.withSystemPrompt()` | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `.withSchema()` (Zod / JSON Schema) | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `.withBrowser()` browser guide | [Configuration → Browser Automation](./02-configuration.md#browser-automation) |
| `.withBrowserCredentials()` browser logins | [Configuration → Browser Credentials](./02-configuration.md#browser-credentials) |
| `.withPlugins()` | [Configuration → Agent Plugins](./02-configuration.md#agent-plugins) |
| `.withSkills()` | [Configuration → Agent Skills](./02-configuration.md#agent-skills) |
| `.withIntegrations()` (managed app integrations) | [Configuration → Managed Integrations](./02-configuration.md#managed-integrations) |
| `.withManagedSecrets()` | [Configuration → Managed Secrets](./02-configuration.md#managed-secrets) |
| `.withMcpServers()` (STDIO / HTTP / SSE) | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `.withSecrets()` | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `.withStorage()` (checkpointing) | [Runtime → Storage & Checkpointing](./03-runtime.md#storage--checkpointing) |
| `.withSessionTagPrefix()` (observability) | [Runtime → Observability](./03-runtime.md#observability) |
| Skills catalog (PDF, browser, research, etc.) | [Configuration → Agent Skills](./02-configuration.md#agent-skills) |
| Integration auth/account helpers | [Configuration → Managed Integrations](./02-configuration.md#managed-integrations) |
| Integration tool filtering | [Configuration → Managed Integrations](./02-configuration.md#managed-integrations) |
| MCP server config (McpServerConfig) | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |

### Runtime

| Topic | Link |
|-------|------|
| `run()` | [Runtime → run](./03-runtime.md#run) |
| `executeCommand()` | [Runtime → executeCommand](./03-runtime.md#executecommand) |
| Streaming events (content, lifecycle, stdout, stderr) | [Streaming Events](./04-streaming.md) |
| OutputEvent / SessionUpdate types | [Streaming → SessionUpdate Types](./04-streaming.md#sessionupdate-types) |
| LifecycleEvent / LifecycleReason | [Streaming → LifecycleEvent](./04-streaming.md#lifecycleevent) |
| Tool events (ToolCall, ToolCallUpdate, ToolKind) | [Streaming → Tool Events](./04-streaming.md#tool-events) |
| Browser lifecycle event fields | [Streaming → Browser Automation Streaming](./04-streaming.md#browser-automation-streaming) |
| UI integration example | [Streaming → UI Integration Example](./04-streaming.md#ui-integration-example) |
| Upload files (`uploadContext()`, `uploadFiles()`) | [Runtime → Upload](./03-runtime.md#upload-local--sandbox) |
| Download files (`getOutputFiles()`, `saveLocalDir()`) | [Runtime → Download](./03-runtime.md#download-sandbox--local) |
| Session controls (interrupt, pause, resume, kill) | [Runtime → Session Controls](./03-runtime.md#session-controls) |
| `getHost()` (port forwarding) | [Runtime → getHost](./03-runtime.md#gethost) |
| Workspace filesystem layout | [Runtime → Workspace & Structured Output](./03-runtime.md#workspace--structured-output) |
| Structured output (Zod / JSON Schema) | [Runtime → Workspace & Structured Output](./03-runtime.md#structured-output) |
| Multi-turn conversations | [Runtime → Session Management](./03-runtime.md#session-management) |
| Pause / resume | [Runtime → Session Management](./03-runtime.md#session-management) |
| Save and reconnect (`withSession`, `setSession`) | [Runtime → Session Management](./03-runtime.md#session-management) |
| Storage & checkpointing (gateway) | [Runtime → Storage & Checkpointing](./03-runtime.md#storage--checkpointing) |
| Auto-checkpoint, explicit checkpoint, restore | [Runtime → Storage & Checkpointing](./03-runtime.md#auto-checkpoint-via-run) |
| Checkpoint lineage | [Runtime → Checkpoint Lineage](./03-runtime.md#checkpoint-lineage) |
| `storage()` client, `evolve.storage()` | [Runtime → Listing & Browsing Checkpoints](./03-runtime.md#listing--browsing-checkpoints) |
| `sessions()` client for past sessions & traces | [Runtime → Historical Sessions & Trace Download](./03-runtime.md#historical-sessions--trace-download) |
| Observability (dashboard + local logs) | [Runtime → Observability](./03-runtime.md#observability) |
| Error handling | [Runtime → Error Handling](./03-runtime.md#error-handling) |

### Hosted Evals

| Topic | Link |
|-------|------|
| The four nouns; `datasets()` / `agents()` / `jobs()` / `trials()` / `auth()`; `hosted()` | [Hosted Evals](./06-hosted-evals.md) |
| Start a job (`start()`, datasets as a list, selectors, idempotency) | [Hosted Evals → Start a Job](./06-hosted-evals.md#start-a-job) |
| Spend model (`max_trial_spend_usd`, `worst_case_spend_usd`, credits, BYOK) | [Hosted Evals → Money](./06-hosted-evals.md#money) |
| Agent arms (version pins, `reasoning_effort` as arm identity) | [Hosted Evals → Agent Arms](./06-hosted-evals.md#agent-arms) |
| `watch()` (SSE stream with resume, `JobEvent` union) | [Hosted Evals → Watch It Live](./06-hosted-evals.md#watch-it-live) |
| Live cost + live tokens (`live_spent_usd`, the 5s/30s cadences) | [Hosted Evals → Live Cost and Live Tokens](./06-hosted-evals.md#live-cost-and-live-tokens) |
| Results (`get`, `list({ search })`, `trials`, `tasks` rollup, trace) | [Hosted Evals → Read the Results](./06-hosted-evals.md#read-the-results) |
| Token counts + timing pairs on trials | [Hosted Evals → One Trial in Depth](./06-hosted-evals.md#one-trial-in-depth) |
| Trial artifacts (the six-name vocabulary, `artifact()`) | [Hosted Evals → Trial Artifacts](./06-hosted-evals.md#trial-artifacts--the-raw-record) |
| Stop verbs (`cancel()`, `trials().stop()`, `job stop --dataset`) | [Hosted Evals → Stopping Work](./06-hosted-evals.md#stopping-work) |
| `resume()` (new linked job over failed trials) | [Hosted Evals → Resume](./06-hosted-evals.md#resume) |
| Regrade (`regrade()` — the response IS a job) | [Hosted Evals → Regrade](./06-hosted-evals.md#regrade) |
| `compare()` (aggregates + task matrix) | [Hosted Evals → Compare](./06-hosted-evals.md#compare) |
| `download()` (the results archive) | [Hosted Evals → Download the Archive](./06-hosted-evals.md#download-the-archive) |
| `evolve-evals` CLI (noun-verb grammar, short flags, `-c` config) | [Hosted Evals → CLI](./06-hosted-evals.md#cli) |
| Auth (`auth status` today; `auth login` with its release) | [Hosted Evals → Signing In](./06-hosted-evals.md#signing-in) |
| `meta()` / `GET /api/meta` — the public capability document | [Hosted Evals → What the Platform Supports](./06-hosted-evals.md#what-the-platform-supports) |
| Errors (`code`, `param`, `details`, `retryAfterSec`, `requestId`) | [Hosted Evals → Errors](./06-hosted-evals.md#errors) |
| Task format & declarations (network, verifier, sizing) | [Hosted Evals → What Runs](./06-hosted-evals.md#what-runs) |
| Sandbox providers (`sandbox_provider`, per-task verdicts) | [Hosted Evals → Where It Runs](./06-hosted-evals.md#where-it-runs) |
| Bring your own dataset (publish → gate → `READY` → activate) | [Hosted Evals → Bring Your Own Dataset](./06-hosted-evals.md#bring-your-own-dataset) |
| `listImports()` (find an import you lost the id for) | [Hosted Evals → Publishing](./06-hosted-evals.md#publishing) |
| `datasets().delete()` (reclaim a name) | [Hosted Evals → Deleting One](./06-hosted-evals.md#deleting-one) |
| Upstream version awareness (`upstream`, `moved`, `auto_import`) | [Hosted Evals → When Upstream Moves](./06-hosted-evals.md#when-upstream-moves) |
| Bring your own agent (`agents()`, `upsert()`, run contract) | [Hosted Evals → Bring Your Own Agent](./06-hosted-evals.md#bring-your-own-agent) |
| Statuses (job, trial, import, dataset version) | [Hosted Evals → Statuses](./06-hosted-evals.md#statuses) |
| Types | [Hosted Evals → Types](./06-hosted-evals.md#types) |
| Error codes (the full vocabulary) | [Hosted Evals → Error Codes](./06-hosted-evals.md#error-codes) |

### Swarm & Pipeline

| Topic | Link |
|-------|------|
| Swarm setup (SwarmConfig) | [Swarm & Pipeline](./05-swarm-pipeline.md) |
| Input types (FileMap, folders, chaining) | [Swarm → Input Types](./05-swarm-pipeline.md#input-types) |
| `bestOf()` (N candidates + judge) | [Swarm → bestOf](./05-swarm-pipeline.md#bestof) |
| `map()` (parallel processing) | [Swarm → map](./05-swarm-pipeline.md#map) |
| `map()` + bestOf | [Swarm → map + bestOf](./05-swarm-pipeline.md#map--bestof) |
| `filter()` (evaluate + threshold) | [Swarm → filter](./05-swarm-pipeline.md#filter) |
| `reduce()` (synthesize many → one) | [Swarm → reduce](./05-swarm-pipeline.md#reduce) |
| `verify` (quality gate with feedback loop) | [Swarm → verify](./05-swarm-pipeline.md#verify-quality-gate) |
| Result types (SwarmResult, ReduceResult, BestOfResult) | [Swarm → Result Types](./05-swarm-pipeline.md#result-types) |
| Chaining operations (result.json → data.json) | [Swarm → Chaining Operations](./05-swarm-pipeline.md#chaining-operations) |
| AgentOverride (per-operation agent config) | [Swarm → AgentOverride](./05-swarm-pipeline.md#agentoverride) |
| Concurrency (semaphore, ordering guarantees) | [Swarm → Concurrency](./05-swarm-pipeline.md#concurrency) |
| RetryConfig (exponential backoff) | [Swarm & Pipeline](./05-swarm-pipeline.md) |
| Pipeline (fluent chaining) | [Swarm → Pipeline](./05-swarm-pipeline.md#pipeline) |
| Pipeline step configs (map, filter, reduce) | [Swarm → Step Configurations](./05-swarm-pipeline.md#step-configurations) |
| Pipeline events (stepStart, stepComplete, etc.) | [Swarm → Events](./05-swarm-pipeline.md#events) |
| Pipeline result (PipelineResult) | [Swarm → Result](./05-swarm-pipeline.md#result) |
| TerminalPipeline (reduce is terminal) | [Swarm → Terminal Pipeline](./05-swarm-pipeline.md#terminal-pipeline) |
| Filter `emit` option (success / filtered / all) | [Swarm → Pipeline](./05-swarm-pipeline.md#step-configurations) |
