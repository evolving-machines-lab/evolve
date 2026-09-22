---
title: "evolve skill"
description: "Upload skills for evaluated agents and reuse them by reference."
---

Upload a skill folder, then attach it to a job.

```bash
evolve skill upload ./my-skill
evolve run -c job.yaml --skill name:my-skill
```

This singular `skill` group manages uploaded content. To read the CLI's bundled manual, use [`evolve skills`](/cli-reference/skills).

## Upload

```bash
evolve skill upload ./my-skill --org acme
```

`--org <name>` selects the owning organization. Without it, the CLI uses its saved default, then your personal organization.

A directory containing multiple skills can return multiple upload records. Each record has two ways to reference it:

| Reference | Use when… |
| --- | --- |
| `upload:<id>` | You want this exact upload. |
| `name:<skill-name>` | You want the current upload under that name when the job is created. |

Organization members can reference uploaded skills in their jobs. Only the creator can delete an upload.

## List and inspect

```bash
evolve skill list --scope org
evolve skill show name:my-skill
evolve skill show "$SKILL_ID" --json
```

`$SKILL_ID` comes from upload or list output. `show` includes metadata and `SKILL.md`.

`skill list` accepts `--scope <my|shared|org>` and the shared [list options](/cli-reference/index#list-options).

## Delete

```bash
evolve skill delete "$SKILL_ID"
```

A skill referenced by a running job is refused with `skill_in_use`. Past jobs keep their resolved skill records. This command has no confirmation prompt.

[Global options](/cli-reference/index#global-options) apply. See [Skills](/core-concepts/skills) for supported sources and how jobs resolve them.
