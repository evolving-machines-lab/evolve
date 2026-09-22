---
title: "Secrets"
description: "Store a credential once, then attach it to evaluation jobs by name."
---

[Method reference: calls, parameters, and response fields](/sdk-reference/methods/secrets).

Managed evals attach **direct** secrets: their values enter the task sandbox as environment variables. Stored values are write-only through the secrets API.

## Store a value

```ts TypeScript
import { managedSecrets } from "@evolvingmachines/evolve";

const store = managedSecrets();
await store.set({
  name: "SERVICE_TOKEN",
  value: process.env.SERVICE_TOKEN!,
  delivery: "direct",
});
```

```python Python
import os
from evolve import managed_secrets

store = managed_secrets()
await store.set(
    name="SERVICE_TOKEN",
    value=os.environ["SERVICE_TOKEN"],
    delivery="direct",
)
```

Set `SERVICE_TOKEN` in your process environment before running this example. A value may contain at most 190 UTF-8 bytes.

## Attach it to a job

Add a `secrets` list to the job creation input:

```ts TypeScript
const secrets = [{ name: "SERVICE_TOKEN", as: "APP_TOKEN" }];
// Pass secrets alongside datasets and agents in jobs().start(...).
```

```python Python
secrets = [{"name": "SERVICE_TOKEN", "as": "APP_TOKEN"}]
# Pass secrets=secrets alongside datasets and agents in jobs().start(...).
```

| Field | Meaning |
| --- | --- |
| `name` | Stored secret name |
| `label` | Optional labeled version |
| `as` | Optional environment variable name inside the sandbox; defaults to `name` |

Without a label, resolution chooses the `default` row, then the only row if exactly one exists. Multiple remaining labels produce an ambiguity error.

### Inline values

Job creation can store and attach a value in one request:

```json
{
  "secrets": [{
    "name": "SERVICE_TOKEN",
    "value": "your-value",
    "delivery": "direct"
  }]
}
```

Optional `label` and `as` work here too. The value is stored as a secret; the job retains a reference. Restating the same identity/value is allowed. A different value under the same name/label is refused instead of silently replacing it.

## Manage stored secrets

| Action | TypeScript | Python | Returns |
| --- | --- | --- | --- |
| Read metadata | `list()` | `list()` | Secret metadata list |
| Store a value | `set(input)` | `set(name=..., value=..., delivery=..., ...)` | `created` / `updated` and metadata |
| Delete a labeled value | `delete({name, label})` | `delete(name=..., label=...)` | Deletion result |

`set` requires `name`, `value`, and `delivery`; `label` defaults to `default`. A different value under an existing identity returns `secret_exists`. To rotate, use another label or delete and set that identity.

The broader storage API also accepts `delivery: "brokered"`, with required host/path/method scope lists. Managed eval jobs cannot attach those secrets today. Direct delivery refuses those scoping options.

| Scoping option | TypeScript | Python |
| --- | --- | --- |
| Hosts | `allowedHosts` | `allowed_hosts` |
| Path prefixes | `allowedPathPrefixes` | `allowed_path_prefixes` |
| HTTP methods | `allowedMethods` | `allowed_methods` |

## Configuration and errors

This factory uses its own configuration:

| Setting | TypeScript | Python |
| --- | --- | --- |
| API key | `apiKey` | `api_key` |
| Dashboard origin | `dashboardUrl` | `dashboard_url` |

Python wraps those fields in `ManagedSecretsClientConfig`. Defaults come from `EVOLVE_API_KEY` and `EVOLVE_DASHBOARD_URL` as usual.

Secret-client HTTP failures raise plain `Error` in TypeScript and `RuntimeError` in Python. They are not the hosted `EvolveApiError` / `EvolveAPIError` class.
