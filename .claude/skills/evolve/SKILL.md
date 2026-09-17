---
name: evolve
description: "Evolve runs agent evaluations in the cloud: any model on any coding-agent harness (Claude Code, Codex, Gemini and more) against datasets of Harbor-format tasks, such as terminal-bench or SWE-bench style benchmarks, plus an SDK that runs those agents in sandboxes from TypeScript or Python. Use this skill whenever the user names Evolve or the `evolve` command, or wants to benchmark, evaluate, score or compare models or agent harnesses, start or watch an eval job, browse or publish a dataset of tasks, read trials, traces, rewards, checks or analyses, write, verify, convert or publish a task in the Harbor format (task.toml, verifier, Reward Kit, rubric), or run a coding agent in a sandbox from code, even when the word Evolve is not said. Not for browser automation, ordinary shell or git work, a data table in pandas or SQL, or agent frameworks other than Evolve."
allowed-tools: Bash(evolve:*), Bash(npx evolve:*)
---

# evolve

Hosted evals and the SDK, from the `evolve` command.

Install: `npm i -g @evolvingmachines/evolve`, then `export EVOLVE_API_KEY=<your key>` (create a key at https://dashboard.evolvingmachines.ai/api-keys).

Python SDK: `pip install evolvingmachines-evolve` (`import evolve`). The manual still comes from the `evolve` command.

## Start here

This file is a pointer, not the manual. The manual ships inside the CLI and always matches the installed version. Keep it current: `npm i -g @evolvingmachines/evolve@latest`, then `evolve skills install --force` refreshes this file. Before running any `evolve` command, load it:

```bash
evolve skills get evals                        # the index of the documentation: every page, one line each
evolve skills get evals core-concepts/tasks    # one page, by its site path
evolve skills get evals --full                 # every page at once; only when everything is needed
```

Read the index first, then the page for your topic, then write the command. Every verb also answers `evolve <verb> --help`.

## The other skills

```bash
evolve skills get create-task      # write a new task in the Harbor format, verifier included
evolve skills get rewardkit        # write a task's verifier with Reward Kit
evolve skills get create-adapter   # convert an existing benchmark into a folder of Harbor-format tasks
evolve skills get publish          # publish a dataset of tasks, or upload a job you ran elsewhere
```

`evolve skills path evals` prints the folder on disk, so you can read the pages with your own tools. `evolve skills list` names everything the installed version serves; `--full` on any skill adds its pages. The SDK skill (run agents in sandboxes from TypeScript or Python) is not served by the command; install it from the repository: `npx skills add evolving-machines-lab/evolve --skill evolve-agents`.

## Inside the evolve repository

An agent working in a checkout of https://github.com/evolving-machines-lab/evolve reads the same content directly from `skills/<name>/SKILL.md` (`evolve-evals` is the evals index, its pages under `references/`); nothing needs to be installed.
