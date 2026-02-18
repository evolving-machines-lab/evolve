---
name: evolve-dev
description: "Evolve SDK development for TypeScript and Python. Use when building applications with Evolve to run AI agents (Claude, Codex, Gemini, Qwen, Kimi, OpenCode) in secure sandboxes. Triggers: (1) Creating Evolve applications, (2) Configuring agents with skills, Composio, MCP servers, (3) Using Swarm abstractions (map, filter, reduce, bestOf/best_of, verify), (4) Building Pipelines, (5) Structured output with schemas, (6) Session management, streaming, observability, (7) Checkpointing and storage."
---

# Evolve SDK

**Repo:** https://github.com/evolving-machines-lab/evolve

## Language Detection

Determine the language from the user's project (imports, file extensions, package.json vs pyproject.toml):

- **TypeScript** (`@evolvingmachines/sdk`) — Read references from `references/typescript/`
- **Python** (`evolve-sdk`) — Read references from `references/python/`

## Core Lifecycle (TypeScript)

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
    .withAgent({ type: "claude" });

try {
    const result = await evolve.run({ prompt: "Analyze the dataset" });
    const output = await evolve.getOutputFiles();
    console.log(output.files);   // All files from output/
    console.log(output.data);    // Parsed result.json (if .withSchema() set)
} finally {
    await evolve.kill();         // ALWAYS destroy sandbox
}
```

## Core Lifecycle (Python)

```python
from evolve import Evolve, AgentConfig

evolve = Evolve(config=AgentConfig(type='claude'))
try:
    await evolve.run(prompt='Analyze the dataset')
    output = await evolve.get_output_files()
    print(output.files)          # All files from output/
    print(output.data)           # Parsed result.json (if schema= set)
finally:
    await evolve.kill()          # ALWAYS destroy sandbox
```

> **CRITICAL: Always call `kill()` when done.** Each `run()` creates a cloud sandbox that bills until destroyed. Forgetting `kill()` leaves sandboxes running indefinitely. Always use try/finally.

## Agent Reference

> **CRITICAL: Only use the exact model names below.** Do not invent or guess model identifiers. The SDK errors on unrecognized names.

| type | models | default |
|------|--------|---------|
| `"claude"` | `"opus"` `"sonnet"` `"haiku"` | `"sonnet"` |
| `"codex"` | `"gpt-5.2"` `"gpt-5.2-codex"` `"gpt-5.1-codex-max"` `"gpt-5.1-mini"` | `"gpt-5.2"` |
| `"gemini"` | `"gemini-3-pro-preview"` `"gemini-3-flash-preview"` `"gemini-2.5-pro"` `"gemini-2.5-flash"` `"gemini-2.5-flash-lite"` | `"gemini-3-flash-preview"` |
| `"qwen"` | `"qwen3-coder-plus"` `"qwen3-vl-plus"` | `"qwen3-coder-plus"` |
| `"kimi"` | `"moonshot/kimi-k2.5"` `"moonshot/kimi-k2-turbo-preview"` | `"moonshot/kimi-k2.5"` |
| `"opencode"` | `"openai/gpt-5.2"` `"anthropic/claude-sonnet-4-5"` `"anthropic/claude-opus-4-6"` `"google/gemini-3-pro-preview"` | `"openai/gpt-5.2"` |

In Gateway mode (`EVOLVE_API_KEY`), the default claude model is `"opus"`. In BYOK mode, it defaults to `"sonnet"`.

Agent-specific options: `reasoningEffort` / `reasoning_effort` (Codex: `"low"` `"medium"` `"high"` `"xhigh"`), `betas` (Claude Sonnet: `["context-1m-2025-08-07"]`).

## Reference Guide

Read the relevant reference file based on the user's task. Use the language-specific path (`references/typescript/` or `references/python/`).

| Topic | Reference File |
|-------|---------------|
| Installation, auth (Gateway/BYOK/OAuth), env vars | `01-getting-started.md` |
| Sandbox providers (E2B/Modal/Daytona), `.with*()` / constructor API, skills catalog, Composio (1000+ integrations), MCP servers | `02-configuration.md` |
| `run()`, `executeCommand()` / `execute_command()`, upload/download files, session controls (interrupt/pause/resume/kill), structured output, workspace layout, session management, storage & checkpointing, observability, error handling | `03-runtime.md` |
| Streaming event types (OutputEvent, SessionUpdate, ToolCall, ToolKind, BrowserUseResponse), UI integration example | `04-streaming.md` |
| Swarm (map/filter/reduce/bestOf/verify), Pipeline (fluent chaining), result types, concurrency, retry | `05-swarm-pipeline.md` |

## Self-Update

Pull the latest skill from the official repo:

```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/evolving-machines-lab/evolve.git /tmp/evolve-update \
  && cd /tmp/evolve-update \
  && git sparse-checkout set skills/evolve-dev \
  && cp -r skills/evolve-dev/* <SKILL_INSTALL_DIR>/evolve-dev/ \
  && rm -rf /tmp/evolve-update
```

Replace `<SKILL_INSTALL_DIR>` with the skill installation directory (e.g. `~/.claude/skills/`, `~/.codex/skills/`, `~/.gemini/skills/`).
