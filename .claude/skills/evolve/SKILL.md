---
name: evolve
description: "Evolve SDK development for TypeScript and Python. Use when building applications with Evolve to run AI agents (Claude, Codex, Gemini, Qwen, Kimi, OpenCode) in secure sandboxes. Triggers: (1) Creating Evolve applications, (2) Configuring agents with skills, Composio, MCP servers, (3) Using Swarm abstractions (map, filter, reduce, bestOf/best_of, verify), (4) Building Pipelines, (5) Structured output with schemas, (6) Session management, streaming, observability, (7) Checkpointing and storage."
---

# Evolve SDK

Build applications that run CLI agents in secure cloud sandboxes.

**Repo:** https://github.com/evolving-machines-lab/evolve

## Language Detection

Determine the language from (in priority order):

1. **User specification** — if the user states a language, use it
2. **Project signals** — imports, file extensions, package.json vs pyproject.toml
3. **Ask** — if ambiguous, ask the user

- **TypeScript** (`@evolvingmachines/sdk`) — read from [references/typescript/](references/typescript/)
- **Python** (`evolve-sdk`) — read from [references/python/](references/python/)

## Required Reading

Always read these three references **for the detected language** before writing any Evolve code:

**TypeScript:**
- [01-getting-started.md](references/typescript/01-getting-started.md) — Installation, authentication (Gateway/BYOK), core lifecycle, streaming basics, agent reference table
- [02-configuration.md](references/typescript/02-configuration.md) — Sandbox providers, full builder API, agent skills catalog, Composio (1000+ integrations), MCP servers
- [03-runtime.md](references/typescript/03-runtime.md) — run(), executeCommand(), upload/download files, session controls, workspace layout, structured output, session management, storage & checkpointing, observability, error handling

**Python:**
- [01-getting-started.md](references/python/01-getting-started.md) — Installation, authentication (Gateway/BYOK), core lifecycle, streaming basics, agent reference table
- [02-configuration.md](references/python/02-configuration.md) — Sandbox providers, full constructor API, agent skills catalog, Composio (1000+ integrations), MCP servers
- [03-runtime.md](references/python/03-runtime.md) — run(), execute_command(), upload/download files, session controls, workspace layout, structured output, session management, storage & checkpointing, observability, error handling

## Critical Constraints

- **Model names** — Only use exact names from the Agent Reference table. Do not invent or guess model identifiers.
  - [TS](references/typescript/01-getting-started.md#agent-reference) | [PY](references/python/01-getting-started.md#agent-reference)
- **Cleanup** — Always call `kill()` when done. Sandboxes bill until destroyed.
  - [TS](references/typescript/01-getting-started.md#core-lifecycle) | [PY](references/python/01-getting-started.md#core-lifecycle)

## Additional References

Read on demand when the user's task requires them:

| When to read | TypeScript | Python |
|-------------|-----------|--------|
| Building a UI, handling real-time events, parsing tool calls, browser-use | [04-streaming.md](references/typescript/04-streaming.md) | [04-streaming.md](references/python/04-streaming.md) |
| Parallel agents (map/filter/reduce/bestOf/verify), Pipeline chaining | [05-swarm-pipeline.md](references/typescript/05-swarm-pipeline.md) | [05-swarm-pipeline.md](references/python/05-swarm-pipeline.md) |

## Topic Index

### Getting Started

| Topic | TypeScript | Python |
|-------|-----------|--------|
| Installation & requirements | [TS](references/typescript/01-getting-started.md#installation) | [PY](references/python/01-getting-started.md#installation) |
| Quick start (3 steps) | [TS](references/typescript/01-getting-started.md#quick-start) | [PY](references/python/01-getting-started.md#quick-start) |
| Core lifecycle (run, output, kill) | [TS](references/typescript/01-getting-started.md#core-lifecycle) | [PY](references/python/01-getting-started.md#core-lifecycle) |
| Streaming basics | [TS](references/typescript/01-getting-started.md#streaming) | [PY](references/python/01-getting-started.md#streaming) |
| Gateway vs BYOK mode | [TS](references/typescript/01-getting-started.md#authentication) | [PY](references/python/01-getting-started.md#authentication) |
| BYO subscriptions (Claude Max, Codex, Gemini) | [TS](references/typescript/01-getting-started.md#byo-claude-max-subscription) | [PY](references/python/01-getting-started.md#byo-claude-max-subscription) |
| Supported agents, models & defaults | [TS](references/typescript/01-getting-started.md#agent-reference) | [PY](references/python/01-getting-started.md#agent-reference) |

### Configuration

| Topic | TypeScript | Python |
|-------|-----------|--------|
| Sandbox providers (E2B, Modal, Daytona) | [TS](references/typescript/02-configuration.md#sandbox-providers) | [PY](references/python/02-configuration.md#sandbox-providers) |
| Provider auto-resolution from env | [TS](references/typescript/02-configuration.md#auto-resolution) | [PY](references/python/02-configuration.md#auto-resolution) |
| Full builder/constructor API | [TS](references/typescript/02-configuration.md#evolve-instance) | [PY](references/python/02-configuration.md#evolve-instance) |
| Agent skills catalog | [TS](references/typescript/02-configuration.md#agent-skills) | [PY](references/python/02-configuration.md#agent-skills) |
| Composio (auth paths, tool filtering, types) | [TS](references/typescript/02-configuration.md#composio-tool-router) | [PY](references/python/02-configuration.md#composio-tool-router) |
| MCP server config (STDIO / HTTP / SSE) | [TS](references/typescript/02-configuration.md#evolve-instance) | [PY](references/python/02-configuration.md#evolve-instance) |

### Runtime

| Topic | TypeScript | Python |
|-------|-----------|--------|
| run() options (timeout, background, checkpoint) | [TS](references/typescript/03-runtime.md#run) | [PY](references/python/03-runtime.md#run) |
| executeCommand() / execute_command() | [TS](references/typescript/03-runtime.md#executecommand) | [PY](references/python/03-runtime.md#execute_command) |
| Upload files to sandbox | [TS](references/typescript/03-runtime.md) | [PY](references/python/03-runtime.md) |
| Download output files | [TS](references/typescript/03-runtime.md) | [PY](references/python/03-runtime.md) |
| Session controls (interrupt, pause, resume, kill) | [TS](references/typescript/03-runtime.md#session-controls) | [PY](references/python/03-runtime.md#session-controls) |
| Port forwarding | [TS](references/typescript/03-runtime.md#gethost) | [PY](references/python/03-runtime.md#get_host) |
| Workspace filesystem layout | [TS](references/typescript/03-runtime.md) | [PY](references/python/03-runtime.md) |
| Structured output (Zod / Pydantic / JSON Schema) | [TS](references/typescript/03-runtime.md#structured-output) | [PY](references/python/03-runtime.md#structured-output) |
| Multi-turn conversations | [TS](references/typescript/03-runtime.md#session-management) | [PY](references/python/03-runtime.md#session-management) |
| Pause, resume, reconnect, switch sandboxes | [TS](references/typescript/03-runtime.md#session-management) | [PY](references/python/03-runtime.md#session-management) |
| Storage & checkpointing (BYOK / Gateway) | [TS](references/typescript/03-runtime.md) | [PY](references/python/03-runtime.md) |
| Checkpoint lineage & restore | [TS](references/typescript/03-runtime.md#checkpoint-lineage) | [PY](references/python/03-runtime.md#checkpoint-lineage) |
| Observability (dashboard + local logs) | [TS](references/typescript/03-runtime.md#observability) | [PY](references/python/03-runtime.md#observability) |
| Error handling | [TS](references/typescript/03-runtime.md#error-handling) | [PY](references/python/03-runtime.md#error-handling) |

### Streaming

| Topic | TypeScript | Python |
|-------|-----------|--------|
| Event listeners (content, lifecycle, stdout, stderr) | [TS](references/typescript/04-streaming.md#event-listeners) | [PY](references/python/04-streaming.md#event-listeners) |
| LifecycleEvent & LifecycleReason | [TS](references/typescript/04-streaming.md#lifecycleevent) | [PY](references/python/04-streaming.md#lifecycleevent-typeddict-shape) |
| OutputEvent & SessionUpdate types | [TS](references/typescript/04-streaming.md#sessionupdate-types) | [PY](references/python/04-streaming.md#event-types-summary) |
| Tool events (ToolCall, ToolCallUpdate, ToolKind) | [TS](references/typescript/04-streaming.md#tool-events) | [PY](references/python/04-streaming.md#toolkind-reference) |
| Browser-use detection & URL extraction | [TS](references/typescript/04-streaming.md#browseruseresponse) | [PY](references/python/04-streaming.md#browseruseresponse-extraction) |
| UI integration example | [TS](references/typescript/04-streaming.md#ui-integration-example) | [PY](references/python/04-streaming.md#ui-integration-example) |

### Swarm & Pipeline

| Topic | TypeScript | Python |
|-------|-----------|--------|
| Swarm setup (config, concurrency, retry) | [TS](references/typescript/05-swarm-pipeline.md) | [PY](references/python/05-swarm-pipeline.md) |
| Input types (FileMap, folders) | [TS](references/typescript/05-swarm-pipeline.md#input-types) | [PY](references/python/05-swarm-pipeline.md#input-types) |
| bestOf / best_of (N candidates + judge) | [TS](references/typescript/05-swarm-pipeline.md#bestof) | [PY](references/python/05-swarm-pipeline.md#best_of) |
| map (parallel processing) | [TS](references/typescript/05-swarm-pipeline.md#map) | [PY](references/python/05-swarm-pipeline.md#map) |
| filter (evaluate + threshold) | [TS](references/typescript/05-swarm-pipeline.md#filter) | [PY](references/python/05-swarm-pipeline.md#filter) |
| reduce (synthesize many to one) | [TS](references/typescript/05-swarm-pipeline.md#reduce) | [PY](references/python/05-swarm-pipeline.md#reduce) |
| verify (quality gate with feedback loop) | [TS](references/typescript/05-swarm-pipeline.md#verify-quality-gate) | [PY](references/python/05-swarm-pipeline.md#verify-quality-gate) |
| Result types (SwarmResult, ReduceResult, BestOfResult) | [TS](references/typescript/05-swarm-pipeline.md#result-types) | [PY](references/python/05-swarm-pipeline.md#result-types) |
| Chaining operations | [TS](references/typescript/05-swarm-pipeline.md#chaining-operations) | [PY](references/python/05-swarm-pipeline.md#chaining-operations) |
| Pipeline (fluent chaining, events, terminal) | [TS](references/typescript/05-swarm-pipeline.md#pipeline) | [PY](references/python/05-swarm-pipeline.md#pipeline) |

## Self-Update

Pull the latest skill from the official repo:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/evolving-machines-lab/evolve.git /tmp/evolve-update \
  && cd /tmp/evolve-update \
  && git sparse-checkout set skills/evolve \
  && cp -r skills/evolve/* <SKILL_INSTALL_DIR>/evolve/ \
  && rm -rf /tmp/evolve-update
```

Replace `<SKILL_INSTALL_DIR>` with the skill installation path (e.g. `~/.claude/skills/`, `~/.codex/skills/`, `~/.gemini/skills/`).
