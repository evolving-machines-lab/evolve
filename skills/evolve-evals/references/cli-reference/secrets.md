---
title: "evolve secrets"
description: "Store environment secrets and attach them to evaluations by name."
---

Store a value once, then attach its name to a job. Reads return metadata, never the stored value.

```bash
printf %s "$GITHUB_TOKEN" | evolve secrets set GITHUB_TOKEN \
  --delivery brokered \
  --allowed-host api.github.com \
  --allowed-path-prefix / \
  --allowed-method GET
```

Piping the value keeps it out of the command's arguments.

## Choose delivery

| Mode | What enters the sandbox |
| --- | --- |
| `brokered` | A reference used through the credential proxy. The stored value stays outside the sandbox. |
| `direct` | The raw value as an environment variable. |

Brokered secrets use the allowed-host, path, and method constraints. See [Secrets](/core-concepts/secrets) for delivery behavior.

## Store a secret

```bash
printf %s "$SERVICE_TOKEN" | evolve secrets set SERVICE_TOKEN --delivery direct
```

| Option | Meaning |
| --- | --- |
| `--value <value>` | Value to store. If omitted, read piped stdin. One trailing newline is removed from stdin. |
| `--label <label>` | Row label under this name. Default `default`. |
| `--delivery <brokered\|direct>` | Required delivery mode. |
| `--allowed-host <host>` | Allowed hostname or wildcard. Repeatable. |
| `--allowed-path-prefix <path>` | Allowed URL path prefix. Repeatable. |
| `--allowed-method <method>` | Allowed HTTP method. Repeatable. |

Restating the same value can update delivery or scoping. A different value under the same name and label is refused with `secret_exists`; use a new label or delete the old row first.

## Attach it to a job

```bash
evolve run -c job.yaml --secret GITHUB_TOKEN
evolve run -c job.yaml --secret SERVICE_TOKEN@staging=APP_TOKEN
```

The second example selects label `staging` and exposes it under `APP_TOKEN`. See [Run options](/cli-reference/run) for `--secret` and `--secret-inline`.

## List metadata

```bash
evolve secrets list
evolve secrets list --json
```

| Option | Meaning |
| --- | --- |
| `--columns <keys\|all\|help>` | Select metadata columns. |
| `-q`, `--quiet` | Print names, with `:label` for non-default labels. |
| `--no-trunc` | Keep full terminal table cells. |
| `--no-headers` | Omit piped TSV headers. |

There are no pagination flags for this list.

## Delete

```bash
evolve secrets delete SERVICE_TOKEN --label staging
```

`--label <label>` selects a row when a name has multiple labels. Deletion also revokes runtime grants tied to that row. This command has no confirmation prompt.

[Global options](/cli-reference/index#global-options) apply.
