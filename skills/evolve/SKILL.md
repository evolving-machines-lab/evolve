---
name: evolve
description: Evolve is hosted evaluation for agents (run any model on any agent harness against datasets of Harbor-format tasks, in cloud sandboxes) and an SDK that runs coding agents in sandboxes from TypeScript or Python. Use when the user mentions Evolve, evals, jobs, datasets, trials, checks, analyses, tasks in the Harbor format, or the `evolve` command; when they want to start, watch, compare or download an eval, publish a dataset, write, verify, convert or publish a Harbor-format task, or run an agent in a sandbox from code. Not for browser automation, general shell work, or agent frameworks other than Evolve.
allowed-tools: Bash(evolve:*), Bash(npx evolve:*)
---

# evolve

Hosted evals and the SDK, from the `evolve` command.

Install: `npm i -g @evolvingmachines/sdk`, then `export EVOLVE_API_KEY=<your key>` (create a key at https://dashboard.evolvingmachines.ai/api-keys).

## Start here

This file is a pointer, not the manual. The manual ships inside the CLI and always matches the installed version. Before running any `evolve` command, load it:

```bash
evolve skills get evals                        # the index of the documentation: every page, one line each
evolve skills get evals core-concepts/tasks    # one page, by its site path
evolve skills get evals --full                 # every page at once; only when everything is needed
```

Read the index first, then the page for your topic, then write the command. Every verb also answers `evolve <verb> --help`.

## The other skills

```bash
evolve skills get agents           # the SDK: run agents (Claude, Codex, Gemini, ...) in sandboxes from TypeScript or Python
evolve skills get create-task      # write a new task in the Harbor format, verifier included
evolve skills get rewardkit        # write a task's verifier with Reward Kit
evolve skills get create-adapter   # convert an existing benchmark into a folder of Harbor-format tasks
evolve skills get publish          # publish a dataset of tasks, or upload a job you ran elsewhere
```

`evolve skills list` names everything the installed version serves; `--full` on any skill adds its reference files.

## Inside the evolve repository

An agent working in a checkout of https://github.com/evolving-machines-lab/evolve reads the same content from `skill-data/<name>/SKILL.md` directly; nothing needs to be installed.
