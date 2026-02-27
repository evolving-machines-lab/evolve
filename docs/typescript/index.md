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
| Gateway vs BYOK mode | [Getting Started → Authentication](./01-getting-started.md#authentication) |
| Gateway mode (EVOLVE_API_KEY) | [Getting Started → Gateway Mode](./01-getting-started.md#gateway-mode-evolve_api_key) |
| BYOK mode (your own keys) | [Getting Started → BYOK Mode](./01-getting-started.md#byok-mode) |
| BYO Claude Max / Codex / Gemini subscription | [Getting Started → BYOK Mode](./01-getting-started.md#byo-claude-max-subscription) |
| Supported agents & models | [Getting Started → Agent Reference](./01-getting-started.md#agent-reference) |
| Agent-specific options (reasoningEffort) | [Getting Started → Agent Reference](./01-getting-started.md#agent-reference) |

### Configuration

| Topic | Link |
|-------|------|
| Sandbox providers (E2B, Modal, Daytona) | [Configuration → Sandbox Providers](./02-configuration.md#sandbox-providers) |
| Provider auto-resolution from env | [Configuration → Sandbox Providers](./02-configuration.md#auto-resolution) |
| Evolve instance (full `.with*()` API) | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `.withAgent()` | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `.withSandbox()` | [Configuration → Sandbox Providers](./02-configuration.md#sandbox-providers) |
| `.withContext()` / `.withFiles()` | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `.withSystemPrompt()` | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `.withSchema()` (Zod / JSON Schema) | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `.withSkills()` | [Configuration → Agent Skills](./02-configuration.md#agent-skills) |
| `.withComposio()` (1000+ integrations) | [Configuration → Composio](./02-configuration.md#composio-tool-router) |
| `.withMcpServers()` (STDIO / HTTP / SSE) | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `.withSecrets()` | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `.withStorage()` (checkpointing) | [Runtime → Storage & Checkpointing](./03-runtime.md#storage--checkpointing) |
| `.withSessionTagPrefix()` (observability) | [Runtime → Observability](./03-runtime.md#observability) |
| Skills catalog (PDF, browser, research, etc.) | [Configuration → Agent Skills](./02-configuration.md#agent-skills) |
| Composio auth paths (OAuth, API key, white-label) | [Configuration → Authentication Paths](./02-configuration.md#authentication-paths) |
| Composio tool filtering | [Configuration → Tool Filtering](./02-configuration.md#tool-filtering) |
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
| Browser-use detection & URL extraction | [Streaming → BrowserUseResponse](./04-streaming.md#browseruseresponse) |
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
| Storage & checkpointing (BYOK / Gateway) | [Runtime → Storage & Checkpointing](./03-runtime.md#storage--checkpointing) |
| Auto-checkpoint, explicit checkpoint, restore | [Runtime → Storage & Checkpointing](./03-runtime.md#auto-checkpoint-via-run) |
| Checkpoint lineage | [Runtime → Checkpoint Lineage](./03-runtime.md#checkpoint-lineage) |
| `listCheckpoints()` | [Runtime → Listing Checkpoints](./03-runtime.md#listing-checkpoints) |
| Observability (dashboard + local logs) | [Runtime → Observability](./03-runtime.md#observability) |
| Error handling | [Runtime → Error Handling](./03-runtime.md#error-handling) |

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
