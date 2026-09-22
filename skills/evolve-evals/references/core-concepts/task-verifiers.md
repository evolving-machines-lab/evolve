---
title: "Task verifier"
description: "Turn the agent's work into a reward you can compare."
---

The verifier runs after the agent. Its entry point is `tests/test.sh`, and its result comes from a reward file.

```text
1. Agent output
   /app/answer.txt
         ↓
2. Run the verifier
   /tests/test.sh
         ↓
3. Read the reward
   /logs/verifier/reward.json
   or /logs/verifier/reward.txt
```

## Write a reward

This verifier checks the [example instruction](/core-concepts/tasks#write-a-clear-instruction):

```bash tests/test.sh
#!/bin/bash
set -uo pipefail
mkdir -p /logs/verifier

if python3 - <<'PYTEST'
from pathlib import Path
assert Path("/app/answer.txt").read_text() == "Hello, world!\n"
PYTEST
then
  echo 1 > /logs/verifier/reward.txt
else
  echo 0 > /logs/verifier/reward.txt
fi
```

The reward file determines the score. The script's exit code alone does not.

| File | Shape |
| --- | --- |
| `reward.txt` | One finite number from `0` to `1` |
| `reward.json` | An object of named finite numbers |

A nonempty `reward.json` takes precedence over `reward.txt`. The primary reward is the `reward` field, or the only field in a one-field object. A primary reward must be in `[0, 1]`.

```json /logs/verifier/reward.json
{"reward": 1, "tests_passed": 12, "tests_total": 12}
```

Multiple metrics without a `reward` key produce a scored trial with no primary reward. That trial cannot contribute a primary success to pass@k.

| Outcome | Trial status |
| --- | --- |
| Valid reward, including `0` | `SCORED` |
| No reward file | `INDETERMINATE` |
| Invalid reward | `SCORING_ERROR` |

## Choose where verification runs

### Shared · default

The verifier runs in the agent's sandbox. It can inspect the filesystem and processes left by the agent. Agent credentials are revoked before verification begins.

```text
One sandbox
┌─────────────────────┐
│ 1. Agent works      │
│         ↓           │
│ 2. Verifier checks  │
└─────────────────────┘
```

```toml task.toml
[verifier]
environment_mode = "shared"
```

Test files are uploaded to `/tests/`. Install verifier dependencies in the task image; a `tests/Dockerfile` is not built in this mode.

### Separate

The verifier starts in a fresh sandbox. Declare the outputs it needs under `artifacts`. Evolve also transfers `/logs/artifacts/` and the collection script’s patch file; it does not copy the whole agent filesystem.

```text
1. Agent sandbox
   /app/answer.txt
         ↓ copy artifact
2. Fresh verifier sandbox
   /app/answer.txt
```

Separate verification supports [regrading eligible trials](/core-concepts/jobs). It is not available for multi-step tasks.

## Separate verification

A verifier with its own Dockerfile keeps grading dependencies out of the agent's image.

```text
my-task/
├── instruction.md
├── task.toml
├── environment/
│   └── Dockerfile
└── tests/
    ├── Dockerfile
    └── test.sh
```

```toml task.toml
artifacts = ["/app/answer.txt"]

[verifier]
environment_mode = "separate"

[verifier.environment]
cpus = 2
memory_mb = 2048
workdir = "/app"
network_mode = "no-network"
```

```dockerfile tests/Dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY . /tests/
```

With `environment_mode` omitted, `[verifier.environment]` selects separate mode. An explicit `environment_mode = "shared"` keeps verification in the agent sandbox.

### How the verifier image is selected

The effective configuration is `[verifier.environment]` when present; otherwise, it copies `[environment]`.

| Effective configuration | Behavior |
| --- | --- |
| No `docker_image` | Build `tests/Dockerfile`; it must provide `/tests/test.sh` |
| Same pinned image as the agent | Reuse that image and upload the task's test files |
| A distinct pinned image | Use that image as-is; it must contain `/tests/test.sh` |

The task source must still contain a nonempty `tests/test.sh`, including when a distinct prebuilt verifier image already contains it.

A `tests/Dockerfile` is not built when the effective configuration pins an image. The import records a `tests_dockerfile_not_built` note if that unused file exists.

## Prepare outputs for collection

Most tasks only need an `artifacts` list. If outputs need preparation after the agent finishes, add `pre_artifacts.sh` at the task root. It runs from the task's working directory.

```bash pre_artifacts.sh
#!/bin/bash
set -euo pipefail
mkdir -p /logs/artifacts
[ -e /logs/artifacts/model.patch ] || : > /logs/artifacts/model.patch
if [ -f /app/summary.json ]; then
  cp /app/summary.json /logs/artifacts/summary.json
fi
```

This example assumes the agent produces `/app/summary.json`. A custom collection script must also provide `/logs/artifacts/model.patch`; it can be empty when the task does not produce a patch. If you omit the script, Evolve prepares that file for you.

### Collect from a service

`[[verifier.collect]]` runs a command before artifact collection. For a [multi-container task](/core-concepts/compose), use `service` to choose the container. For a single container, omit it or use `main`.

```toml task.toml
artifacts = [
  { source = "/tmp/stats.json", service = "api" }
]

[[verifier.collect]]
service = "api"
command = "curl -fsS http://localhost:8000/stats > /tmp/stats.json"
timeout_sec = 60
```

This example assumes an `api` service with a `/stats` endpoint and `curl` installed. Hook failures are logged and do not stop the run. Make the verifier reject missing evidence when it is required for a valid score.

Main-service hooks run before collecting its files. In separate verification, Evolve then stops `main`, runs sidecar hooks, and collects sidecar files. Shared verification keeps the containers running. Sidecar artifacts retain their source paths in the separate verifier.

`timeout_sec` defaults to 60 seconds. Compose hooks can set `user` to choose an existing container user. Single-container hooks do not accept that override.

## Grade with a model

[Reward Kit](/core-concepts/rewardkit) combines reusable checks, custom Python, and model judges.

A verifier can request model access for an LLM judge:

```toml task.toml
[verifier.env]
ANTHROPIC_API_KEY = "${ANTHROPIC_API_KEY}"
```

Evolve supplies a gateway credential and the matching base URL. Recognized credential families are Anthropic and OpenAI; these templates are not job secrets. They also work under `no-network` through the judge gateway.

For a Reward Kit judge, override its agent and model for one job with:

```bash
evolve run -d my-dataset@1.0 -a codex -m gpt-5.6-luna \
  --ve REWARDKIT_JUDGE=claude \
  --ve REWARDKIT_MODEL=sonnet
```

These are the only accepted `--ve` keys. Judge spend is reported separately from agent spend. Its independent cap is the smaller of the agent’s per-trial cap and $5. Judge-enabled trials are not currently regradable.

**Tip:**

Ask a coding agent to load `evolve skills get rewardkit` for verifier authoring guidance. Use `evolve skills get create-task` for the complete task workflow.
