---
name: evolve
description: "Evolve SDK development for TypeScript and Python. Use when building applications with Evolve to run AI agents (Claude, Codex, Gemini, Qwen, Kimi, OpenCode) in secure sandboxes. Triggers: (1) Creating Evolve applications, (2) Configuring agents with skills, Composio, MCP servers, (3) Using Swarm abstractions (map, filter, reduce, bestOf/best_of, verify), (4) Building Pipelines, (5) Structured output with schemas, (6) Session management, streaming, observability, (7) Checkpointing and storage."
---

# Evolve SDK

Build applications that run CLI agents in secure cloud sandboxes.

**Repo:** https://github.com/evolving-machines-lab/evolve

## Language Detection

Determine the language from the user's project (imports, file extensions, package.json vs pyproject.toml). All reference paths below are language-specific:

- **TypeScript** (`@evolvingmachines/sdk`) — read from `references/typescript/`
- **Python** (`evolve-sdk`) — read from `references/python/`

## Required Reading

Always read these three references before writing any Evolve code:

| File | Covers |
|------|--------|
| `01-getting-started.md` | Installation, authentication (Gateway/BYOK), core lifecycle, streaming basics, agent reference table |
| `02-configuration.md` | Sandbox providers, full builder/constructor API, agent skills catalog, Composio (1000+ integrations), MCP servers |
| `03-runtime.md` | `run()`, `executeCommand()`, upload/download files, session controls, workspace layout, structured output, session management, storage & checkpointing, observability, error handling |

## Critical Constraints

- **Model names** — Only use exact names from the Agent Reference table in `01-getting-started.md#agent-reference`. Do not invent or guess model identifiers.
- **Cleanup** — Always call `kill()` when done — see `01-getting-started.md#core-lifecycle`. Sandboxes bill until destroyed.

## Additional References

Read on demand when the user's task requires them:

| File | When to read |
|------|-------------|
| `04-streaming.md` | Building a UI, handling real-time events, parsing tool calls, browser-use detection |
| `05-swarm-pipeline.md` | Parallel agent workloads (map/filter/reduce/bestOf/verify), Pipeline chaining |

## Topic Index

Navigate directly to the relevant section. Prefix all paths with `references/typescript/` or `references/python/`.

### Getting Started

| Topic | Section |
|-------|---------|
| Installation & requirements | `01-getting-started.md#installation` |
| Quick start (3 steps) | `01-getting-started.md#quick-start` |
| Core lifecycle (run, output, kill) | `01-getting-started.md#core-lifecycle` |
| Streaming basics | `01-getting-started.md#streaming` |
| Gateway vs BYOK mode | `01-getting-started.md#authentication` |
| BYO subscriptions (Claude Max, Codex, Gemini) | `01-getting-started.md#byo-claude-max-subscription` |
| Supported agents, models & defaults | `01-getting-started.md#agent-reference` |

### Configuration

| Topic | Section |
|-------|---------|
| Sandbox providers (E2B, Modal, Daytona) | `02-configuration.md#sandbox-providers` |
| Provider auto-resolution from env | `02-configuration.md#auto-resolution` |
| Full builder/constructor API | `02-configuration.md#evolve-instance` |
| Agent skills catalog | `02-configuration.md#agent-skills` |
| Composio (auth paths, tool filtering, types) | `02-configuration.md#composio-tool-router` |
| MCP server config (STDIO / HTTP / SSE) | `02-configuration.md#evolve-instance` |

### Runtime

| Topic | Section |
|-------|---------|
| `run()` options (timeout, background, checkpoint) | `03-runtime.md#run` |
| `executeCommand()` / `execute_command()` | `03-runtime.md#executecommand` |
| Upload files to sandbox | `03-runtime.md#upload-local--sandbox` |
| Download output files | `03-runtime.md#download-sandbox--local` |
| Session controls (interrupt, pause, resume, kill) | `03-runtime.md#session-controls` |
| Port forwarding (getHost / get_host) | `03-runtime.md#gethost` |
| Workspace filesystem layout | `03-runtime.md#workspace--structured-output` |
| Structured output (Zod / Pydantic / JSON Schema) | `03-runtime.md#structured-output` |
| Multi-turn conversations | `03-runtime.md#session-management` |
| Pause, resume, reconnect, switch sandboxes | `03-runtime.md#session-management` |
| Storage & checkpointing (BYOK / Gateway) | `03-runtime.md#storage--checkpointing` |
| Checkpoint lineage & restore | `03-runtime.md#checkpoint-lineage` |
| Observability (dashboard + local logs) | `03-runtime.md#observability` |
| Error handling | `03-runtime.md#error-handling` |

### Streaming

| Topic | Section |
|-------|---------|
| Event listeners (content, lifecycle, stdout, stderr) | `04-streaming.md#event-listeners` |
| LifecycleEvent & LifecycleReason | `04-streaming.md#lifecycleevent` |
| OutputEvent & SessionUpdate types | `04-streaming.md#sessionupdate-types` |
| Tool events (ToolCall, ToolCallUpdate, ToolKind) | `04-streaming.md#tool-events` |
| Browser-use detection & URL extraction | `04-streaming.md#browseruseresponse` |
| UI integration example | `04-streaming.md#ui-integration-example` |

### Swarm & Pipeline

| Topic | Section |
|-------|---------|
| Swarm setup (config, concurrency, retry) | `05-swarm-pipeline.md` |
| Input types (FileMap, folders) | `05-swarm-pipeline.md#input-types` |
| bestOf / best_of (N candidates + judge) | `05-swarm-pipeline.md#bestof` |
| map (parallel processing) | `05-swarm-pipeline.md#map` |
| filter (evaluate + threshold) | `05-swarm-pipeline.md#filter` |
| reduce (synthesize many to one) | `05-swarm-pipeline.md#reduce` |
| verify (quality gate with feedback loop) | `05-swarm-pipeline.md#verify-quality-gate` |
| Result types (SwarmResult, ReduceResult, BestOfResult) | `05-swarm-pipeline.md#result-types` |
| Chaining operations | `05-swarm-pipeline.md#chaining-operations` |
| Pipeline (fluent chaining, events, terminal) | `05-swarm-pipeline.md#pipeline` |

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
