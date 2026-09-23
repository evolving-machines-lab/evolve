---
title: "SDK clients"
description: "One configuration. Focused clients for jobs, datasets, trials, and results."
---

Use the same managed evaluation service from TypeScript or Python. Evolve runs the jobs; your program submits work and reads the results.

**Note:**

To run agents directly with the Evolve builder, Swarm, or Pipeline, use the separate [agent SDK manual](https://github.com/evolving-machines-lab/evolve/blob/main/docs-agents/index.md).

```ts TypeScript
import { hosted } from "@evolvingmachines/evolve";

const evolve = hosted(); // Reads EVOLVE_API_KEY.
const page = await evolve.jobs.list();
```

```python Python
from evolve import hosted

evolve = hosted()  # Reads EVOLVE_API_KEY.
page = await evolve.jobs.list()
```

Python examples in this reference belong inside an async function. The [Python guide](/sdk/python) includes a complete runnable program.

## Choose a client

**[Jobs](/sdk-reference/jobs)**

Start, follow, compare, retry, and download evaluations.

**[Trials](/sdk-reference/trials)**

Inspect one attempt: reward, trace, and stored files.

**[Datasets](/sdk-reference/datasets)**

Browse tasks, publish versions, and inspect builds.

**[Filesystems](/sdk-reference/filesystem)**

Read live sandbox files and saved captures.

**[Analyses](/sdk-reference/analyses)**

Read the analyzer's results and saved runs.

**[Checks](/sdk-reference/checks)**

Check task quality before running a benchmark.

Also available: [agents](/sdk-reference/agents), [uploaded skills](/sdk-reference/skills), [secrets](/sdk-reference/secrets), [identity and teams](/sdk-reference/auth), and [platform capabilities](/sdk-reference/meta).

## Look up a method

Use the client guides above for a workflow. Open a method reference for its inputs, returned fields, and Python and TypeScript examples.

| Client | Method reference |
| --- | --- |
| Jobs | [Start, watch, compare, retry, and import](/sdk-reference/methods/jobs) |
| Trials | [Read attempts, traces, and artifacts](/sdk-reference/methods/trials) |
| Filesystems | [Read files, search, and follow live changes](/sdk-reference/methods/filesystem) |
| Analyses | [Read analysis runs and outputs](/sdk-reference/methods/analyses) |
| Checks | [Create and inspect task quality checks](/sdk-reference/methods/checks) |
| Datasets | [Browse, publish, and manage versions](/sdk-reference/methods/datasets) |
| Agents | [Register and manage harnesses](/sdk-reference/methods/agents) |
| Skills | [Upload and manage run context](/sdk-reference/methods/skills) |
| Secrets | [Store credentials and read metadata](/sdk-reference/methods/secrets) |
| Identity and teams | [Read identity and manage membership](/sdk-reference/methods/auth) |
| Capabilities | [Read supported options and limits](/sdk-reference/methods/meta) |

For failures, start with [error handling](/sdk-reference/errors) or find the exact name in the [error-code reference](/sdk-reference/error-codes).

## Configure once

```ts TypeScript
import { hosted } from "@evolvingmachines/evolve";

const evolve = hosted({
  apiKey: process.env.EVOLVE_API_KEY,
  org: "my-team",
});
```

```python Python
import os
from evolve import HostedClientConfig, hosted

evolve = hosted(HostedClientConfig(
    api_key=os.environ["EVOLVE_API_KEY"],
    org="my-team",
))
```

| Setting | TypeScript | Python | Default |
| --- | --- | --- | --- |
| API key | `apiKey` | `api_key` | `EVOLVE_API_KEY` |
| API origin | `baseUrl` | `base_url` | `EVOLVE_DASHBOARD_URL`, then the Evolve dashboard |
| Owning team | `org` | `org` | Your personal organization |

The `org` default applies when you create jobs, publish datasets, register agents, or upload skills. A call's own `org` wins. It does not filter list requests.

Prefer a single client when useful: `jobs(config)`, `trials(config)`, and the other factories accept the same configuration. Import `auth` and `managedSecrets` / `managed_secrets` separately; they are not properties of `hosted()`.

**Tip:**

`meta()` needs no key. Other clients authenticate with your API key. TypeScript checks for a key when the client is created; Python checks when it makes an authenticated request.

## One page or every item

```ts TypeScript
// One page.
const page = await evolve.jobs.list({ limit: 20 });
console.log(page.items, page.nextCursor, page.hasMore);

// All pages, one job at a time.
for await (const job of evolve.jobs.list()) {
  console.log(job.id, job.status);
}
```

```python Python
# One page.
page = await evolve.jobs.list(limit=20)
print(page.items, page.next_cursor, page.has_more)

# All pages, one job at a time.
async for job in evolve.jobs.list():
    print(job.id, job.status)
```

This pattern applies to list handles, including `jobs.trials()` and `jobs.tasks()`. A trace page, stored-file page, grep result, or dataset's nested task page is a single page; follow its cursor yourself or use the dedicated iterator where available.

## Language differences

| Detail | TypeScript | Python |
| --- | --- | --- |
| Calls | Input/options objects | Keyword arguments |
| Most domain fields | `model_name`, `cost_usd` | Same spelling |
| Returned entities | Objects | Dataclasses; stats, analyses, and checks are dictionaries |
| Download to memory | `Buffer` | `bytes` |
| Download to directory | `{ to: "./results" }` | `to="./results"` |
| Raw download stream | `{ stream: true }` | Not exposed |
| Wait cancellation | `AbortSignal` on watch methods | `timeout_s` on job/import/check watches |

See [types](/sdk-reference/types) for field access and [errors](/sdk-reference/errors) for request failures.

### Python client lifetime

Hosted clients support `async with` and `await client.close()`:

```python
from evolve import hosted

async with hosted() as client:
    page = await client.jobs.list(limit=20)
```

The individual hosted clients currently have no resources to release in `close()`. Closing a client does not cancel an evaluation. Use `jobs().cancel(job_id)` to stop a job.
