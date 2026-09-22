---
title: "evolve skills"
description: "Read the bundled manual and install its small entry point for coding agents."
---

The manual ships with the CLI. An agent can read its index, then load just the page it needs.

```bash
evolve skills get evals
evolve skills get evals cli-reference/run
```

```text
Installed pointer: evolve
  ↓
Documentation index
  evolve skills get evals
  ↓
One focused page
  evolve skills get evals PAGE
```

These commands read local package files; they do not call the Evolve API.

## List the bundled skills

```bash
evolve skills
evolve skills list --json
```

| Skill | Purpose |
| --- | --- |
| `evals` | Managed evaluations: concepts, CLI, APIs, and SDKs. |
| `create-task` | Author a Harbor-format task. |
| `rewardkit` | Write a verifier with Reward Kit. |
| `create-adapter` | Convert a benchmark into tasks. |
| `publish` | Publish task datasets or import completed results. |

The root `evolve` pointer is available by explicit name but hidden from the list. The managed-agents SDK skill is separate; it is not served by this command.

## Read a skill or page

```bash
evolve skills get create-task
evolve skills get create-task rewardkit
evolve skills get evals core-concepts/tasks
```

| Option | Meaning |
| --- | --- |
| `--full` | Include all files under the skill's references and templates. |
| `--all` | Read every listed skill without supplying names. |

`get <skill> <page>` accepts the page path with or without `.md`/`.mdx`. It cannot combine with `--full`. `--all` cannot combine with skill names.

Prefer the index and focused pages. Use `--full` when the complete reference is needed.

## Find files on disk

```bash
evolve skills path
evolve skills path evals
```

The optional skill name selects its folder. `EVOLVE_SKILLS_DIR` can point to a different skills directory for local development.

## Install the pointer

```bash
evolve skills install
evolve skills install --target codex
```

Only the small `evolve/SKILL.md` pointer is installed. The full manual stays in the CLI package.

| Option | Meaning |
| --- | --- |
| `--target <name>` | `claude`, `codex`, `cursor`, `copilot`, `gemini`, `opencode`, `agents`, or `all`. Default `all`. |
| `--path <dir>` | Your own skills directory instead of a named target. |
| `--force` | Replace an installed pointer whose contents differ. |

`all` installs into agent homes that already exist. A named target may create its directory. Existing identical pointers are left alone; differing content requires `--force`.

`--target` and `--path` cannot be combined. [Global options](/cli-reference/index#global-options), including JSON output, apply.
