---
name: harbor-task
description: "Convert an existing task, benchmark, script, or repository into a Harbor-compatible Evolve eval task and prove it locally before publishing. Use when someone wants work they already have to be scored by agents. Triggers: (1) Turning a task, dataset, benchmark, or paper into a runnable eval task, (2) Authoring or debugging task.toml, instruction.md, tests/test.sh, environment/Dockerfile, or solution/solve.sh, (3) Choosing verifier mode, network mode, artifacts, or reward shape, (4) Writing a verifier that is hard to fool, or diagnosing one that scores every agent 0, (5) Fixing a dataset import refusal or a task that publishes but never rewards, (6) Building a corpus for evolve dataset publish, (7) Preparing a task for terminal-bench-science or Harbor Hub."
---

# Harbor task conversion

Turn a task someone already has into a task directory that Evolve imports, agents
run, and a verifier scores — Harbor's own format.

**Repo:** https://github.com/evolving-machines-lab/evolve

## When this applies

Someone has work they want scored: a benchmark instance, a script with a known
right answer, a bug with a failing test, a research workflow, a paper's task
family. They want it runnable as an eval.

Not this skill: running or analysing eval **jobs** (that is the `evolve` skill's
hosted-evals reference), or building an application on the SDK.

## Start here

1. **Interview before writing anything** —
   [conversion-playbook.md § Interview](references/conversion-playbook.md#1-interview).
   If "what makes an answer right" has no mechanical answer, stop and say so.
   An unverifiable task is not convertible.
2. **Decide the five** (below).
3. **Scaffold** — `python3 scripts/scaffold_task.py --name my-task --out ./corpus/tasks`.
   It emits a *working* task, not a form.
4. **Write** `instruction.md`, `tests/grader.py`, `solution/solve.sh`.
5. **Prove it** — `scripts/validate_task.py`, then `scripts/goldnull.py`.
6. **Publish** — `evolve dataset publish --dir ./corpus --name X --version 1.0 --watch`.

## The five decisions

Every task answers these. Guessing is what produces tasks that import cleanly and
then score every agent 0.

| Decision | Options | Where |
|---|---|---|
| Environment | `environment/Dockerfile` · pinned `docker_image` · compose | [task-format § Environment sources](references/task-format.md#environment-sources) |
| Network | `no-network` · `allowlist` · `public` | [task-format § Network](references/task-format.md#network) |
| Verifier | `shared` · `separate` (+ `artifacts`) | [task-format § task.toml](references/task-format.md#tasktoml) |
| Reward | binary · gates · weighted · judge | [verifier-patterns](references/verifier-patterns.md) |
| Timeouts | agent / verifier budgets | [task-format § Timeouts](references/task-format.md#timeouts) |

## The acceptance bar

```bash
python3 scripts/validate_task.py path/to/task    # structural lint, no daemon
python3 scripts/goldnull.py     path/to/task     # gold 1.0, null 0.0
```

```
gold: apply solution/, then verify  ->  reward must be 1.0
null: verify with no solution       ->  reward must be 0.0
```

**A task that fails either half is not converted, it is broken.** Gold below 1.0
means the task is unsolvable as written or the verifier is wrong; null above 0
means every agent scores for free. Never publish on the gold run alone — a verifier
that always returns 1.0 passes gold and is worthless.

## Critical constraints

- **The reward file is the verdict, never the exit code.** Write `[0,1]` to
  `/logs/verifier/reward.txt`, or `reward.json` with `"reward"`. `test.sh` must
  still write a verdict when the grader crashes.
  → [verifier-patterns § The contract](references/verifier-patterns.md#the-contract)
- **A `separate` verifier with no top-level `artifacts` list grades a pristine box
  the agent never touched — even the gold solution scores 0.** The single most
  expensive mistake in this format.
  → [task-format § The three rules](references/task-format.md#the-three-rules-that-cause-silent-zeros)
- **A task that declares no `network_mode` gets `public`,** not sealed — and a
  `separate` verifier with no policy of its own inherits it.
  → [task-format § Network](references/task-format.md#network)
- **`task.toml`, `instruction.md` and `tests/test.sh` are required.** A task
  without `tests/test.sh` fails import by name.
- **`docker_image` must be a pinned tag, never `:latest`.**
- **Your declarations decide where the task can run.** A GPU task runs on Modal
  whichever provider the job picked (a recorded degrade, not a silent fallback);
  multi-container runs on e2b and Daytona only, and multi-container plus
  `no-network` is declined everywhere.
  → [task-format § Where your task can run](references/task-format.md#where-your-task-can-run)
- **Never import the agent's code as ground truth** — the grader's copy lives in
  `tests/`, even when it duplicates `environment/`.
  → [verifier-patterns § Making a verifier hard to fool](references/verifier-patterns.md#making-a-verifier-hard-to-fool)
- **Everything in `task.toml`, `instruction.md` and `environment/` is published
  content.** No credentials, no answer keys.
- **A gate the instruction never mentions is a trap, not a task.**

## References

| When to read | File |
|---|---|
| Layout, every `task.toml` field, reward contract, judges, upstream Harbor deltas | [task-format.md](references/task-format.md) |
| The interview, the five decisions, and what to do when the source fights the format | [conversion-playbook.md](references/conversion-playbook.md) |
| Reward shapes, and writing a verifier a capable agent cannot fool | [verifier-patterns.md](references/verifier-patterns.md) |
| Lint, the gold/null pair, publishing, pre-publish checklist | [validation.md](references/validation.md) |
| Two real benchmarks converted end to end | [examples/README.md](examples/README.md) |

## Scripts

| Script | Does |
|---|---|
| [scaffold_task.py](scripts/scaffold_task.py) | Emits a working task skeleton that already passes lint and gold/null |
| [validate_task.py](scripts/validate_task.py) | Offline structural lint — import refusals and silent-zero mistakes |
| [goldnull.py](scripts/goldnull.py) | Runs the gold/null pair; `--docker` for the real image |

Task scripts should honor `${LOGS_DIR:-/logs}` and `${TASK_WORKDIR:-/app}`. The
defaults are the real in-container paths, so it is a no-op under Harbor — and it is
what lets `goldnull.py` test the verifier without a Docker daemon.

## Worked examples

Both pass lint and gold/null; together they are a publishable corpus.

- **[smdd-fragment-assembly](examples/tasks/smdd-fragment-assembly/)** — SMDD-Bench
  molecular design. The source that fits: file in, file out, published pass/fail
  gates. Shows why a source's own reference answer must be checked before it is
  trusted as gold.
- **[made-convex-hull](examples/tasks/made-convex-hull/)** — MADE closed-loop
  materials discovery. The source that fights back: continuous metrics, external
  APIs, and a stateful loop, each resolved by a decision that is written down.
