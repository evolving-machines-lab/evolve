---
title: "evolve session"
description: "Inspect and share the sessions recorded by managed-agent SDK runs."
---

Sessions come from managed-agent SDK runs. They are separate from evaluation jobs and trials.

```bash
evolve session list
evolve session show "$SESSION_ID"
```

Set `$SESSION_ID` to an ID from the list. These commands inspect recorded sessions; they do not start an agent. To create a session, follow the [agent SDK manual](https://github.com/evolving-machines-lab/evolve/blob/main/docs-agents/index.md).

## Filter the list

```bash
evolve session list --state ended --tag-prefix qa- --scope org
```

| Option | Meaning |
| --- | --- |
| `--scope <my\|shared\|org>` | Records to list. Default `my`. |
| `--state <live\|ended>` | Select live or ended sessions. |
| `--agent <name>` | Select one agent harness. |
| `--tag-prefix <prefix>` | Select tags beginning with this text. |

Shared [list options](/cli-reference/index#list-options) also apply: `--limit`, `--cursor`, `--columns`, `--quiet`, `--no-trunc`, `--no-headers`.

## Share a session

The creator can share by unlisted link or email.

```bash
evolve session share "$SESSION_ID" --link
evolve session share "$SESSION_ID" --email colleague@example.com
evolve session shares "$SESSION_ID"
```

| Option for `share` and `unshare` | Meaning |
| --- | --- |
| `--link` | Enable or disable the unlisted link. |
| `--email <address>` | Add or remove access for this address. Repeatable. |

Supply at least one. Email sharing sends the recipient a link. A session share includes the session, transcript, and trace file.

## Remove access

```bash
evolve session unshare "$SESSION_ID" --link
evolve session unshare "$SESSION_ID" --email colleague@example.com
```

Revoking a link disables it. A later link share creates a new link.

[Global options and ID prefixes](/cli-reference/index) apply. `sessions` is an alias of `session`.
