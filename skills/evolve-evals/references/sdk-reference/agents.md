---
title: "Custom agents"
description: "Register your own harness and use it in a job arm."
---

[Method reference: calls, parameters, and response fields](/sdk-reference/methods/agents).

Use `agents()` for your own agent registrations. To discover built-in harnesses, use [meta](/sdk-reference/meta).

## Register an agent

Provide a local source directory or an install script, plus the command that runs your agent.

```ts TypeScript
import { agents } from "@evolvingmachines/evolve";

const agent = await agents().create({
  name: "my-agent",
  directory: "./my-agent",
  run_command: "python agent.py",
});
```

```python Python
from evolve import agents

agent = await agents().create(
    name="my-agent",
    directory="./my-agent",
    run_command="python agent.py",
)
```

The example assumes `./my-agent` contains that runnable program. See the [custom-agent contract](/core-concepts/agents) for how it receives a task and produces output.

| Field | Required | Purpose |
| --- | --- | --- |
| `name` | Create only | Registration name used by job arms |
| `run_command` | Yes | Command that starts the agent |
| `directory` | One source | Local source folder, archived for upload |
| `install_script` | One source | Script used to install the agent |
| `env` | No | Declared non-secret environment map |
| `org` | No | Owning team; overrides the client default |

Choose exactly one of `directory` and `install_script`. Discover naming, reserved environment keys, and size limits through `meta().agent_registration`. Store credentials as [secrets](/sdk-reference/secrets).

## Use the registration

Name it in a job's `agents` list just like a built-in harness:

```json
{
  "name": "my-agent",
  "model_name": "your-model"
}
```

Use the model your custom agent is written to run. Registration does not make every model compatible with its implementation.

## Read or replace

| Action | TypeScript | Python | Returns |
| --- | --- | --- | --- |
| List registrations | `list({scope, limit, cursor})` | `list(scope=..., limit=..., cursor=...)` | Paginated handle |
| Read one | `get(name)` | `get(name)` | Agent registration |
| Create or replace | `upsert(name, input)` | `upsert(name, run_command=..., ...)` | Agent registration |
| Delete | `delete(name)` | `delete(name)` | No content |

List scopes are `my`, `shared`, and `org`. Upsert accepts the same fields as create except `name`, which is its first argument.

**Note:**

Upsert is a full replacement. Include every setting you want to retain; omitting `env` clears it. It avoids the gap created by deleting and then registering again.

Deleting a registration does not rewrite the agent identity already recorded on past jobs.
