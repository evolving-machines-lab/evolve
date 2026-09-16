---
name: create-adapter
description: Convert an existing benchmark into a folder of Harbor-format tasks ready for `evolve dataset publish`. Use when the user wants to port, adapt, or import a benchmark (a paper's task set, a repository of problems, a leaderboard's dataset) onto Evolve. Guides the conversion and its verification with evolve check.
---

# Create Adapter

An adapter is a small program that reads an existing benchmark and writes one task
directory per task, in the Harbor task format. Its output is a folder of tasks, ready for
`evolve dataset publish`. This skill guides the conversion; the `create-task` skill has
the task format in full, and the `publish` skill has every publish option.

## Authoritative reference

The conversion rules below produce Harbor-format tasks, which Evolve runs unchanged.
The task format itself is at https://docs.evolvingmachines.ai/core-concepts/tasks.

Do not invent structure, field names, or workflow beyond what the guide specifies.

## Prerequisites

- The `evolve` CLI: `npm install -g @evolvingmachines/sdk` (`evolve --version` succeeds).
- `EVOLVE_API_KEY` exported, from the dashboard's API keys page
  (https://dashboard.evolvingmachines.ai/api-keys); `evolve auth status` prints who you are.
- Docker, to build and enter a task's environment locally (optional).
- The upstream benchmark's repository, cloned.

## Workflow

### 1. Understand the original benchmark

Identify these four components for every task in the benchmark:

| Component | What to find |
|-----------|-------------|
| **Instructions** | How tasks are described; what information agents receive |
| **Environments** | Docker setup, system dependencies, file structures |
| **Tests** | Evaluation method: deterministic unit tests, LLM-as-a-Judge, etc. |
| **Solutions** | Oracle/reference solutions; if none exist, whether LLM generation is feasible |

Study the benchmark's repository, documentation, and code structure.

**Step complete when:** you can describe, for each task, the instruction text,
environment setup, test/verification method, and reference solution.

### 2. Gather benchmark context from the user

Collect the following before writing code. If the user has not provided an item, ask
before proceeding.

| Field | Why it matters |
|-------|---------------|
| Adapter name | Lowercase, hyphen-separated. Must match the benchmark's common identifier (e.g., `swe-bench`, `aider-polyglot`). Becomes the dataset name on Evolve and, with dashes turned to underscores, the Python package name. |
| Human-readable name | Appears in the README. |
| Upstream repo URL | Needed for step 1 (benchmark analysis) and for the README. |
| Reference solutions available? | If the benchmark ships reference solutions, use them. If not, they must be written, with LLM help, before the tasks can be checked. |
| Subset | Adapting a subset of tasks is acceptable (e.g., only a verified split). Document every exclusion in the README. |

### 3. Write the converter

The `evolve` CLI has no adapter scaffold; create this layout by hand:

```
<adapter-name>/
├── README.md                  # final documentation (step 6)
├── pyproject.toml             # Python package config
└── src/
    └── <adapter_name>/        # adapter-name with dashes → underscores
        ├── __init__.py
        ├── adapter.py         # main logic: parse benchmark, generate task dirs
        ├── main.py            # CLI entry point
        └── task-template/     # template files copied into each task
            ├── task.toml
            ├── instruction.md
            ├── environment/
            │   └── Dockerfile
            ├── solution/
            │   └── solve.sh
            └── tests/
                └── test.sh
```

`main.py` must support `--output-dir` (where generated tasks are written), `--limit`,
`--overwrite`, and `--task-ids`. Run it as
`uv run python -m <adapter_name>.main --output-dir <path>`.

Each generated task directory must contain at minimum `task.toml`, `instruction.md`,
`environment/Dockerfile`, `solution/solve.sh`, and `tests/test.sh`:

```
<output-dir>/
└── <task-id>/
    ├── task.toml              # task configuration and metadata
    ├── instruction.md         # task instructions for the agent
    ├── environment/
    │   └── Dockerfile         # container environment definition
    ├── solution/
    │   └── solve.sh           # reference solution script
    └── tests/
        ├── test.sh            # test execution script
        └── test_*.py          # (optional) pytest test files
```

**`task.toml`:** every task must include it. Adjust timeouts to match your benchmark's
complexity.

```toml
schema_version = "1.4"

[task]
name = "<adapter-name>/<task-id>"
version = "1.0.0"

[metadata]
author_name = "Original benchmark authors' names"
author_email = "benchmark-authors@email.com"
difficulty = "medium"
category = "programming"
tags = ["debugging", "python"]

[agent]
timeout_sec = 1800.0

[verifier]
timeout_sec = 120.0

[environment]
build_timeout_sec = 600.0
cpus = 1
memory_mb = 2048
storage_mb = 10240
```

For LLM-as-a-Judge verifiers, request the judge credential in `[verifier.env]`; on Evolve
the value resolves at run time to a short-lived token for that model family, never a real
key (see the `rewardkit` skill):

```toml
[verifier.env]
OPENAI_API_KEY = "${OPENAI_API_KEY}"
```

**`tests/test.sh`:** must write a numeric reward (integer or float, 0 to 1) to
`/logs/verifier/reward.txt`, or named numbers to `/logs/verifier/reward.json`.
`/logs/verifier/` exists at run time. Use the same metrics as the original benchmark.

```bash
#!/bin/bash
pytest /tests/test_*.py
if [ $? -eq 0 ]; then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
```

**`instruction.md`:** write agent-actionable instructions, not raw benchmark
descriptions. Include the goal, constraints, expected output location, and any files the
agent should modify. Do not include test answers or reference solutions. Prompt
modifications (e.g., "write files in place without asking") are acceptable if you apply
them to both the original benchmark and the adapter, and document them.

**`environment/Dockerfile`:** set up the container the agent will work in. Install system
and Python dependencies, copy any benchmark-specific data files, and set the working
directory. The agent and the verifier both run inside this container unless the task
declares a separate verifier environment.

```dockerfile
FROM python:3.13-slim
WORKDIR /workspace

RUN apt-get update && apt-get install -y \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install benchmark-specific dependencies
# RUN pip install --no-cache-dir <packages>

# Copy task-specific files
# COPY . /workspace/
```

**GPU tasks:** set `gpus` (and optionally `gpu_types`) under `[environment]` in
`task.toml`. After publishing, `evolve dataset show` prints which sandbox providers can
run each task.

**Step complete when:** `main.py` produces a valid task directory for each task.

### 4. Keep task names right

- **Every task directory name is the task's name on Evolve.** Letters, digits, `.`, `_`
  and `-`, at most 128 characters, starting with a letter or digit; use lowercase (Harbor's
  convention). Put the same identifier in `[task] name` as `<adapter-name>/<task-id>`. A
  `[metadata] task_id`, when present, must equal the directory name.
- **Task names must be unique within the dataset and stable across adapter runs.** An
  unstable name makes the same task look like a different one on republish. If upstream
  lacks stable identifiers, mint a deterministic scheme in adapter code (e.g.,
  `{dataset}-1`, `{dataset}-2`, ...) derived from a reproducible sort of upstream tasks.
- **Sanitize upstream identifiers** before using them as names: lowercase, replace
  spaces/slashes/special characters with hyphens, avoid leading/trailing separators.
- **Treat `main.py` as the source of truth for task names.** Do not hand-edit generated
  task directories; fix the converter and regenerate.
- Use `schema_version = "1.4"` at the top of `task.toml`; `[task].version` is the task's
  own version and is distinct from it.

### 5. Verify the conversion

Check the generated tasks. The check reads each task and, when it can, runs its
environment, its `solution/solve.sh` and its verifier, then rules on every criterion of a
rubric; every task should come back `no_problem_found` with `executed` true.

```bash
evolve check "<output-dir>" --watch
evolve check show <check-id>
```

A failing check usually means one of three things, in this order:

1. **Adaptation error:** the instruction, environment or test does not match upstream.
2. **A broken reference solution:** run the solution on the original benchmark side too, to
   tell a wrong solution from a wrong adaptation. If the fix is simple, propose it
   upstream and document it in the README; exclude tasks that cannot be reliably fixed.
3. **Environment error:** a Dockerfile that does not build or a test that cannot run makes
   the task impossible for every agent, so catch it here.

Where Harbor is installed, `harbor run -p "<output-dir>" -a oracle` runs every reference
solution locally (optional); the reward should be `1.0` on every task.

**Benchmarks without reference solutions:** write them, with LLM help, before publishing.
A cheap agent and model can take a first pass over all the tasks; complete the rest with
a stronger model plus human review.

**Step complete when:** every task passes `evolve check`.

### 6. Document and publish

Write the README with: what the benchmark measures and a link to it; the subset adapted
and every exclusion; benchmark bugs found and how they were handled; prompt
modifications, environment adjustments and other deviations from the original, with the
reason; known limitations; the exact commands to regenerate the tasks and to run them.

Then publish the output folder as a dataset (the `publish` skill has every option):

```bash
evolve dataset check "<output-dir>"
evolve dataset publish --dir "<output-dir>" --name "<adapter-name>" --version 1.0 --watch
evolve run -d "<adapter-name>@1.0" -a codex -m gpt-5.5 --watch
```

To see how faithful the conversion is, run a job with the same agent and model the
benchmark's own leaderboard reports, and compare the scores.

## What this skill does NOT do

- Implement `adapter.py`, `main.py`, or the task-template files. Those are the
  contributor's work, guided by the rules above.
- Run `evolve check` or publish on its own. Both act on the user's account and need the
  user's explicit intent; a check spends credits (it runs a checker model).

## Failure modes

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| `evolve: command not found` | The CLI is not installed | `npm install -g @evolvingmachines/sdk`. |
| `evolve dataset check` refuses a task by name | Its `task.toml` breaks a rule (a field, a value, a name) | Fix the converter, regenerate, check again. The refusal names the field. |
| A task check comes back `has_a_problem` | One criterion failed | `evolve check show <check-id>` prints the criterion, its explanation and its evidence. |
| Every task fails the check the same way | An error in the task template | Fix `task-template/` in the converter, not the generated tasks. |
