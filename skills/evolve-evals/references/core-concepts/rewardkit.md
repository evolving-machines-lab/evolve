---
title: "Reward Kit"
description: "Combine reusable checks, custom Python, and model judges into reward scores."
---

Reward Kit is the `harbor-rewardkit` Python package. It discovers checks in `tests/`, runs them against the agent's workspace, and writes a reward plus detailed findings.

This guide uses the published **0.2.1** package.

| Use | For |
| --- | --- |
| Built-in checks | Files, commands, JSON, CSV, databases, HTTP, and images |
| Custom Python | Rules specific to your task |
| Model judges | Criteria that need a written assessment |

## Build a deterministic verifier

Start with [your first task](/getting-started/first-task). Keep its instruction, `task.toml`, and solution. Replace the environment Dockerfile and test files with these four files.

This example uses shared verification and requires the exact answer, including its final newline.

- hello-world/
  - environment/
    - Dockerfile
  - tests/
    - test.sh
    - checks.py
    - reward.toml

### environment/Dockerfile

Install Reward Kit when the image builds. Python 3.12 or newer is required; no package download is needed during verification.

```dockerfile
FROM python:3.12-slim
RUN pip install --no-cache-dir \
    'harbor-rewardkit==0.2.1'
WORKDIR /app
```

### tests/checks.py

Combine a built-in file check with one custom criterion.

```python
from pathlib import Path
import rewardkit as rk

rk.file_exists("answer.txt")

@rk.criterion
def exact_answer(
    workspace: Path,
) -> bool:
    path = workspace / "answer.txt"
    if not path.is_file():
        return False
    expected = "Hello, world!\n"
    actual = path.read_text()
    return actual == expected
```

### tests/reward.toml

Require both checks in `checks.py` to pass.

```toml
[scoring.checks]
aggregation = "all-pass"
```

### tests/test.sh

Run the installed package against `/app` and write the standard reward file.

```bash
#!/bin/bash
set -euo pipefail
python3 -m rewardkit /tests \
  --workspace /app \
  --output \
  /logs/verifier/reward.json
```

The exact answer scores `1`. A missing file, different text, or missing final newline scores `0`.

Reward Kit also writes `reward-details.json` beside `reward.json`, with the individual checks and their results. Use the [first-task workflow](/getting-started/first-task#2-validate-the-metadata) to validate, publish, check, and evaluate this version.

## Write your own checks

A criterion receives `workspace: Path` and returns a boolean or number. The example's function has no other arguments, so `@rk.criterion` registers it automatically.

For reusable criteria with additional arguments, register each check through `rk`:

```python tests/lines.py
from pathlib import Path
import rewardkit as rk

@rk.criterion
def has_lines(
    workspace: Path,
    count: int,
) -> bool:
    path = workspace / "answer.txt"
    if not path.is_file():
        return False
    lines = path.read_text().splitlines()
    return len(lines) >= count

rk.has_lines(5, weight=2.0)
rk.has_lines(10, weight=1.0)
```

Handle expected failures by returning `False` or `0`. An unhandled exception aborts the verifier; it does not become a failed criterion automatically.

**Note:** `file_matches()` ignores leading and trailing whitespace. Use a custom check, as above, when exact whitespace matters.

## Built-in criteria

Call these through `rk`. File, data, and image paths resolve from `--workspace`; absolute paths stay absolute. All checks also accept `weight=1.0`, a custom `name`, and `isolated=False`.

### Files and text

- `file_exists(path)` and `file_not_exists(path)`: test whether a path exists. Directories count too.

- `file_contains(path, text)`: find a literal substring.

- `file_contains_regex(path, pattern)`: find a Python regular-expression match.

- `file_matches(path, expected)`: compare text after trimming both ends.

- `files_equal(path1, path2)`: compare two text files after trimming both ends.

- `diff_ratio(path, expected)`: return a text-similarity ratio from `0` to `1`, after trimming both ends.

### Commands

All four take `cmd`, optional `cwd`, and `timeout=30` seconds. The default working directory is the workspace.

- `command_succeeds(cmd)`: require exit code `0`.

- `command_output_contains(cmd, text)`: find a substring in stdout.

- `command_output_matches(cmd, expected)`: compare stdout after trimming both ends.

- `command_output_matches_regex(cmd, pattern)`: search stdout with a Python regular expression.

Output checks inspect stdout regardless of the exit code. A timeout fails the check.

### JSON, tables, and databases

- `json_key_equals(path, key, expected)`: compare a top-level JSON object key.

- `json_path_equals(path, json_path, expected)`: follow dot-separated keys and list indices, such as `items.0.name`. This is not JSONPath syntax.

- `csv_cell_equals(path, row, col, expected)`: compare a string cell. Indices start at `0`. A named column treats the first row as a header; an integer column counts that header as row `0`.

- `xlsx_cell_equals(path, cell, expected, sheet=None)`: compare a cell such as `A1`. Defaults to the active sheet and reads cached formula values. Requires the `documents` extra.

- `sqlite_query_equals(db_path, query, expected)`: compare the first column of the first result row.

### HTTP and images

- `http_status_equals(url, status=200)`: send a GET request and compare its status, including HTTP error statuses.

- `http_response_contains(url, text)`: find text in a GET response body. Request errors fail the check. Both HTTP criteria accept `timeout=10` seconds and require network access to the URL.

- `image_size_equals(path, width, height)`: compare pixel dimensions.

- `image_similarity(path1, path2)`: return the fraction of exactly matching RGBA pixels; different dimensions score `0`. Both image criteria require the `image` extra.

### Agent trajectories

Supply an ATIF JSON file in the verifier sandbox and pass its `path`. Do not assume an exported trial trace is already present there.

- `trajectory_tool_used(tool_name, min_count=1)`: require at least this many calls with the matching function name.

- `trajectory_tool_not_used(tool_name)`: require no matching calls.

- `trajectory_turn_count(max_turns)`: score `1` within the agent-turn limit, then decrease linearly to `0` at twice the limit. Use a positive limit.

All three accept `path`; the package default is `/logs/agent/trajectory.json`. A missing trajectory fails the check, including `trajectory_tool_not_used`.

`isolated=True` needs working overlayfs support in the verifier environment. Installing Reward Kit alone does not provide that capability.

## Combine scores

Each Python file that registers checks and each judge TOML produces a score. Criteria use a weighted mean by default, with weight `1` each.

| Configuration | Controls |
| --- | --- |
| `[scoring.checks]` in `reward.toml` | Criteria in `checks.py` |
| `[scoring]` in a judge TOML | Criteria in that judge file |
| Named `[[reward]]` in root `reward.toml` | Combined output score |

| Aggregation | Result |
| --- | --- |
| `weighted-mean` | Weighted average |
| `weighted-sum` | Sum of score × weight, without normalization |
| `all-pass` | `1` when every score is greater than `0` |
| `any-pass` | `1` when any score is greater than `0` |
| `threshold` | `1` when the weighted mean reaches `threshold`, default `0.5` |
| `required-pass` | `1` when every non-optional criterion scores above `0`; requires at least one |

With only files directly under `tests/`, Reward Kit combines their scores into `reward`. A judge file can set `[judge].weight`; otherwise each file has equal weight.

### Keep separate dimensions and a primary reward

Subfolders expose separate score keys. For example, use this layout to keep correctness and quality visible:

- tests/
  - test.sh
  - reward.toml
  - correctness/
    - checks.py
  - quality/
    - judge.toml

In the root `tests/reward.toml`, add a named aggregation:

```toml
[[reward]]
name = "reward"
aggregation = "weighted-mean"

[reward.weights]
correctness = 3
quality = 1
```

This keeps the two dimensions and adds their weighted mean under `reward`.

Evolve reads `reward` as the primary score, or the only value in a one-key result. Multiple dimensions without `reward` remain available as metrics but have no primary score.

Keep the primary score within `[0, 1]`. Reward Kit does not clamp custom numbers or `weighted-sum` results; an out-of-range primary score becomes `SCORING_ERROR` on Evolve.

## Add a model judge

For a task that produces `/app/report.md`, a judge can assess the explanation. Install Reward Kit in the image as above, then add this file beside the programmatic checks:

```toml tests/judge.toml
[judge]
judge = "anthropic/claude-sonnet-4-6"
files = ["/app/report.md"]
timeout = 120

[[criterion]]
name = "clear-conclusion"
description = """
Does the report state a clear conclusion?
"""
type = "binary"

[[criterion]]
name = "supports-conclusion"
description = """
How well does the report support
its conclusion with evidence?
"""
type = "likert"
points = 5
weight = 2.0
```

Give the verifier enough time and request the judge credential in `task.toml`. Update the existing `[verifier]` table rather than adding a second one:

```toml task.toml
[verifier]
environment_mode = "shared"
timeout_sec = 180

[verifier.env]
ANTHROPIC_API_KEY = "${ANTHROPIC_API_KEY}"
```

Write the template literally. Evolve supplies a scoped gateway credential and base URL at verification time; you do not place a provider key in the task. Judge calls incur usage and can reach the gateway under `no-network`.

Automatic credential detection reads judge TOMLs at the root of a flat `tests/` folder, or one level below it when subfolders exist. Reward Kit itself discovers deeper layouts; keep the explicit credential request above when using them.

| Judge value | Managed support |
| --- | --- |
| `anthropic/<model>` | Anthropic-family LLM judge |
| `openai/<model>` | OpenAI-family LLM judge; request `OPENAI_API_KEY` instead |
| `claude-code` or `codex` | Agent judge; also set `model` and provide its CLI in the verifier image |

Use [separate verification](/core-concepts/task-verifiers#separate-verification) when the verifier needs its own image. Declare the report in `artifacts` so it reaches that sandbox. The managed judge path does not provide verifier MCP tools or arbitrary provider credentials.

### Judge options

| Option | Behavior |
| --- | --- |
| `type = "binary"` | Yes/no becomes `1`/`0` |
| `type = "likert"`, `points = 5` | A 1–5 rating becomes a score in `[0, 1]` |
| `type = "numeric"`, `min`, `max` | Normalize the chosen numeric range to `[0, 1]` |
| `[judge].mode = "individual"` | Grade each criterion separately; allows per-criterion `files` for LLM judges |

The default mode is `batched`. A criterion without its own files uses `[judge].files`.

### Additional judge and criterion options

In `[judge]`:

| Option | Meaning |
| --- | --- |
| `timeout` | Response limit in seconds; default `300` |
| `reasoning_effort` | LLM reasoning setting; default `medium` |
| `reference` | File or directory supplied as reference material to an LLM judge |
| `atif-trajectory` | Path to an ATIF file available inside the verifier |
| `prompt_template` | `.txt` or `.md` path relative to the judge TOML; must contain `{criteria}` |
| `weight` | This judge file's weight when combined with other files; default `1` |
| `cwd` | Agent judge's working directory; defaults to the workspace |
| `version` | Agent CLI version to use |
| `isolated` | Agent workspace isolation; default `false`, requires overlayfs support |

In each `[[criterion]]`, `name` identifies the result and `description` defines the check. `weight` defaults to `1`. `negate = true` changes the score to `1 - score`. `optional = true` excludes that criterion from `required-pass`; other aggregations still include it.

Keep the task's verifier timeout long enough for the judge. Agent CLIs must be available in the verifier environment; a blocked runtime installer cannot supply them under `no-network`.

For a per-job override, use `--ve REWARDKIT_JUDGE=<judge>` with `evolve run`. `--ve REWARDKIT_MODEL=<model>` selects the model for an agent judge. These are the only two job-level verifier environment overrides; request the matching provider credential family in the task.

## Dependencies and network access

| Need | Install in the verifier's image |
| --- | --- |
| Core checks and text judges | `harbor-rewardkit==0.2.1` |
| PDF, DOCX, PPTX, or XLSX support | `harbor-rewardkit[documents]==0.2.1` |
| Image criteria | `harbor-rewardkit[image]==0.2.1` |

Evolve stages an offline Reward Kit bundle for judge-enabled runs, not for every deterministic verifier. It contains the base package and dependencies, not optional extras. The bundled `uvx --from harbor-rewardkit...` path cannot fetch a Reward Kit version or extra absent from that bundle.

Installing the package in the image and using `python3 -m rewardkit` makes the dependency choice explicit. HTTP checks and other external calls still need [network access](/core-concepts/task-config#network-access) to their destinations.

**[Verifier environments](/core-concepts/task-verifiers)**

Choose shared or separate verification and transfer the required files.

**[Reward Kit skill](/cli-reference/skills)**

Load `evolve skills get rewardkit` for an agent authoring a verifier.
