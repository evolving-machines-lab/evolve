# Validating a converted task

Three checks, cheapest first. Do not publish anything that has not passed the
first two.

## 1. Structural lint (seconds, no daemon)

```bash
python3 skills/harbor-task/scripts/validate_task.py path/to/task
```

Catches the import refusals and the silent-zero mistakes: missing required files,
an unpinned or `:latest` image, more than one environment source, a `separate`
verifier with no `artifacts` list, a `shared` verifier with a `network_mode`
override, a `test.sh` that never writes a reward, a non-trivial `tests/Dockerfile`
on a path where it is not built, and `[verifier.env]` templates that import would
refuse.

Errors exit 1. Warnings never fail the run, but read them — "declares no
`network_mode`" means the task runs on the open internet.

Evolve ships no local task command of its own (`evolve dataset publish` is the
first check a task otherwise gets, and it is server-side), so this is the fast
feedback loop.

## 2. The gold/null pair (the acceptance bar)

```bash
python3 skills/harbor-task/scripts/goldnull.py path/to/task
```

```
gold: apply solution/, then verify  ->  reward must be 1.0
null: verify with no solution       ->  reward must be 0.0
```

**A task that fails either half is not converted, it is broken.**

- **Gold below 1.0** — the task is unsolvable as written, or the verifier is
  wrong. The most common cause is a `separate` verifier whose `artifacts` list
  does not name the path the solution actually writes to, so the verifier grades a
  pristine box.
- **Null above 0** — the environment already contains the answer. Every agent
  scores for free and the task measures nothing.

Never publish on the gold run alone. A verifier that returns 1.0 unconditionally
passes gold and is worthless; only the null run catches it.

### Local mode vs `--docker`

By default the phases run as plain subprocesses against a scratch sandbox, with
`TASK_WORKDIR` and `LOGS_DIR` pointed into it. No daemon required. This exercises
the **verifier logic**, which is where conversion bugs actually live.

For it to work, task scripts must honor those two variables:

```bash
mkdir -p "${LOGS_DIR:-/logs}"/verifier
echo "$reward" > "${LOGS_DIR:-/logs}"/verifier/reward.txt
```

The defaults are the real in-container paths, so this is a **no-op under Harbor** —
it costs nothing and buys a test loop that runs anywhere. `scaffold_task.py` emits
this spelling; keep it when you edit.

With a daemon available, run the real thing too — it is the only check that covers
the image, installed dependencies, and the entrypoint:

```bash
python3 skills/harbor-task/scripts/goldnull.py path/to/task --docker
```

Or by hand:

```bash
docker build -t mytask-env path/to/task/environment
docker run --rm -v "$PWD/path/to/task:/task:ro" mytask-env bash -lc \
  'bash /task/solution/solve.sh && bash /task/tests/test.sh && cat /logs/verifier/reward.txt'
```

## 3. Publish (the real import)

```bash
evolve dataset publish --dir ./my-corpus --name my-corpus --version 0.1 --watch
evolve dataset show my-corpus@0.1
```

Publishing is per-task: a task that survives ends `READY`, one that does not ends
`FAILED` with a typed reason, and the rest are unaffected. `--watch` prints each
task's outcome and a `built N of M tasks — K failed to build` summary. `dataset
show` lists `failed_tasks` with `{code, step, message}`.

Read the import **warnings** even on success — `no_solutions_archived` means the
version permanently lacks its reference-solution record.

Versions are immutable. Fixing a task is a new version, not an edit.

## Checklist before publishing

- [ ] `validate_task.py` exits 0
- [ ] `goldnull.py` reports 1.0 gold and 0.0 null
- [ ] `goldnull.py --docker` agrees, where a daemon is available
- [ ] `instruction.md` is solvable by a domain expert from that file alone
- [ ] `instruction.md` names the exact output path the verifier reads
- [ ] The verifier's network policy is declared, not inherited by accident
- [ ] No secret, answer key, or credential is in `task.toml`, `instruction.md`, or
      `environment/` — all of it is published content
- [ ] Benchmark-derived tasks carry the canary header and keep upstream's
      identifier obfuscation
