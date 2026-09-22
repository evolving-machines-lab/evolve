---
title: "TypeScript"
description: "Run one task, follow its progress, and inspect the result."
---

Install the package and set your [API key](/getting-started/installation).

```bash
npm install @evolvingmachines/evolve
export EVOLVE_API_KEY="your-api-key"
```

## Run one task

Save this as `eval.mts` in your TypeScript project.

```ts eval.mts
import { hosted } from "@evolvingmachines/evolve";

const evolve = hosted();

const job = await evolve.jobs.start({
  datasets: [{
    name: "harbor-examples",
    version: "1.0",
    task_names: ["hello-world"],
  }],
  agents: [{ name: "codex", model_name: "gpt-5.6-luna" }],
  max_trial_spend_usd: 0.50,
  retry: { max_retries: 0 },
});
console.log("Job:", job.id);

const finished = await evolve.jobs.watch(job.id);
console.log("Status:", finished.status);
console.log("Model cost:", finished.stats.cost_usd);

for await (const trial of evolve.jobs.trials(job.id)) {
  console.log(trial.task_name, trial.status, trial.reward);
}

const archive = await evolve.jobs.download(job.id, { to: "./results" });
console.log("Saved:", archive);
```

### 1. Submit

`start()` returns the accepted job. It does not wait for the trial.

### 2. Wait

`watch()` follows progress and returns the terminal job.

### 3. Inspect

Read each trial's status and reward. A completed job can contain failed trials.

### 4. Keep the results

`download()` saves a verified archive and returns its path.

The example sets a $0.50 cap for the trial and disables configured infrastructure retries. Provider capacity waits are handled separately. These settings limit the example's work; they do not guarantee a passing result.

## Show progress

Use an event callback while awaiting completion:

```ts
const finished = await evolve.jobs.watch(job.id, {
  onEvent: (event) => console.log(event.seq, event.type),
});
```

Or consume events directly:

```ts
for await (const event of evolve.jobs.watch(job.id)) {
  console.log(event.type, event.data);
}
const finished = await evolve.jobs.get(job.id);
```

Choose one consumption style for each watch handle.

## Read a trial

```ts
const page = await evolve.jobs.trials(job.id, { limit: 1 });
const trial = page.items[0];

if (trial) {
  const trajectory = await evolve.trials.artifact(trial.id, "trace-atif");
  const files = await evolve.trials.files(trial.id);
  console.log(trajectory, files.items);
}
```

**[Configure a job](/sdk-reference/jobs)**

Models, task filters, attempts, limits, and analysis.

**[Inspect files](/sdk-reference/filesystem)**

Live files, saved captures, logs, and processes.
