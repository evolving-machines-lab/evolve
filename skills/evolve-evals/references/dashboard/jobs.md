---
title: "Jobs"
description: "Launch an evaluation, follow its progress, and move from a summary to the evidence."
---

Open **Jobs** in your selected workspace. The list includes evaluation jobs and task checks; **Kind** tells them apart.

![Jobs and task checks with status, dataset, agent, progress, and cost.](/images/dashboard-jobs.png)

*Evaluation jobs and task checks appear in the same list.*

```text
Jobs list
├── Evaluation
│   └── Job overview
│       └── Trial
│           └── Trace and outputs
└── Check
    └── Check report
        └── Task check
            └── Findings and trace
```

Search by name or filter by status. Evaluation rows show the task set, agents, progress, and spend. Check rows show the source tasks and checker progress.

## New job

Choose **New job** to configure an evaluation.

![Job launcher with a dataset search, agent, model, reasoning effort, and trial summary.](/images/dashboard-new-job.png)

*Choose sources and agent settings. The summary updates as you configure the run.*

### 1. Choose sources

Select datasets and versions. Add include/exclude task patterns or a task cap.

### 2. Add agents

Choose a harness, model, and reasoning effort for each arm. Expand arm options for a version pin, preset, configuration, or skills.

### 3. Set the run limits

Set attempts, parallel trials, retries, and the per-trial spend cap. Add required secrets. Advanced settings include provider, timeouts, and verifier judge overrides.

### 4. Review and launch

Check the Summary. **Validate** checks the form locally; **Launch** submits it for server validation and execution.

The number of trials is selected tasks × agent arms × attempts. [Job settings](/core-concepts/jobs) explain what each choice changes.

## One job

Start with progress and errors, then open the relevant tab.

![Completed job summary with trials, errors, reward, cost, progress, and per-agent scores.](/images/dashboard-job-overview.png)

*The overview connects run progress to scores for each agent and dataset.*

| Tab | Answers |
| --- | --- |
| **Overview** | How did each agent and dataset perform? |
| **Trials** | Which attempts scored, failed, or are still running? |
| **Analyze** | Does the trace support the score? |
| **Check** | What quality checks exist for these tasks? |
| **Config** | What exact settings and resolved records did this job use? |

A job can be **Completed** while some trials have errors. The top-level average is shown only for a single agent/dataset group; use Overview for comparisons across groups.

### Job actions

| Action | Effect |
| --- | --- |
| **Cancel** | Request that the running job stop. |
| **Resume** | Create a new job from eligible failed or stopped trials. |
| **Re-run job** | Open the launcher with this job's choices. |
| **Download** | Retrieve a finished job's result archive. |
| **Share** | Manage read access to a job you created. |

Actions depend on the job state and your access. Email sharing gives read access; team membership can also permit job operations.

## The ANALYZE tab

The summary separates completed, failed, and pending analyses, plus their cost. An embedded analysis policy shows the configured model, effort, and rubric; manual analyses record their own settings.

![Analysis criteria with pass, fail, not-applicable, and unknown totals.](/images/dashboard-analysis.png)

*Criterion totals help identify which findings need closer inspection.*

1. Read the **analysis summary**.

2. Review **criterion totals**: pass, fail, not applicable, and unknown.

3. Open **per-trial findings**: the summary chip, criterion outcomes, evidence, and summary.

4. Follow the **analyzer trace**.

Start a review with `evolve analyze "$JOB_ID" --watch`, or enable analysis when launching through the CLI or SDK. See [Analyze trials](/core-concepts/analyze).

**[Trial viewer](/dashboard/trial-viewer)**

Inspect one attempt in detail.

**[Checks](/dashboard/checks)**

Read the task-quality reports.
