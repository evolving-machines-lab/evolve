---
title: "Sandboxes"
description: "Choose a cloud provider and understand how task requirements affect placement."
---

Each trial runs in its own cloud sandbox. Use `-e` to request E2B, Daytona, or Modal; the default is Daytona.

```bash
evolve run -d harbor-examples@1.0 -i hello-world \
  -a codex -m gpt-5.6-luna -e modal \
  --max-trial-spend 1 --max-retries 0 --watch
```

## Task requirements come first

Evolve checks the requested provider against the task's image, resources, network policy, Compose services, and GPUs.

```mermaid
%%{init: {"flowchart": {"nodeSpacing": 16, "rankSpacing": 20, "padding": 10}, "themeVariables": {"fontSize": "14px", "fontFamily": "Google Sans Flex, sans-serif"}}}%%
flowchart TB
  A["1. Check requested<br/>provider"] -->|"Fits task"| B["2. Use it"]
  A -->|"Does not fit"| C["2. Check alternatives<br/>E2B → Modal<br/>→ Daytona"]
  C -->|"Match"| D["3. Use fallback"]
  C -->|"No match"| E["3. Reject"]
```

A fallback is recorded as `sandbox_provider_degrade` on the trial. The requested provider on the job and the actual provider on a trial can differ.

If no provider can satisfy the task, Evolve rejects the configuration.

```bash
evolve dataset show harbor-examples@1.0
```

Inspect the per-task provider verdicts before starting a larger run. A compatible declaration does not guarantee immediate provider capacity.

## Supported configurations

| Capability | E2B | Daytona | Modal |
| --- | --- | --- | --- |
| Single-container tasks | Yes | Yes | Yes |
| Docker Compose | Yes | Yes | No |
| GPUs | No | Subject to live quota and GPU type | Yes |
| Compose with GPUs | No | No | No |
| Compose with `no-network` | No | No | No |

Network allowlist kinds and resource ceilings also differ. The live [`meta()` document](/sdk-reference/meta) publishes these constraints. Daytona disk and GPU limits depend on the platform's live provider quota.

**Note:**

A temporary capacity shortage can put a trial back in the queue even with `--max-retries 0`. Capacity waits are bounded and separate from ordinary retry attempts.

## Images and startup

Dataset publication prepares task images. A provider may also need to prepare its own cached image or snapshot before the first trial. That first start can take longer than later trials using the cache.

Resources come from the task's `task.toml`. See [task configuration](/core-concepts/task-config) for defaults and how to request CPUs, memory, disk, and GPUs.

## GPU costs

GPU compute is shown as an estimate, separate from model spend:

| Location | Field |
| --- | --- |
| Trial | `gpu_cost` |
| Job totals | `stats.gpu_cost_usd` |
| CLI trial view | `gpu compute (est.)` |

An unavailable estimate includes `unpriced_reason`. Do not add this estimate to the metered model cost and present it as the same charge.

## Analysis and checks

These operations also use sandboxes. Choose their provider with `-e` on `evolve analyze` or `evolve check`, or `--analyze-provider` for analysis attached to a run. Their default is Daytona unless the platform operator configures another provider; the [SDK defaults](/sdk-reference/analyses#read-current-defaults) expose the resolved setting.
