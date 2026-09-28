---
title: "Models"
description: "Exact model names, per-model reasoning options, and Evolve defaults."
---

Choose a harness, then copy a model name from its tab. Use the same model string in the CLI, TypeScript, and Python.

| Setting | CLI → managed SDK |
| --- | --- |
| Harness | `-a` → `agents[].name` |
| Model | `-m` → `agents[].model_name` |
| Reasoning effort | `--effort` → `agents[].reasoning_effort` |

Every evaluation arm **requires a model**. The default model below is the Agent SDK’s choice when its model is omitted. Default effort is Evolve’s configured setting when effort is omitted.

## Model and effort reference

Reasoning options are checked against the exact model’s provider documentation and the harness’s native controls. Models with a thinking toggle or a token budget are labeled in the table.

`off` is the CLI and SDK spelling for thinking disabled and `thinking` for enabled; `none` is a native spelling shown in some tables and is not accepted. A model outside a harness's roster runs only through the Agent SDK; managed evaluations refuse it.

**Note:**

This page records native support. Some Evolve effort mappings still need correction before all of these options work through the CLI and SDK.

### Claude Code

**Harness:** `claude`

**Default model:** `opus` or `claude-opus-5-5`

**Default effort:** `high`

| Model | Model string | Native reasoning efforts |
| --- | --- | --- |
| Claude Fable 5.1 | `fable` | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Opus 5.5 | `opus` | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Sonnet 5 | `sonnet` | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Haiku 4.5 | `haiku` | Thinking budget; no effort levels |
| GLM 5.3 | `glm-5.3` | `low`, `high`, `max` |
| GLM 5.3 Flash | `glm-5.3-flash` | `low`, `high`, `max` |
| DeepSeek V4.1 Flash | `openrouter/deepseek/deepseek-v4.1-flash` | `low`, `high`, `max` |
| DeepSeek V4.1 Flash | `fireworks/deepseek-v4.1-flash` | `low`, `high`, `max` |

### Sources

[Claude Code](https://code.claude.com/docs/en/model-config) · [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort) · [GLM 5.3](https://docs.z.ai/guides/llm/glm-5.3) · [Fireworks model controls](https://github.com/fw-ai/fireconnect/blob/02e352a6184a404f0be3be0f1fd92ada9d37014b/packages/setup-cli/lib/fireworks/reasoning.mjs)

### Other accepted model spellings

| Model string | Also accepted |
| --- | --- |
| `fable` | `claude-fable-5-1` |
| `opus` | `claude-opus-5-5` |
| `sonnet` | `claude-sonnet-5` |
| `haiku` | `claude-haiku-4-5-20251001` |

### Codex

**Harness:** `codex`

**Default model:** `gpt-6-sol`

**Default effort:** `high`

| Model | Model string | Native reasoning efforts |
| --- | --- | --- |
| GPT-6 Astra | `gpt-6-astra` | `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Sol | `gpt-6-sol` | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-5.6 Terra | `gpt-5.6-terra` | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Luna | `gpt-6-luna` | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-5.3 Codex | `gpt-5.3-codex` | `low`, `medium`, `high`, `xhigh` |

### Sources

[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra) · [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol) · [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) · [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra) · [GPT-5.3 Codex](https://developers.openai.com/api/docs/models/gpt-5.3-codex)

### Qwen Code

**Harness:** `qwen`

**Default model:** `qwen3.8-max`

**Default effort:** `thinking`

| Model | Model string | Native reasoning efforts |
| --- | --- | --- |
| Qwen 3.8 Max | `qwen3.8-max` | `off`, `low`, `medium`, `xhigh` |
| Qwen 3.7 Plus | `qwen3.7-plus` | `off`, `thinking` |
| Qwen 3.8 Flash | `qwen3.8-flash` | `off`, `low`, `medium`, `xhigh` |

### Sources

[Qwen Code settings](https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/) · [Qwen model controls](https://docs.qwencloud.com/api-reference/chat/openai-chat)

### Kimi Code

**Harness:** `kimi`

**Default model:** `kimi-k3` or `moonshot/kimi-k3`

**Default effort:** `max`

| Model | Model string | Native reasoning efforts |
| --- | --- | --- |
| Kimi K3 | `kimi-k3` | `low`, `high`, `max` |
| Kimi K2.7 Code | `kimi-k2.7-code` | Always thinking; no effort levels |
| Kimi K3 Raptor | `kimi-k3-raptor` | `off`, `low`, `high`, `max` |

### Sources

[Kimi model controls](https://www.kimi.ai/help/kimi-api/api-model-selection) · [Kimi reasoning](https://platform.kimi.ai/docs/guide/use-reasoning-effort) · [Fireworks reasoning](https://docs.fireworks.ai/api-reference/post-chatcompletions)

### Other accepted model spellings

| Model string | Also accepted |
| --- | --- |
| `kimi-k3` | `moonshot/kimi-k3` |
| `kimi-k2.7-code` | `moonshot/kimi-k2.7-code` |

### OpenCode

**Harness:** `opencode`

**Default model:** `openrouter/anthropic/claude-opus-5.5`

**Default effort:** `high`

| Model | Model string | Native reasoning efforts |
| --- | --- | --- |
| Claude Fable 5.1 | `openrouter/anthropic/claude-fable-5.1` | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Opus 5.5 | `openrouter/anthropic/claude-opus-5.5` | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Sonnet 5 | `openrouter/anthropic/claude-sonnet-5` | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Haiku 4.5 | `openrouter/anthropic/claude-haiku-4.5` | Thinking budget; no effort levels |
| GPT-6 Astra | `openrouter/openai/gpt-6-astra` | `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Sol | `openrouter/openai/gpt-6-sol` | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-5.6 Terra | `openrouter/openai/gpt-5.6-terra` | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Luna | `openrouter/openai/gpt-6-luna` | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| Gemini 3.8 Flash | `openrouter/google/gemini-3.8-flash` | `low`, `medium`, `high` |
| Qwen 3.8 Max | `openrouter/qwen/qwen3.8-max-0902` | `minimal`, `low`, `medium`, `high`, `xhigh` |
| Kimi K3 | `openrouter/moonshotai/kimi-k3` | `none`, `low`, `high`, `max` |
| GLM 5.3 | `openrouter/z-ai/glm-5.3` | `low`, `high`, `max` |
| GLM 5.3 Flash | `openrouter/z-ai/glm-5.3-flash` | `low`, `high`, `max` |
| DeepSeek V4.1 Flash | `openrouter/deepseek/deepseek-v4.1-flash` | `none`, `low`, `high`, `max` |
| DeepSeek V4.1 Flash | `fireworks/deepseek-v4.1-flash` | `none`, `low`, `high`, `max` |

### Sources

[OpenCode models](https://opencode.ai/docs/models/) · [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) · [Fireworks model controls](https://github.com/fw-ai/fireconnect/blob/02e352a6184a404f0be3be0f1fd92ada9d37014b/packages/setup-cli/lib/fireworks/reasoning.mjs)

### Droid

**Harness:** `droid`

**Default model:** `claude-opus-5-5`

**Default effort:** `high`

| Model | Model string | Native reasoning efforts |
| --- | --- | --- |
| Claude Fable 5.1 | `claude-fable-5.1` | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Opus 5.5 | `claude-opus-5-5` | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Sonnet 5 | `claude-sonnet-5` | `off`, `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Haiku 4.5 | `claude-haiku-4-5` | `off`, `low`, `medium`, `high` (thinking budgets) |
| GPT-5.6 Terra | `gpt-5.6-terra` | `none`, `low`, `medium`, `high`, `xhigh`, `max` |
| Gemini 3.8 Flash | `gemini-3.8-flash` | `low`, `medium`, `high` |
| Qwen 3.8 Max | `qwen3.8-max` | `low`, `medium`, `xhigh` |
| Kimi K3 | `kimi-k3` | `low`, `high`, `max` |
| GLM 5.3 | `glm-5.3` | `low`, `high`, `max` |
| GLM 5.3 Flash | `glm-5.3-flash` | `low`, `high`, `max` |
| DeepSeek V4.1 Flash | `openrouter/deepseek/deepseek-v4.1-flash` | `off`, `low`, `high`, `max` |
| DeepSeek V4.1 Flash | `fireworks/deepseek-v4.1-flash` | `off`, `low`, `high`, `max` |

### Sources

[Factory models](https://docs.factory.ai/models) · [Claude effort](https://platform.claude.com/docs/en/build-with-claude/effort) · [Gemini thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking) · [Fireworks model controls](https://github.com/fw-ai/fireconnect/blob/02e352a6184a404f0be3be0f1fd92ada9d37014b/packages/setup-cli/lib/fireworks/reasoning.mjs)

### Other accepted model spellings

| Model string | Also accepted |
| --- | --- |
| `claude-fable-5.1` | `claude-fable-5-1` |
| `claude-haiku-4-5` | `claude-haiku-4-5-20251001` |

### Pi

**Harness:** `pi`

**Default model:** `openrouter/anthropic/claude-opus-5.5`

**Default effort:** `high`

| Model | Model string | Native reasoning efforts |
| --- | --- | --- |
| Claude Fable 5.1 | `openrouter/anthropic/claude-fable-5.1` | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Opus 5.5 | `openrouter/anthropic/claude-opus-5.5` | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Sonnet 5 | `openrouter/anthropic/claude-sonnet-5` | `off`, `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Haiku 4.5 | `openrouter/anthropic/claude-haiku-4.5` | `off`, `minimal`, `low`, `medium`, `high` (thinking budgets) |
| GPT-6 Astra | `openrouter/openai/gpt-6-astra` | `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Sol | `openrouter/openai/gpt-6-sol` | `off`, `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-5.6 Terra | `openrouter/openai/gpt-5.6-terra` | `off`, `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Luna | `openrouter/openai/gpt-6-luna` | `off`, `low`, `medium`, `high`, `xhigh`, `max` |
| Gemini 3.8 Flash | `openrouter/google/gemini-3.8-flash` | `low`, `medium`, `high` |
| Qwen 3.8 Max | `openrouter/qwen/qwen3.8-max-0902` | `minimal`, `low`, `medium`, `high`, `xhigh` |
| Kimi K3 | `openrouter/moonshotai/kimi-k3` | `off`, `low`, `high`, `max` |
| GLM 5.3 | `openrouter/z-ai/glm-5.3` | `low`, `high`, `max` |
| GLM 5.3 Flash | `openrouter/z-ai/glm-5.3-flash` | `low`, `high`, `max` |
| DeepSeek V4.1 Flash | `openrouter/deepseek/deepseek-v4.1-flash` | `off`, `low`, `high`, `max` |

### Sources

[Pi model configuration](https://github.com/earendil-works/pi/blob/v0.87.1/packages/coding-agent/docs/models.md) · [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

### Prime Agent

**Harness:** `prime-agent`

**Default model:** `openrouter/anthropic/claude-opus-5.5`

**Default effort:** `high`

| Model | Model string | Native reasoning efforts |
| --- | --- | --- |
| Claude Fable 5.1 | `openrouter/anthropic/claude-fable-5.1` | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Opus 5.5 | `openrouter/anthropic/claude-opus-5.5` | `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Sonnet 5 | `openrouter/anthropic/claude-sonnet-5` | `off`, `low`, `medium`, `high`, `xhigh`, `max` |
| Claude Haiku 4.5 | `openrouter/anthropic/claude-haiku-4.5` | `off`, `high` (thinking off/on; no effort levels) |
| GPT-6 Astra | `openrouter/openai/gpt-6-astra` | `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Sol | `openrouter/openai/gpt-6-sol` | `off`, `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-5.6 Terra | `openrouter/openai/gpt-5.6-terra` | `off`, `low`, `medium`, `high`, `xhigh`, `max` |
| GPT-6 Luna | `openrouter/openai/gpt-6-luna` | `off`, `low`, `medium`, `high`, `xhigh`, `max` |
| Gemini 3.8 Flash | `openrouter/google/gemini-3.8-flash` | `low`, `medium`, `high` |
| Qwen 3.8 Max | `openrouter/qwen/qwen3.8-max-0902` | `minimal`, `low`, `medium`, `high`, `xhigh` |
| Kimi K3 | `openrouter/moonshotai/kimi-k3` | `off`, `low`, `high`, `max` |
| GLM 5.3 | `openrouter/z-ai/glm-5.3` | `low`, `high`, `max` |
| GLM 5.3 Flash | `openrouter/z-ai/glm-5.3-flash` | `low`, `high`, `max` |
| DeepSeek V4.1 Flash | `openrouter/deepseek/deepseek-v4.1-flash` | `off`, `low`, `high`, `max` |

### Sources

[Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent/tree/v0.9.6) · [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)

### DeepSeek Harness

**Harness:** `dsh`

**Default model:** `openrouter/deepseek/deepseek-v4.1-flash`

**Default effort:** `high`

| Model | Model string | Native reasoning efforts |
| --- | --- | --- |
| DeepSeek V4.1 Flash | `openrouter/deepseek/deepseek-v4.1-flash` | `off`, `low`, `high`, `max` |
| DeepSeek V4.1 Flash | `fireworks/deepseek-v4.1-flash` | `off`, `low`, `high`, `max` |
| DeepSeek V4 Pro | `openrouter/deepseek/deepseek-v4-pro-0813` | `off`, `low`, `high`, `max` |

### Sources

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.1.7-rc.2) · [OpenRouter reasoning](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens) · [Fireworks reasoning](https://docs.fireworks.ai/api-reference/post-chatcompletions)

### Z Code

**Harness:** `zcode`

**Default model:** `openrouter/z-ai/glm-5.3`

**Default effort:** `high`

| Model | Model string | Native reasoning efforts |
| --- | --- | --- |
| GLM 5.3 | `openrouter/z-ai/glm-5.3` | `low`, `high`, `max` |
| GLM 5.3 Flash | `openrouter/z-ai/glm-5.3-flash` | `low`, `high`, `max` |
| GLM 5.3 | `fireworks/glm-5.3` | `low`, `high`, `max` |
| GLM 5.3 Flash | `fireworks/glm-5.3-flash` | `low`, `high`, `max` |

### Sources

[Z Code](https://github.com/zai-org/ZCode) · [GLM 5.3](https://docs.z.ai/guides/llm/glm-5.3) · [GLM 5.3 Flash](https://docs.z.ai/guides/vlm/glm-5.3-flash) · [Fireworks model controls](https://github.com/fw-ai/fireconnect/blob/02e352a6184a404f0be3be0f1fd92ada9d37014b/packages/setup-cli/lib/fireworks/reasoning.mjs)

### Antigravity

**Harness:** `antigravity`

**Default model:** `gemini-3.8-flash` or `vertex_ai/gemini-3.8-flash`

**Default effort:** `high`

| Model | Model string | Native reasoning efforts |
| --- | --- | --- |
| Gemini 3.8 Flash | `gemini-3.8-flash` | `low`, `medium`, `high` |
| Gemini 3.5 Flash-Lite | `gemini-3.5-flash-lite` | `low`, `medium`, `high` |
| Gemini 3.1 Pro Preview | `gemini-3.1-pro-preview` | `low`, `medium`, `high` |

### Sources

[Antigravity CLI](https://antigravity.google/docs/cli/overview/) · [Gemini thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking)

### Other accepted model spellings

| Model string | Also accepted |
| --- | --- |
| `gemini-3.8-flash` | `vertex_ai/gemini-3.8-flash` |
| `gemini-3.5-flash-lite` | `vertex_ai/gemini-3.5-flash-lite` |
| `gemini-3.1-pro-preview` | `vertex_ai/gemini-3.1-pro-preview` |

**Note:**

`gemini` is retired. Use `antigravity` for new runs. Records of earlier Gemini CLI runs remain readable.

## Use your selection

This example runs Codex with GPT-6 Luna at `high` effort.

```bash CLI
evolve run \
  -d harbor-examples@1.0 \
  -i hello-world \
  -a codex \
  -m gpt-6-luna \
  --effort high \
  --max-trial-spend 1 \
  --max-retries 0 \
  --watch
```

```ts TypeScript
import { jobs } from "@evolvingmachines/evolve";

const job = await jobs().start({
  datasets: [{
    name: "harbor-examples",
    version: "1.0",
    task_names: ["hello-world"],
  }],
  agents: [{
    name: "codex",
    model_name: "gpt-6-luna",
    reasoning_effort: "high",
  }],
  max_trial_spend_usd: 1,
  retry: { max_retries: 0 },
});
```

```python Python
import asyncio
from evolve import jobs


async def main():
    job = await jobs().start(
        datasets=[{
            "name": "harbor-examples",
            "version": "1.0",
            "task_names": ["hello-world"],
        }],
        agents=[{
            "name": "codex",
            "model_name": "gpt-6-luna",
            "reasoning_effort": "high",
        }],
        max_trial_spend_usd=1,
        retry={"max_retries": 0},
    )
    print(job.id)


asyncio.run(main())
```

Repeat `-m` to compare models on one harness. `--effort` applies to every arm. To compare different efforts, set `reasoning_effort` separately on each arm in a [job config](/cli-reference/run) or the [SDK](/sdk-reference/jobs).

### Using the Agent SDK instead of managed evaluations

The Agent SDK uses `model` and TypeScript `reasoningEffort` / Python `reasoning_effort` in its agent configuration. It can omit the model; managed evaluation arms cannot.

The tables above describe Evolve model access. Direct provider credentials have their own available models. On Claude Code and Droid, the `glm-5.3`, `glm-5.3-flash`, `openrouter/…` and `fireworks/…` rows, and Droid's `qwen3.8-max`, are gateway routes, and the `fireworks/` options on OpenCode, DeepSeek Harness, and Z Code require Evolve model access.

See the [Agent SDK manual](https://github.com/evolving-machines-lab/evolve/blob/main/docs-agents/index.md).

### Read the current model list

```bash
curl -sS https://dashboard.evolvingmachines.ai/api/meta
```

No authentication is required. `agents[].models` lists model aliases and IDs. Metadata reports the API’s accepted inputs and configured defaults.

The same document is available through [`meta()` in both SDKs](/sdk-reference/meta).

## Model access and spend

An `EVOLVE_API_KEY` supplies platform model access. `--max-trial-spend` caps agent model spend **per trial attempt**. Verifier judges and trace analysis have separate budgets. See [job costs](/core-concepts/jobs#spend-and-retries).

### Provider keys and metering

With your own supported provider key, model requests bill that provider account. Evolve gateway metering and the trial cap still apply. Job creation still requires a positive platform credit balance.

Requests that bypass the gateway with separate credentials are not metered by Evolve. A task's `no-network` agent policy restricts model access to the platform gateway.

## Analysis and check models

Analysis and task checks choose their agent and model separately from the evaluation arms.

| Operation | Agent / model options |
| --- | --- |
| `evolve analyze` | `-a` / `-m` |
| `evolve check` | `-a` / `-m` |
| Analysis during `evolve run` | `--analyze-agent` / `--analyze-model` |

The default harness is `claude`. An omitted model uses `openrouter/deepseek/deepseek-v4.1-flash` when the selected harness offers it; otherwise it uses that harness's default model. A named model must belong to the selected harness's table above.

```bash Analysis defaults
evolve analyze --show-defaults -a codex
```

```bash Check defaults
evolve check --show-defaults -a codex
```

Analysis and checks have their own model and effort defaults. Read them with `--show-defaults`.

**[Configure a run](/cli-reference/run)**

Model comparisons, effort, concurrency, and spend controls.
