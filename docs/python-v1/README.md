# Evolve Python SDK

Run CLI agents in secure sandboxes with built-in observability.

```bash
pip install evolve-sdk
```

```python
from evolve import Evolve

evolve = Evolve()
await evolve.run(prompt='Hello world')
```

---

## Reference

### Getting Started

| Topic | Link |
|-------|------|
| Installation (Python 3.10+, Node.js 18+) | [Getting Started → Installation](./01-getting-started.md#installation) |
| Quick Start (3 steps) | [Getting Started → Quick Start](./01-getting-started.md#quick-start) |
| Gateway vs BYOK mode | [Getting Started → Authentication](./01-getting-started.md#authentication) |
| Gateway mode (EVOLVE_API_KEY) | [Getting Started → Gateway Mode](./01-getting-started.md#gateway-mode-evolve_api_key) |
| BYOK mode (your own keys) | [Getting Started → BYOK Mode](./01-getting-started.md#byok-mode) |
| BYO Claude Max / Codex / Gemini subscription | [Getting Started → BYOK Mode](./01-getting-started.md#byo-claude-max-subscription) |
| Supported agents & models | [Getting Started → Agent Reference](./01-getting-started.md#agent-reference) |
| Agent-specific options (reasoning_effort, betas) | [Getting Started → Agent Reference](./01-getting-started.md#agent-reference) |

### Configuration

| Topic | Link |
|-------|------|
| Sandbox providers (E2B, Modal, Daytona) | [Configuration → Sandbox Providers](./02-configuration.md#sandbox-providers) |
| Provider auto-resolution from env | [Configuration → Sandbox Providers](./02-configuration.md#auto-resolution) |
| Evolve instance (full constructor API) | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `AgentConfig` | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `sandbox=` provider | [Configuration → Sandbox Providers](./02-configuration.md#sandbox-providers) |
| `context=` / `files=` | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `system_prompt=` | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `schema=` (Pydantic / JSON Schema) | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `skills=` | [Configuration → Agent Skills](./02-configuration.md#agent-skills) |
| `composio=` (1000+ integrations) | [Configuration → Composio](./02-configuration.md#composio-tool-router) |
| `mcp_servers=` (STDIO / HTTP / SSE) | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `secrets=` | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |
| `storage=` (checkpointing) | [Runtime → Storage & Checkpointing](./03-runtime.md#storage--checkpointing) |
| `session_tag_prefix=` (observability) | [Runtime → Observability](./03-runtime.md#observability) |
| Skills catalog (PDF, browser, research, etc.) | [Configuration → Agent Skills](./02-configuration.md#agent-skills) |
| Composio auth paths (OAuth, API key, white-label) | [Configuration → Authentication Paths](./02-configuration.md#authentication-paths) |
| Composio tool filtering | [Configuration → Tool Filtering](./02-configuration.md#tool-filtering) |
| MCP server config (McpServerConfig) | [Configuration → Evolve Instance](./02-configuration.md#evolve-instance) |

### Runtime

| Topic | Link |
|-------|------|
| `run()` | [Runtime → run](./03-runtime.md#run) |
| `execute_command()` | [Runtime → execute_command](./03-runtime.md#execute_command) |
| Streaming events (content, lifecycle, stdout, stderr) | [Runtime → Streaming Events](./03-runtime.md#streaming-events) |
| OutputEvent / SessionUpdate types | [Runtime → Type Definitions](./03-runtime.md#type-definitions) |
| LifecycleEvent / LifecycleReason | [Runtime → Streaming Events](./03-runtime.md#lifecycleevent-typeddict-shape) |
| Tool events (ToolCall, ToolCallUpdate, ToolKind) | [Runtime → Type Definitions](./03-runtime.md#tool-types) |
| Browser-use detection & URL extraction | [Runtime → BrowserUseResponse Extraction](./03-runtime.md#browseruseresponse-extraction) |
| UI integration example | [Runtime → UI Integration Example](./03-runtime.md#ui-integration-example) |
| Upload files (`upload_context()`, `upload_files()`) | [Runtime → Upload](./03-runtime.md#upload-local--sandbox) |
| Download files (`get_output_files()`, `save_local_dir()`) | [Runtime → Download](./03-runtime.md#download-sandbox--local) |
| Session controls (interrupt, pause, resume, kill) | [Runtime → Session Controls](./03-runtime.md#session-controls) |
| `get_host()` (port forwarding) | [Runtime → get_host](./03-runtime.md#get_host) |
| Async context manager (`async with evolve:`) | [Runtime → Session Management](./03-runtime.md#session-management) |
| Workspace filesystem layout | [Runtime → Workspace & Structured Output](./03-runtime.md#workspace--structured-output) |
| Structured output (Pydantic / JSON Schema) | [Runtime → Workspace & Structured Output](./03-runtime.md#structured-output) |
| Multi-turn conversations | [Runtime → Session Management](./03-runtime.md#session-management) |
| Pause / resume | [Runtime → Session Management](./03-runtime.md#session-management) |
| Save and reconnect (`sandbox_id=`, `set_session()`) | [Runtime → Session Management](./03-runtime.md#session-management) |
| Storage & checkpointing (BYOK / Gateway) | [Runtime → Storage & Checkpointing](./03-runtime.md#storage--checkpointing) |
| Auto-checkpoint, explicit checkpoint, restore | [Runtime → Storage & Checkpointing](./03-runtime.md#auto-checkpoint-via-run) |
| Checkpoint lineage | [Runtime → Checkpoint Lineage](./03-runtime.md#checkpoint-lineage) |
| `list_checkpoints()` | [Runtime → Listing Checkpoints](./03-runtime.md#listing-checkpoints) |
| Observability (dashboard + local logs) | [Runtime → Observability](./03-runtime.md#observability) |
| Error handling | [Runtime → Error Handling](./03-runtime.md#error-handling) |

### Swarm & Pipeline

| Topic | Link |
|-------|------|
| Swarm setup (SwarmConfig) | [Swarm & Pipeline](./04-swarm-pipeline.md) |
| Input types (FileMap, folders, chaining) | [Swarm → Input Types](./04-swarm-pipeline.md#input-types) |
| `best_of()` (N candidates + judge) | [Swarm → best_of](./04-swarm-pipeline.md#best_of) |
| `map()` (parallel processing) | [Swarm → map](./04-swarm-pipeline.md#map) |
| `map()` + best_of | [Swarm → map + best_of](./04-swarm-pipeline.md#map--best_of) |
| `filter()` (evaluate + threshold) | [Swarm → filter](./04-swarm-pipeline.md#filter) |
| `reduce()` (synthesize many → one) | [Swarm → reduce](./04-swarm-pipeline.md#reduce) |
| `verify` (quality gate with feedback loop) | [Swarm → verify](./04-swarm-pipeline.md#verify-quality-gate) |
| Result types (SwarmResult, ReduceResult, BestOfResult) | [Swarm → Result Types](./04-swarm-pipeline.md#result-types) |
| Chaining operations (result.json → data.json) | [Swarm → Chaining Operations](./04-swarm-pipeline.md#chaining-operations) |
| AgentOverride (per-operation agent config) | [Swarm → AgentOverride](./04-swarm-pipeline.md#agentoverride) |
| Concurrency (semaphore, ordering guarantees) | [Swarm → Concurrency](./04-swarm-pipeline.md#concurrency) |
| RetryConfig (exponential backoff) | [Swarm & Pipeline](./04-swarm-pipeline.md) |
| Pipeline (fluent chaining) | [Swarm → Pipeline](./04-swarm-pipeline.md#pipeline) |
| Pipeline step configs (MapConfig, FilterConfig, ReduceConfig) | [Swarm → Step Configurations](./04-swarm-pipeline.md#step-configurations) |
| Pipeline events (step_start, step_complete, etc.) | [Swarm → Events](./04-swarm-pipeline.md#events) |
| Pipeline result (PipelineResult) | [Swarm → Result](./04-swarm-pipeline.md#result) |
| TerminalPipeline (reduce is terminal) | [Swarm → Terminal Pipeline](./04-swarm-pipeline.md#terminal-pipeline) |
| Filter `emit` option (success / filtered / all) | [Swarm → Pipeline](./04-swarm-pipeline.md#step-configurations) |
