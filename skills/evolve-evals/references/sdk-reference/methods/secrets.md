---
title: "Secrets: methods"
description: "Store credentials and read or delete their metadata."
---

Use `managedSecrets()` in TypeScript or `managed_secrets()` in Python. This client has its own configuration and is separate from `hosted()`. Examples use `store` for that client.

Managed evaluations accept `direct` secrets. Their values enter the sandbox as environment variables. The storage client also supports brokered secrets for the separate managed-agent runtime.

Python examples run inside an async function.

## list

Read stored secret metadata. Secret values are never returned.

```ts TypeScript
const secrets = await store.list();
```

```python Python
secrets = await store.list()
```

**Returns:** `ManagedSecretMetadata[]` / `List[ManagedSecretMetadata]`. No arguments; no pagination.

## set

Store a value under a name and optional label.

```ts TypeScript
const result = await store.set({
  name: "SERVICE_TOKEN",
  label: "v2",
  value: process.env.SERVICE_TOKEN!,
  delivery: "direct",
});
```

```python Python
import os

result = await store.set(
    name="SERVICE_TOKEN",
    label="v2",
    value=os.environ["SERVICE_TOKEN"],
    delivery="direct",
)
```

**Returns:** `ManagedSecretWriteResult`: `status` (`created` or `updated`) and `secret` metadata.

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| `name` | Required string. Trimmed and converted to uppercase; 1–128 letters, digits, or underscores. Must start with a letter or underscore; `EVOLVE_` is reserved. |
| `value` | Required, non-empty string; at most 190 UTF-8 bytes. |
| `delivery` | Required `direct` or `brokered`. |
| `label?` | String, at most 80 letters, digits, dots, underscores, or hyphens. Whitespace is trimmed; omitted or empty means `default`. |
| `allowedHosts?` / `allowed_hosts?` | String list of hostnames or wildcard hostnames, such as `api.example.com` or `*.example.com`. No scheme, port, or path. |
| `allowedPathPrefixes?` / `allowed_path_prefixes?` | String list of paths starting with `/`. No `..` segments or encoded slashes. |
| `allowedMethods?` / `allowed_methods?` | String list: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, or `HEAD`. Converted to uppercase. |

Each scope list accepts at most 50 entries after trimming and removing blank or duplicate strings. Hostnames allow at most 253 characters; path prefixes allow at most 512.

Direct delivery accepts omitted or empty scope lists and refuses non-empty lists. Brokered delivery requires all three lists to be non-empty. Managed eval jobs currently cannot attach brokered secrets.

Restating the same name, label, and value returns `updated` and can update delivery/scope. A different value at the same identity returns `secret_exists`. Rotate using a new label, or delete and set that identity.

## delete

Delete the stored row for a name and label.

```ts TypeScript
const result = await store.delete({
  name: "SERVICE_TOKEN",
  label: "v1",
});
```

```python Python
result = await store.delete(
    name="SERVICE_TOKEN",
    label="v1",
)
```

**Returns:** `ManagedSecretDeleteResult`: `ok: boolean`, `name: string`, and the deleted `label: string`.

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| `name` | Required string, normalized by the same rules as `set`. |
| `label?` | If provided: 1–80 allowed characters after trimming; empty labels are refused. If omitted: choose the `default` row, otherwise the only row, otherwise refuse the ambiguous choice. |

## Configuration

```ts TypeScript
import { managedSecrets } from "@evolvingmachines/evolve";

const store = managedSecrets({
  apiKey: process.env.EVOLVE_API_KEY,
  dashboardUrl: "https://dashboard.evolvingmachines.ai",
});
```

```python Python
from evolve import managed_secrets, ManagedSecretsClientConfig

store = managed_secrets(ManagedSecretsClientConfig(
    dashboard_url="https://dashboard.evolvingmachines.ai",
))
```

| TypeScript config | Python config | Default |
| --- | --- | --- |
| `apiKey` | `api_key` | `EVOLVE_API_KEY`; required when making a request. |
| `dashboardUrl` | `dashboard_url` | `EVOLVE_DASHBOARD_URL`, then `https://dashboard.evolvingmachines.ai`. |

HTTP failures raise plain `Error` in TypeScript and `RuntimeError` in Python, rather than hosted `EvolveApiError` / `EvolveAPIError`.

## Secret fields

### Metadata, write result, and delete result

Python returns dataclasses. Its metadata uses `allowed_hosts`, `allowed_path_prefixes`, `allowed_methods`, `created_at`, `updated_at`, and `last_used_at` instead of their camelCase TypeScript names. Other fields keep their names. Missing optional `label` / `delivery` is `None` in Python. No result exposes `value`.

```ts Fields
interface ManagedSecretMetadata {
  id: string;
  name: string;
  label?: string;
  delivery?: ManagedSecretDelivery;
  allowedHosts: string[];
  allowedPathPrefixes: string[];
  allowedMethods: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

type ManagedSecretDelivery = "brokered" | "direct";

interface ManagedSecretWriteResult {
  status: "created" | "updated";
  secret: ManagedSecretMetadata;
}

interface ManagedSecretDeleteResult {
  ok: boolean;
  name: string;
  label: string;
}
```

See [attach a stored secret](/sdk-reference/secrets#attach-it-to-a-job) for the job input. Provider API keys are managed separately in the dashboard.
