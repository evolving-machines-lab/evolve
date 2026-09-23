---
title: "Create your first task"
description: "Write a task, publish it, check its quality, and run one managed evaluation."
---

Build a task that asks an agent to write one file. Publish it as a dataset, then inspect the agent's answer and score.

First, [install the CLI and set a full-access API key](/getting-started/installation). The task check and evaluation run remotely and incur usage.

## 1. Create the task folder

Start in a fresh working directory:

```bash
mkdir -p \
  my-eval/hello-world/environment \
  my-eval/hello-world/tests \
  my-eval/hello-world/solution
cd my-eval
```

Create all five files below. Keep `tests/` and `solution/` separate from the environment image.

- my-eval/
  - hello-world/
    - instruction.md
    - task.toml
    - environment/
      - Dockerfile
    - tests/
      - test.sh
    - solution/
      - solve.sh

### hello-world/instruction.md

Tell the agent exactly what to produce.

```markdown
Create this file:

/app/answer.txt

With exactly this text:

Hello, world!

End the file with a newline.
```

### hello-world/task.toml

Give the agent 120 seconds and the verifier 60 seconds. Shared verification reads the file in the agent's sandbox.

```toml
schema_version = "1.4"

[agent]
timeout_sec = 120

[verifier]
timeout_sec = 60
environment_mode = "shared"

[environment]
cpus = 2
memory_mb = 2048
storage_mb = 10240
workdir = "/app"
```

### hello-world/environment/Dockerfile

Include Python for the verifier. Evolve builds this image when you publish.

```dockerfile
FROM python:3.12-slim
WORKDIR /app
```

### hello-world/tests/test.sh

Write reward `1` for the exact answer, or `0` for a wrong or missing file.

```bash
#!/bin/bash
set -uo pipefail
mkdir -p /logs/verifier

if python3 - <<'PYTEST'
from pathlib import Path
answer = Path("/app/answer.txt")
assert answer.read_text() == "Hello, world!\n"
PYTEST
then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
```

The reward file determines the score; the script's exit code alone does not.

### hello-world/solution/solve.sh

Include a reference answer for task-quality review. The evaluated agent does not receive this script as an input.

```bash
#!/bin/bash
printf 'Hello, world!\n' > /app/answer.txt
```

## 2. Validate the metadata

From `my-eval/`, run:

```bash
evolve dataset check .
```

This sends task metadata to Evolve for validation. It does not publish the task, build its image, or run the verifier. Fix any reported refusals before continuing.

## 3. Publish and wait for the build

Choose an available dataset name for your account. Keep these variables for the following commands:

```bash
DATASET="my-first-eval"
VERSION="1.0"

evolve dataset publish \
  --dir . \
  --name "$DATASET" \
  --version "$VERSION" \
  --watch
```

The CLI repeats metadata validation, uploads the task, and follows the import and image build. Continue when the version is `READY` and `hello-world` is listed as built:

```bash
evolve dataset show "$DATASET@$VERSION"
```

Publishing prepares the task to run. It does not evaluate the agent.

## 4. Check task quality

```bash
evolve check \
  -d "$DATASET@$VERSION" \
  -i hello-world \
  --watch
```

This runs a separate checker against the task's instructions, environment, reference solution, and verifier. Save the printed check ID:

```bash
CHECK_ID="paste-check-id-here"
evolve check show "$CHECK_ID"
```

Read the criterion findings, the five execution criteria included. A completed check can contain failures; a clean inspection without execution does not establish that the solution and verifier work. See [task checks](/core-concepts/check#the-result) for interpretation.

If you change any task file, publish a new version and use that version in the remaining commands.

## 5. Run one evaluation

```bash
evolve run \
  -d "$DATASET@$VERSION" \
  -i hello-world \
  -a codex \
  -m gpt-5.6-luna \
  --max-trial-spend 1 \
  --max-retries 0 \
  --watch
```

This creates one trial with a $1 model-spend cap. The cap applies to this evaluation, not the earlier task check; an in-flight model call can finish above it. Configured infrastructure retries are disabled, but provider capacity waits can still occur.

## 6. Inspect the answer and score

Set `JOB_ID` to the job ID printed by `run`:

```bash
JOB_ID="paste-job-id-here"
evolve job show "$JOB_ID"
evolve job trials "$JOB_ID"
```

Set `TRIAL_ID` to the trial ID from that list:

```bash
TRIAL_ID="paste-trial-id-here"
evolve trial show "$TRIAL_ID"
evolve trial trace "$TRIAL_ID"
evolve trial download "$TRIAL_ID" --stream verifier
```

Read the answer if the agent produced it:

```bash
evolve trial files cat "$TRIAL_ID" /app/answer.txt
```

The saved filesystem can still be finishing after the trial settles. If it is not ready yet, retry the read shortly.

| Result | Meaning for this task |
| --- | --- |
| `SCORED`, reward `1` | The answer matched, including the final newline. |
| `SCORED`, reward `0` | The verifier rejected the answer. |
| An execution or scoring error | Inspect the trace and verifier log before interpreting the result. |

A completed job means its trials have settled, not that the task passed. Save the trial record and available logs:

```bash
evolve trial download "$TRIAL_ID" -o ../eval-results/
```

Keep results outside `my-eval/`, so the dataset folder still contains only task directories.

**[Task configuration](/core-concepts/task-config)**

Add resources, network rules, and artifacts.

**[Task verifiers](/core-concepts/task-verifiers)**

Grade richer outputs or use a separate verifier sandbox.
