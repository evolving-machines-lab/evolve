---
name: rewardkit
description: Write verifiers for Evolve's Harbor-format tasks using Reward Kit. Use when creating or editing a
  task's tests/ directory, adding grading criteria, setting up LLM/agent judges, or designing 
  verifiers that produce a reward score.
metadata:
  internal: true
---

Help the user write task verifiers with Reward Kit. Reward Kit is a lightweight Python 
package that turns a directory of criteria files into a reward score. Each criterion is a 
Python function call or a TOML judge file; folders become separate rewards.

The package keeps its upstream name, `harbor-rewardkit`. For Evolve's supported
setup and a complete example, read
`evolve skills get evals core-concepts/rewardkit`.

## Setup in a task

Put criteria alongside `test.sh` in the task's `tests/` directory:

```
tests/
├── test.sh
├── checks.py         # programmatic criteria
└── judge.toml        # optional LLM/agent judge
```

Install the package when the image builds, using Python 3.12 or newer. In shared
mode, add this to `environment/Dockerfile`; in separate mode, install it in the
verifier image:

```dockerfile
RUN pip install --no-cache-dir \
    'harbor-rewardkit==0.2.1'
```

Then write `tests/test.sh`:
```bash
#!/bin/bash
set -euo pipefail
python3 -m rewardkit /tests \
  --workspace /app \
  --output /logs/verifier/reward.json
```

This runs all criteria in `/tests/` against the workspace at `/app` and writes 
`/logs/verifier/reward.json`. Adjust `--workspace` if the task uses another directory.

Run `evolve check "<task-path>" --watch` for task quality review. The checker may
run the reference solution and verifier when its environment supports them;
inspect its findings and evidence. The five execution criteria say whether it
ran the task; `unknown` on them is not proof that the solution or verifier
ran. Read
`evolve skills get evals core-concepts/check` for the result semantics.

If judge criteria need API keys, request them through `task.toml`:
```toml
[verifier.env]
ANTHROPIC_API_KEY = "${ANTHROPIC_API_KEY}"
```

Write the template literally as the whole value. Evolve supplies a scoped gateway
credential and base URL during verification. Set the judge model explicitly in
the TOML. Use `OPENAI_API_KEY` instead for an OpenAI-family judge.

On a job, `--ve REWARDKIT_JUDGE=<judge>` overrides the judge and
`--ve REWARDKIT_MODEL=<model>` selects an agent judge's model. These are the only
two job-level verifier environment overrides. Read
`evolve skills get evals cli-reference/run` for CLI options or
`evolve skills get evals sdk-reference/methods/jobs` for the Python and TypeScript
`start` inputs.

Ask whether Reward Kit should run in the agent's shared environment or in a
separate verifier environment. Prefer a separate verifier environment when judge
prompts, grading dependencies, API keys, or clean-room checks should not be
available to the agent:

```toml
[environment]
network_mode = "no-network"   # Agent can reach the Evolve model gateway

[verifier]
environment_mode = "separate"

[verifier.environment]
network_mode = "no-network"   # Native judge calls use Evolve's gateway
# With no docker_image, build the verifier from tests/Dockerfile.
```

In shared mode, the verifier runs in the agent container and inherits
`[environment].network_mode`. A `[verifier].network_mode` that differs from that
baseline is refused at import on Evolve, because a shared verify cannot switch
egress. If agent and verifier need different network access, use
`environment_mode = "separate"` and set `[verifier.environment].network_mode`.

Evolve's native judge gateway is reachable with `no-network`. Other external
APIs need a `public` baseline or the required hosts in the verifier allowlist.
Programmatic checks that only read local files can also use `no-network`.

In separate mode with no `[verifier.environment].docker_image`, `tests/` is the
verifier image's build context and its `tests/Dockerfile` must provide
`/tests/test.sh`. When the verifier pins the task's own image, the platform
uploads `tests/` to `/tests` instead. When it pins a distinct image, that image
boots as it is with nothing uploaded, so it must carry `/tests/test.sh` itself.

For separate verification, declare the files to grade in the task's `artifacts`
list. The verifier does not receive the agent's whole workspace. Read
`evolve skills get evals core-concepts/task-verifiers` and
`evolve skills get evals core-concepts/task-config` for Evolve's file-transfer and
network rules.

## Programmatic criteria

Call built-ins from any `.py` file in `tests/`:

```python
import rewardkit as rk

rk.file_exists("output.txt")
rk.file_contains("output.txt", "hello")
rk.command_succeeds("python main.py", weight=2.0)
rk.json_key_equals("result.json", "status", "ok")
```

All criteria accept `weight` (default `1.0`) and `isolated` (default `False`, runs in 
overlayfs so side effects don't leak).

Isolation needs working overlayfs support. If the image needs `fuse-overlayfs`,
install it at build time; do not rely on its runtime installer with restricted
network access. Confirm the sandbox permits the required mounts.

### Available built-ins

- **Files**: `file_exists`, `file_not_exists`, `file_contains`, `file_contains_regex`, 
  `file_matches`, `files_equal`, `diff_ratio`
- **Commands**: `command_succeeds`, `command_output_contains`, `command_output_matches`, 
  `command_output_matches_regex` (30s default timeout, optional `cwd`)
- **Data**: `json_key_equals`, `json_path_equals`, `csv_cell_equals`, `xlsx_cell_equals` 
  (needs `[documents]` extra), `sqlite_query_equals`
- **HTTP**: `http_status_equals`, `http_response_contains`
- **Images**: `image_similarity`, `image_size_equals` (needs `[image]` extra)
- **Trajectory**: `trajectory_tool_used`, `trajectory_tool_not_used`, `trajectory_turn_count`

Install needed extras in that same image: `harbor-rewardkit[documents]==0.2.1`
or `harbor-rewardkit[image]==0.2.1`. Use `[all]` only if both are needed.

Do not depend on downloading packages during verification. Evolve's offline
Reward Kit bundle is for judge-enabled runs and does not include optional
extras. Its `uvx` path cannot fetch versions or extras absent from the bundle.

## Custom criteria

Use the `@criterion` decorator. First parameter is always `workspace: Path`. Returns 
`bool` or `float`:

```python
from pathlib import Path
from rewardkit import criterion

@criterion
def has_valid_output(workspace: Path) -> bool:
    return (workspace / "output.txt").read_text().strip() != ""
```

Zero-parameter criteria auto-register. Criteria with extra args must be called via `rk`:

```python
@criterion(description="output has at least {n} lines")
def has_n_lines(workspace: Path, n: int) -> bool:
    return len((workspace / "output.txt").read_text().splitlines()) >= n

rk.has_n_lines(10, weight=2.0)
rk.has_n_lines(50, weight=1.0)
```

For criteria shared across reward subdirs, define with `shared=True` in a root-level file 
and call from subdirs.

## Judge criteria (LLM or agent-as-a-judge)

For subjective checks (quality, readability, edge cases), create a TOML file:

```toml
[judge]
judge = "anthropic/claude-sonnet-4-6"
files = ["/app/main.py"]

[[criterion]]
description = "Is the code correct?"
type = "binary"

[[criterion]]
description = "How readable is the code?"
type = "likert"
points = 5
weight = 2.0
```

Criterion types:
- `binary` — yes/no → 1.0 or 0.0
- `likert` — 1..points, normalized to [0, 1]
- `numeric` — min..max, normalized to [0, 1]

### Agent judges

Agent judges shell out to a CLI and can explore the filesystem:

```toml
[judge]
judge = "claude-code"
model = "anthropic/claude-sonnet-4-6"
isolated = true

[[criterion]]
description = "Does the solution handle edge cases?"
type = "binary"
```

Slower and more expensive than LLM judges, but they can run commands and inspect files.

Evolve supports `claude-code` and `codex` agent judges. Install the selected CLI
in the verifier image and request its matching provider credential. The managed
judge path does not supply verifier MCP tools or arbitrary provider credentials.

### Useful `[judge]` options

`timeout` (default 300), `reasoning_effort` (`low`|`medium`|`high`), `reference` (path to 
reference solution), `atif-trajectory` (evaluate the agent's trajectory), `weight`, 
`prompt_template` (custom prompt with `{criteria}` placeholder).

### Scoring aggregation (within one judge TOML)

```toml
[scoring]
aggregation = "all-pass"   # weighted-mean | weighted-sum | all-pass | any-pass | threshold | required-pass
threshold = 0.7             # only for threshold
```

Only affects how this file's own criteria combine. To aggregate *across*
dimensions, see [Aggregating dimensions](#aggregating-dimensions).

### Scoring config for programmatic files

Each `.py` file that registers criteria is an equal-weighted scoring component
named after its filename stem. Files that only provide imports or shared
criterion factories and register no checks are ignored. To change how criteria
within a file combine, use `[scoring.<stem>]` in the same directory's
`reward.toml`:

```toml
# tests/structure/reward.toml
[scoring.files_exist]       # configures files_exist.py
aggregation = "all-pass"

[scoring.behavior]          # configures behavior.py
aggregation = "threshold"
threshold = 0.75
```

Each entry takes the same aggregation values as a judge TOML. Unknown keys and
stems that do not resolve to a criterion-bearing Python file raise.

Directories may be nested recursively. A non-root directory can aggregate its
local Python files, local judges, and immediate child directories with one
unnamed `[[reward]]` table:

```toml
# tests/correctness/reward.toml
[[reward]]
aggregation = "weighted-mean"
weights = { files = 2.0, behavior = 1.0 }
```

Membership is implicit. Child directories have weight 1.0 unless overridden;
use filename stems for local Python files and judge TOMLs, and directory names
for child groups. Without `[[reward]]`, the directory defaults to weighted mean.

## Multi-reward tasks

Put criteria in subdirectories — each becomes a separate reward:

```
tests/
├── test.sh
├── correctness/
│   └── check.py
├── structure/
│   └── files_exist.py
└── quality/
    └── quality.toml
```

Judge TOMLs may also sit directly at the tests root alongside reward
subdirectories. Each is exposed as a top-level reward named after its filename
stem and can be referenced by a root aggregation.

Criterion-bearing Python files at the tests root are also top-level dimensions
named after their stems. Root support files that register no criteria are
ignored.

Produces:
```json
{ "correctness": 0.75, "structure": 1.0, "quality": 0.6 }
```

### Aggregating dimensions

To add aggregated scores on top of the per-dimension keys, add a root-level
`tests/reward.toml` with one or more `[[reward]]` tables. Each adds one key to
`reward.json`, aggregating the dimensions with the same modes as `[scoring]`:

```toml
# tests/reward.toml
[[reward]]
name = "reward"
aggregation = "all-pass"   # weighted-mean | weighted-sum | all-pass | any-pass | threshold | required-pass
# threshold = 0.7          # only for threshold
weights = { correctness = 2.0, quality = 1.0 }
```

```json
{ "correctness": 0.75, "structure": 1.0, "quality": 0.6, "reward": 0.0 }
```

The per-dimension scores stay; aggregated keys are added alongside them (a
`name` may not collide with a dimension). Top-level dimensions have equal
weight unless that aggregation's inline map overrides them;
`reward-details.json` keeps the full recursive breakdown.

## Output files

- `/logs/verifier/reward.json` — per-reward scores
- `/logs/verifier/reward-details.json` — per-criterion results, judge reasoning, errors

Evolve uses `reward` as the primary score, or the only value when there is one
key. Multiple dimensions without `reward` remain metrics but have no primary
score. Keep the primary score in `[0, 1]`.

## Multi-step tasks

Evolve currently requires shared verification for multi-step tasks; separate
verifier environments are rejected.

In a multi-step task, each step has its own `tests/` under
`steps/{name}/tests/`, and the verifier runs once per step. Reward Kit behaves
the same as in a single-step task: for each step it reads `/tests`, runs the
criteria against `/app`, and writes `/logs/verifier/reward.json` for that step.
The platform then aggregates per-step results into a trial-level reward via
`multi_step_reward_strategy` in `task.toml` — aggregation happens *outside*
Reward Kit, so don't try to encode cross-step logic in your criteria.

A task-level `tests/` directory (at the task root) is uploaded to `/tests`
first, then the step's own `tests/` is layered on top (same-name files win).
Put shared helpers (common `checks.py` functions with `shared=True`, fixture
files, a fallback `test.sh`) at the task level, and step-specific criteria
under each step.

Multi-reward subdirectories still work *within* a step: `steps/foo/tests/`
can contain `correctness/`, `structure/`, `quality/` — each produces a
separate reward key for that step, and `multi_step_reward_strategy = "mean"`
averages each key across steps. Use `"final"` when the last step is an
end-to-end check whose rewards already represent the full task.

Read `evolve skills get evals core-concepts/multi-step` for Evolve's supported
step configuration and result layout.

## When to reach for what

- **Use built-ins** for file existence, string matches, command output, JSON/CSV checks, 
  HTTP probes.
- **Use `@criterion`** when logic is task-specific but still programmatic.
- **Use LLM judges** for subjective quality dimensions (readability, correctness of prose).
- **Use agent judges** when the rubric requires exploring the filesystem or running code 
  (e.g. "does the test suite actually pass?").
- **Use subdirectories** when you want separate scores (correctness vs structure vs 
  quality) rather than one blended number.
- **Use `isolated=True`** for any criterion that runs mutating commands, so it doesn't 
  corrupt the workspace for other criteria.

## Working example

Read `evolve skills get evals core-concepts/rewardkit` for a complete verifier,
or `evolve skills get evals getting-started/first-task` for the task's build,
publish, check, and evaluation workflow.
