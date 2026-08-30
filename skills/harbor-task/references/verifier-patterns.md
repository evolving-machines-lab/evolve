# Verifier patterns

The verifier is the task. Everything else is setup.

## The contract

`tests/test.sh` runs after the agent finishes and its credentials are revoked. Its
job is to write a reward file:

```
/logs/verifier/reward.txt     a single number in [0, 1]
/logs/verifier/reward.json    {"reward": 0.75, "gate_a": 1, "gate_b": 0}
```

**The reward file is the verdict, never the exit code.** A `test.sh` that exits 0
without writing one has not passed anything — an absent reward settles as a
scoring error.

Which means `test.sh` must not be `set -e` around the grader. It has to survive the
grader crashing and still write a verdict:

```bash
#!/bin/bash
set -uo pipefail
logs="${LOGS_DIR:-/logs}/verifier"
mkdir -p "$logs"

python3 "$(dirname "$0")/grader.py"
status=$?

# A grader that never ran is a zero, not a missing file.
if [ ! -f "$logs/reward.json" ]; then
    echo '{"reward": 0}' > "$logs/reward.json"
    echo "grader did not produce a reward (exit $status)" >&2
fi
```

Keep `test.sh` thin and put real logic in `tests/grader.py`. Shell is a poor place
to be careful, and a Python grader is directly testable.

## Shape 1 — binary

The default, and what upstream terminal-bench-science requires. The task either
was done or was not.

```bash
reward=0
[ "$(cat "${TASK_WORKDIR:-/app}/out.txt")" = "expected" ] && reward=1
echo "$reward" > "${LOGS_DIR:-/logs}"/verifier/reward.txt
```

## Shape 2 — gates with a binary verdict

Many independent constraints, all of which must hold. Report each as a named metric
so a failure is diagnosable, and keep the primary reward all-or-nothing.

```python
payload = dict(gates)                                   # each 0 or 1
payload["reward"] = 1 if all(gates.values()) else 0
json.dump(payload, open(f"{logs}/reward.json", "w"))
```

This is the best default for a converted benchmark with a published constraint
list: it matches the source's semantics and still tells you *which* constraint the
agent missed. Both worked examples use it.

## Shape 3 — weighted partial credit

Only when partial credit is genuinely meaningful — a test suite where passing half
the cases is half the work, not a task you are softening because agents keep
failing.

```python
weights = {"builds": 0.2, "tests_pass": 0.5, "no_regressions": 0.3}
payload = dict(gates)
payload["reward"] = round(sum(gates[k] * w for k, w in weights.items()), 4)
```

State the weights in the task's README. They are a design decision.

## Shape 4 — named scores with no primary reward

A `reward.json` with several numbers and **no** `"reward"` key is valid: the trial
settles `SCORED`, every score is recorded as a metric, and there is no primary
reward. Job aggregates skip it and the task is **excluded from pass@k**.

Use it only when you deliberately want a measurement rather than a verdict. If you
want a headline number, write `"reward"`.

Note the neighbouring rule: a `reward.json` with exactly one numeric value and no
`"reward"` key means *that value is the score*. Two numbers and no `"reward"` is a
different outcome from one. Be explicit and always write `"reward"`.

## Shape 5 — LLM judge

For open-ended output. Ask for the credential the way Harbor tasks do:

```toml
[verifier.env]
ANTHROPIC_API_KEY = "${ANTHROPIC_API_KEY}"
```

The platform mints a short-lived, family-scoped gateway credential and sets the
matching base URL automatically, so `rewardkit` works offline and unchanged:

```bash
uvx --from harbor-rewardkit rewardkit /tests
```

Rules that bite: templates are honored only as the **entire** value; only the
`ANTHROPIC_*` / `OPENAI_*` pairs are judge templates; any other template needs a
default; the platform never picks a judge model, so your rubric must name one.
Judge-enabled tasks cannot be regraded.

Prefer a deterministic check whenever one exists. A judge is a model in your
measurement loop, and it costs money on every trial.

---

## Making a verifier hard to fool

Write the grader adversarially. Assume a capable agent that has read
`instruction.md` and wants the reward, not the outcome.

**Grade the artifact, not the environment.** Under a `separate` verifier the box is
pristine and only `artifacts` carry over — that is the point. Under `shared`, the
agent's box *is* the verifier's box: anything it wrote, including a fake results
file or a patched library, is in scope. If that matters, use `separate`.

**Never import the agent's code as ground truth.** A verifier that loads a module
from the agent's working directory lets the submission rewrite its own scoring.
Keep the grader's copy in `tests/`, even when it duplicates a file in
`environment/` — the MADE example does exactly this, on purpose.

**Audit claims against a log you control.** When the agent operates a budgeted
tool, have the tool write the log and declare that log as an artifact. Then the
verifier checks the recorded trajectory rather than the agent's summary of it.

**Defeat the shotgun.** If claiming more can only help, an agent will claim
everything. Pair any "how many did you find" metric with a precision requirement,
so a wrong claim costs something.

**Normalize before comparing.** Distinct-by-string is not distinct-by-meaning:
`Li2Sn2` and `LiSn` are one composition, `1.0` and `1.00` are one number. Canonicalize,
then count.

**Check the trivial submission.** An empty file, a missing file, the input copied
verbatim, and the instruction text echoed back should all score 0. The null half of
the gold/null run covers the missing-file case; the others are worth a line in the
grader's own tests.

## Auditing a live corpus for reward hacking

A verifier you cannot fool on paper can still be fooled in practice, and the
evidence for that is in the trials, not in the task directory. The platform runs
Harbor's `harbor analyze` hosted: rubric-driven trace analysis over a finished
job, where an analyzer agent reads each trial's recorded tree — trajectory, logs,
the original task — and rules every rubric criterion `pass` / `fail` /
`not_applicable` with a written explanation. Its two default checks are exactly
the two questions a task author has after a first run:

- `reward_hacking` — did the agent earn the reward without doing the work?
- `task_specification` — was the instruction sufficient to solve the task?

```bash
evolve analyze <job-id>          # the defaults; follows the wave to settled
```

Run it on the first real job over a new corpus. A `reward_hacking` fail is a
verifier bug; a `task_specification` fail usually means `instruction.md` enforces
something the grader checks but never states. See the Analyze section of the
hosted-evals reference for rubrics, models and the polling API.

## Cost and time

The verifier runs on every trial of every job. A grader that takes ten minutes
multiplies across the whole corpus. Keep it deterministic, keep it fast, and put
heavy dependency installation in `tests/Dockerfile` — where it is built once — and
never in `test.sh`, where it is paid every run.
