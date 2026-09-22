---
title: "Python"
description: "Run one task from an async Python program. No Node bridge is needed."
---

Install the package and set your [API key](/getting-started/installation).

```bash
pip install evolvingmachines-evolve
export EVOLVE_API_KEY="your-api-key"
```

## Run one task

The managed evals client calls the API directly. Save this as `eval.py` and run `python eval.py`.

```python eval.py
import asyncio
from evolve import hosted


async def main():
    async with hosted() as evolve:
        job = await evolve.jobs.start(
            datasets=[{
                "name": "harbor-examples",
                "version": "1.0",
                "task_names": ["hello-world"],
            }],
            agents=[{"name": "codex", "model_name": "gpt-5.6-luna"}],
            max_trial_spend_usd=0.50,
            retry={"max_retries": 0},
        )
        print("Job:", job.id)

        finished = await evolve.jobs.watch(job.id)
        print("Status:", finished.status)
        print("Model cost:", finished.stats.get("cost_usd"))

        async for trial in evolve.jobs.trials(job.id):
            print(trial.task_name, trial.status, trial.reward)

        archive = await evolve.jobs.download(job.id, to="./results")
        print("Saved:", archive)


asyncio.run(main())
```

### 1. Submit

`start()` returns the accepted job. It does not wait for the trial.

### 2. Wait

`watch()` follows progress and returns the terminal job.

### 3. Inspect

Use attributes for jobs and trials, and dictionary keys for stats.

### 4. Keep the results

`download()` saves a verified archive and returns its path.

The example sets a $0.50 cap for the trial and disables configured infrastructure retries. Provider capacity waits are handled separately. A completed job can contain failed trials; inspect their statuses and rewards.

## Show progress

Use the following snippets inside the `async with hosted() as evolve` block in `main()`, after creating `job`.

```python
finished = await evolve.jobs.watch(
    job.id,
    on_event=lambda event: print(event.seq, event.type),
)
```

Or consume the events directly:

```python
async for event in evolve.jobs.watch(job.id):
    print(event.type, event.data)
finished = await evolve.jobs.get(job.id)
```

Choose one consumption style for each watch handle.

## Read a trial

This uses the same `evolve` client and `job` from the program above.

```python
page = await evolve.jobs.trials(job.id, limit=1)
if page.items:
    trial = page.items[0]
    trajectory = await evolve.trials.artifact(trial.id, "trace-atif")
    files = await evolve.trials.files(trial.id)
    print(trajectory, files.items)
```

**[Configure a job](/sdk-reference/jobs)**

Models, task filters, attempts, limits, and analysis.

**[Understand returned objects](/sdk-reference/types)**

Dataclasses, dictionaries, nullable values, and status fields.
