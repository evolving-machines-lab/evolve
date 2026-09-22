---
name: evolve
description: "Run and inspect managed evaluations with Evolve: models and coding-agent harnesses on Harbor-format tasks. Use for eval jobs, datasets, trials, scores, traces, checks, analyses, task authoring, publishing, and Evolve SDK runs in sandboxes. Not for ordinary shell work, browser automation, or unrelated agent frameworks."
allowed-tools: Bash(evolve:*), Bash(npx evolve:*)
---

# Evolve

Run evaluations in the cloud and inspect the results. This is the entry point; the versioned manual ships inside the CLI.

## Read the relevant page first

```bash
evolve skills get evals                       # documentation index
evolve skills get evals cli-reference/run     # one focused page
evolve run --help                            # installed command options
```

Choose pages from the index. Load `--full` only when the entire reference is needed.

| Task | Starting page |
| --- | --- |
| First evaluation | `getting-started/quick-start` |
| Run or configure a job | `cli-reference/run` |
| Inspect, compare, stop, or retry | `cli-reference/job` |
| Read files, logs, or processes | `cli-reference/filesystem` |
| Check task quality | `cli-reference/check` |
| Analyze completed traces | `cli-reference/analyze` |
| Publish a dataset | `cli-reference/dataset` |
| Import completed results | `cli-reference/upload` |
| Upload a recorded SDK run | `core-concepts/upload-sdk-session` |
| Python or TypeScript client | `sdk-reference/index` |

For example: `evolve skills get evals cli-reference/job`.

## Task-authoring skills

```bash
evolve skills get create-task      # write a Harbor-format task
evolve skills get rewardkit        # write its verifier
evolve skills get create-adapter   # convert a benchmark
evolve skills get publish          # publish tasks or import results
```

`evolve skills list` shows the installed bundle. Plural `skills` reads this manual; singular `skill` uploads content for evaluated agents.

## Setup, when needed

CLI: `npm install -g @evolvingmachines/evolve`. Set `EVOLVE_API_KEY` using a key from https://dashboard.evolvingmachines.ai/api-keys; confirm with `evolve auth status`.

Python: `pip install evolvingmachines-evolve` (`import evolve`). Managed evals references still come from `evolve skills get evals`.

To install this pointer into an agent's skills directory, use `evolve skills install --target <agent>`. Do not reinstall or update the CLI merely to read its manual.

The separate managed-agents SDK skill installs from the repository: `npx skills add evolving-machines-lab/evolve --skill evolve-agents`. It is not served by `evolve skills`.

Inside an Evolve checkout, read `skills/evolve-evals/SKILL.md` and its `references/` directly; no installation is needed.
