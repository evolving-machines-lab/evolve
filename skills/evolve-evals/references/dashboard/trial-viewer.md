---
title: "Trial viewer"
description: "Follow the agent's actions and inspect the evidence behind a result."
---

Open a trial from a job's **Trials** tab, or select a run in **Traces**.

![Trial viewer with agent messages, tool calls, tool results, and recorded model usage.](/images/dashboard-trial-viewer.png)

*Follow what the agent did and inspect the corresponding usage.*

```text
1. Run header
   Task · agent · status · spend

2. Controls
   Back · search · downloads

3. Event list
   Select a message or tool call
            ↓
4. Read the event
   Full content and tool result
```

This schematic shows the reading order. The viewer adapts its controls to the run type and available space.

## Read a run

### 1. Identify the run

Check the run kind, task, model, status, and spend. An analysis or check shows the reviewer's own execution, not the evaluated agent's trace.

### 2. Follow events

Move through the prompt, messages, thoughts, tool calls, and tool results. Select an event to read it in full. New events appear while a live run continues.

### 3. Check the outcome

Inspect the reward or failure. Open the verifier log or review verdict from Downloads when you need the scoring evidence.

## Move through the trace

| Control | Action |
| --- | --- |
| Event row | Select an event. |
| `↑` / `k` | Previous event. |
| `↓` / `j` | Next event. |
| `/` | Focus event search. |

Search highlights matching events. Tool analytics summarizes tool use. Spend views use the recorded accounting; gateway events identify model calls and their token and cost readings.

## Download the right evidence

### Evaluation trial

Parsed trace, ATIF trajectory, stdout, stderr, agent home, verifier log, or the combined download.

### Analysis or task check

Verdict document, reviewer stdout and stderr, agent home, or the combined download.

A download can only contain what the run recorded. See [Trial outputs](/core-concepts/trial-outputs) for the saved layout and binary-file differences.

## Run actions

**Retry** creates a new one-trial job from a settled evaluation trial. **Stop** ends a live run. Controls appear only when the run type, state, and your permissions allow them.

Use **Back** to return to the job tab or list you came from.

**[Understand trial outcomes](/core-concepts/trials#statuses)**

Scores, errors, budgets, and cancellation.

**[Files and logs](/core-concepts/trial-outputs#sandbox-files)**

Inspect the live sandbox or its retained capture.
