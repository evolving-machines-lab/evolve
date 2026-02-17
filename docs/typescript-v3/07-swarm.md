# Swarm

Functional abstractions for parallel agent workflows: `map`, `filter`, `reduce`, `bestOf`, and `Pipeline`.

## Minimal Setup

```ts
import "dotenv/config";
import { Swarm } from "@evolvingmachines/sdk";

const swarm = new Swarm();
```

Full config:

```ts
import { Swarm } from "@evolvingmachines/sdk";

const swarm = new Swarm({
  agent: { type: "claude" },
  skills: ["pdf"],
  composio: {
    userId: "user_123",
    config: { toolkits: ["github", "linear"] },
  },
  mcpServers: {},
  concurrency: 4,
  timeoutMs: 3_600_000,
  tag: "my-pipeline",
  retry: {
    maxAttempts: 3,
    backoffMs: 1000,
    backoffMultiplier: 2,
  },
});
```

Defaults set on `Swarm` are inherited by operations unless overridden.

## Input Types

Swarm runs in knowledge mode by default: files are uploaded to `context/`.

`FileMap` is `Record<string, string | Uint8Array>`.

### One file per worker

```ts
const items = [
  { "report.txt": "Q1 revenue..." },
  { "report.txt": "Q2 revenue..." },
  { "report.txt": "Q3 revenue..." },
];

await swarm.map({ items, prompt: "Summarize this report" });
```

### Multiple files per worker

```ts
const items = [
  { "doc1.pdf": fs.readFileSync("./doc1.pdf"), "doc2.pdf": fs.readFileSync("./doc2.pdf") },
  { "doc3.pdf": fs.readFileSync("./doc3.pdf"), "doc4.pdf": fs.readFileSync("./doc4.pdf") },
];

await swarm.map({ items, prompt: "Compare these documents" });
```

### Entire folder per worker

```ts
import { readLocalDir } from "@evolvingmachines/sdk";

const items = [
  readLocalDir("./project-a", true),
  readLocalDir("./project-b", true),
];

await swarm.map({ items, prompt: "Review this codebase" });
```

## Operations

| Operation | Type | Behavior |
|---|---|---|
| `bestOf` | transform + select | run N candidates and judge best |
| `map` | transform | one output per input |
| `filter` | gate | keep original input if condition passes |
| `reduce` | transform | merge many inputs into one output |

### `bestOf`

```ts
const result = await swarm.bestOf({
  item: { "task.txt": "Complex problem..." },
  prompt: "Solve this problem",
  config: {
    n: 3,
    judgeCriteria: "Most accurate and best explained",
  },
});

console.log(result.winnerIndex, result.judgeReasoning);
```

Per-candidate agent variation:

```ts
await swarm.bestOf({
  item: { "task.txt": "..." },
  prompt: "Solve this",
  config: {
    taskAgents: [
      { type: "claude", model: "opus" },
      { type: "codex", model: "gpt-5.2-codex" },
      { type: "gemini", model: "gemini-3-flash" },
    ],
    judgeAgent: { type: "claude", model: "opus" },
    judgeCriteria: "Best solution quality",
    mcpServers: {},
    judgeMcpServers: {},
    skills: ["pdf"],
    judgeSkills: ["pdf"],
    composio: { userId: "u", config: { toolkits: ["github"] } },
    judgeComposio: { userId: "u", config: { toolkits: ["github"] } },
  },
});
```

### `map`

```ts
import { z } from "zod";

const SummarySchema = z.object({
  title: z.string(),
  keyPoints: z.array(z.string()),
});

const results = await swarm.map({
  items,
  prompt: (files, index) => `Analyze document ${index + 1}`,
  schema: SummarySchema,
  retry: { maxAttempts: 2 },
});
```

`schema` can be Zod or JSON Schema.

`map` also supports:
- `bestOf` (candidate/judge quality selection)
- `verify` (LLM verifier with retry feedback loop)
- `agent`, `mcpServers`, `skills`, `composio`, `timeoutMs`, `systemPrompt`, `name`

### `map` with `bestOf`

```ts
const results = await swarm.map({
  items,
  prompt: "Analyze thoroughly",
  schema: SummarySchema,
  bestOf: {
    n: 3,
    judgeCriteria: "Most comprehensive analysis",
  },
});
```

### `filter`

`filter` is two-step:
1. agent writes `result.json` matching `schema`
2. local `condition(data)` determines pass/fail

Passing items forward original input files (not generated output files).

```ts
const EvalSchema = z.object({
  severity: z.enum(["critical", "warning", "info"]),
  score: z.number(),
});

const filtered = await swarm.filter({
  items,
  prompt: "Assess severity",
  schema: EvalSchema,
  condition: (d) => d.severity === "critical",
});

console.log(filtered.success.length, filtered.filtered.length, filtered.error.length);
```

### `reduce`

Single agent sees all items in `context/item_0`, `context/item_1`, ...

```ts
const report = await swarm.reduce({
  items: filtered.success,
  prompt: "Create unified report",
});

if (report.status === "success") {
  console.log(report.files, report.data);
}
```

## Chaining Operations

`result.json` from a previous step is automatically renamed to `data.json` for downstream steps, avoiding collisions with new step output `result.json`.

```ts
const analyzed = await swarm.map({ items, prompt: "Analyze", schema: z.object({ summary: z.string() }) });

const critical = await swarm.filter({
  items: analyzed.success,
  prompt: "Rate severity",
  schema: z.object({ severity: z.enum(["critical", "warning", "info"]) }),
  condition: (d) => d.severity === "critical",
});

const report = await swarm.reduce({
  items: critical.success,
  prompt: "Create summary report",
});
```

## Agent Override and Concurrency

```ts
const results = await swarm.map({
  items,
  prompt: "Analyze",
  agent: { type: "codex", reasoningEffort: "high" },
});
```

Global semaphore controls concurrency across all operations:

```ts
const swarm = new Swarm({ concurrency: 4 });
// map(10) + bestOf(5) => many total calls, but only 4 active at once
```

Ordering guarantees:
- `bestOf`: judge starts after all candidates finish
- chained phases (`map -> filter -> reduce`): phase barrier between steps
- within a phase: parallel up to `concurrency`

## Pipeline

Fluent wrapper over Swarm with same feature set per step.

```ts
import { Pipeline } from "@evolvingmachines/sdk";

const pipeline = new Pipeline(swarm)
  .map({
    name: "analyze",
    prompt: "Analyze",
    schema: z.object({ score: z.number() }),
    bestOf: { n: 3, judgeCriteria: "Most accurate" },
  })
  .filter({
    name: "quality-gate",
    prompt: "Rate quality",
    schema: z.object({ score: z.number(), reasoning: z.string() }),
    condition: (d) => d.score >= 8,
    emit: "success",
  })
  .reduce({
    name: "synthesize",
    prompt: "Create executive summary",
  })
  .on("stepComplete", (e) => {
    console.log(`${e.name}: ${e.successCount}/${e.successCount + e.errorCount}`);
  });

const result = await pipeline.run(items);
```

Events:
- `stepStart`, `stepComplete`, `stepError`
- `itemRetry`, `workerComplete`, `verifierComplete`, `candidateComplete`, `judgeComplete`

Terminal behavior:
- after `.reduce()`, no further steps can be appended

## Types

For full `SwarmConfig`, `BestOfConfig`, `VerifyConfig`, result interfaces, and pipeline result types, see [Appendix: Types](./appendix-types.md).
