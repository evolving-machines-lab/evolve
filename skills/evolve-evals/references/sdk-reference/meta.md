---
title: "Platform capabilities"
description: "Discover available harnesses, models, providers, and current limits."
---

[Method reference: calls, parameters, and response fields](/sdk-reference/methods/meta).

`meta()` returns the platform's capability document. It needs no API key.

```ts TypeScript
import { meta } from "@evolvingmachines/evolve";

const capabilities = await meta();
for (const agent of capabilities.agents) {
  console.log(agent.name, agent.runnable, agent.models.map((m) => m.alias));
}
```

```python Python
from evolve import meta

capabilities = await meta()
for agent in capabilities.agents:
    print(agent.name, agent.runnable, [m.alias for m in agent.models])
```

Also available as `hosted().meta()` in both languages.

## What to read

| Field | Use it to answer |
| --- | --- |
| `agents` | Which harnesses run? Which models, efforts, versions, kwargs, and presets do they support? |
| `retired_agents` | Which harnesses are retired, and which harness replaces each? |
| `sandbox_providers` | Which providers support the task's resources and features? |
| `platform_constraints` | Which requirements cannot run on this deployment? |
| `network_modes` | Which network modes can a task declare? |
| `analyze` | Which analyzer models and reasoning efforts are available? |
| `limits` | What are the current defaults and bounds for jobs, pages, uploads, and comparisons? |
| `statuses` | Which states exist, and which are terminal? |
| `agent_registration` | Which names, environment keys, and upload sizes can a custom agent use? |
| `error_codes`, `import_warning_codes` | Which failure and warning codes does this deployment publish? |
| `managed_providers` | Which providers are available to the separate managed-agent runtime? |

**Tip:**

Read capabilities when building a picker or validating a saved configuration. A documented example is useful; a fixed copy of the platform's model catalog becomes stale.

## Configuration

`meta(config?)` accepts the usual [hosted configuration](/sdk-reference/index#configure-once). Only the API origin matters; credentials are not sent.

The result includes `schema_version`. Treat it as the document's schema version, not the SDK package version.

Read the full editable analyzer policy through [analysis defaults](/sdk-reference/analyses#read-current-defaults) or [check defaults](/sdk-reference/checks#read-current-defaults).
