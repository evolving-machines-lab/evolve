# Swarm & Pipeline

Functional programming for AI agents: `map`, `filter`, `reduce`, `bestOf`, `verify`.

```ts
import { Swarm } from "@evolvingmachines/sdk";
import { z } from "zod";  // Or use plain JSON Schema objects instead

const swarm = new Swarm({
    agent: { type: "claude" },   // Default agent for all operations
    skills: ["pdf"],                 // Default skills (browser-use included by default)
    composio: {                  // Default Composio config for all workers
        userId: "user_123",
        config: { toolkits: ["github", "linear"] },
    },
    mcpServers: {...},           // Default MCP servers for all workers
    concurrency: 4,              // Max parallel sandboxes (default: 4)
    timeoutMs: 3_600_000,        // Default timeout per worker (default: 1 hour)
    tag: "my-pipeline",          // Tag prefix for observability
    retry: {                     // Default retry config for all operations
        maxAttempts: 3,
        backoffMs: 1000,
        backoffMultiplier: 2,
    },
});
```

> **Defaults**: `agent`, `skills`, `composio`, `mcpServers`, `timeoutMs`, and `retry` set here are inherited by all operations (`map`, `filter`, `reduce`, `bestOf`). Pass these options to individual operations to override.

**SwarmConfig** — configuration for Swarm instance:
```ts
{
    agent?: AgentOverride,
    skills?: string[],
    composio?: ComposioSetup,
    mcpServers?: Record<string, McpServerConfig>,
    concurrency?: number,
    timeoutMs?: number,
    tag?: string,
    retry?: RetryConfig,
}
```

| Option | Default | Notes |
|--------|---------|-------|
| `agent.type` | `'claude'` | Auto-resolved from env |
| `agent.model` | per type | `'sonnet'` (claude), `'gpt-5.2'` (codex), etc. |
| `skills` | `undefined` | Set here or per-operation |
| `composio` | `undefined` | Set here or per-operation |
| `mcpServers` | `undefined` | Set here or per-operation |
| `concurrency` | `4` | Max parallel sandboxes |
| `timeoutMs` | `3_600_000` | 1 hour per worker |
| `tag` | `'swarm'` | Observability prefix |
| `retry` | `undefined` | Set here or per-operation |

**Minimal setup** — with `EVOLVE_API_KEY` set (see [1.1 Authentication](./01-getting-started.md#11-authentication)):

```ts
import "dotenv/config";  // If using .env file
import { Swarm } from "@evolvingmachines/sdk";

const swarm = new Swarm();  // Auto-resolves agent (claude) and sandbox from env
```

**RetryConfig** — auto-retry on error with exponential backoff:
```ts
{
    maxAttempts?: number,
    backoffMs?: number,
    backoffMultiplier?: number,
    retryOn?: (result) => boolean,
    onItemRetry?: (idx, attempt, error) => void,
}
```

## Input Types

Swarm runs in **knowledge mode** by default—files are uploaded to `context/` in the sandbox.

**FileMap structure:**

```ts
// FileMap: Record<path, content>
//   - path: string              → file path in context/ folder
//   - content: string | Uint8Array  → file content

type FileMap = Record<string, string | Uint8Array>;
```

---

**Case 1: One file per worker**

```ts
// 3 workers, each gets 1 file
const items: FileMap[] = [
    { "report.txt": "Q1 revenue..." },      // → Worker 0: context/report.txt
    { "report.txt": "Q2 revenue..." },      // → Worker 1: context/report.txt
    { "report.txt": "Q3 revenue..." },      // → Worker 2: context/report.txt
];

const results = await swarm.map({
    items,
    prompt: "Summarize this report",
});
```

---

**Case 2: Multiple files per worker**

```ts
// 3 workers, each gets 2 files
const items: FileMap[] = [
    {                                       // → Worker 0:
        "doc1.pdf": fs.readFileSync("./doc1.pdf"),  //   context/doc1.pdf
        "doc2.pdf": fs.readFileSync("./doc2.pdf"),  //   context/doc2.pdf
    },
    {                                       // → Worker 1:
        "doc3.pdf": fs.readFileSync("./doc3.pdf"),  //   context/doc3.pdf
        "doc4.pdf": fs.readFileSync("./doc4.pdf"),  //   context/doc4.pdf
    },
    {                                       // → Worker 2:
        "doc5.pdf": fs.readFileSync("./doc5.pdf"),  //   context/doc5.pdf
        "doc6.pdf": fs.readFileSync("./doc6.pdf"),  //   context/doc6.pdf
    },
];

const results = await swarm.map({
    items,
    prompt: "Compare these two documents",
});
```

---

**Case 3: Entire folder per worker**

```ts
import { readLocalDir } from "@evolvingmachines/sdk";

// readLocalDir(path, recursive) → returns FileMap with all files
const items: FileMap[] = [
    readLocalDir("./project-a", true),      // → Worker 0: all files from project-a (recursive)
    readLocalDir("./project-b", true),      // → Worker 1: all files from project-b (recursive)
    readLocalDir("./project-c", true),      // → Worker 2: all files from project-c (recursive)
];

const results = await swarm.map({
    items,
    prompt: "Review this codebase",
});
```

## Abstractions

Two types of operations:

| Operation | Type | Description | Passes On |
|-----------|------|-------------|-----------|
| `bestOf` | transform + select | `input` → `output` (best of N candidates) | winner output |
| `map` | transform | `input` → `output` (agent produces new data) | agent output |
| `filter` | gate | `input` → `input` (agent evaluates, condition decides) | original input + status (`success` \| `filtered`) |
| `reduce` | transform | `inputs` → `output` (agent synthesizes) | agent output |

**Transforms** produce new output files. **Filter** passes through original input files unchanged.

**BestOfConfig** — run N candidates in parallel, judge picks the best:
```ts
{
    n?: number,
    judgeCriteria: string,
    taskAgents?: AgentOverride[],
    judgeAgent?: AgentOverride,
    skills?: string[],
    judgeSkills?: string[],
    composio?: ComposioSetup,
    judgeComposio?: ComposioSetup,
    mcpServers?: Record<string, McpServerConfig>,
    judgeMcpServers?: Record<string, McpServerConfig>,
    onCandidateComplete?: (idx, candIdx, status) => void,
    onJudgeComplete?: (idx, winnerIdx, reasoning) => void,
}
```

**VerifyConfig** — LLM-as-judge verifies output, retries with feedback if failed:
```ts
{
    criteria: string,
    maxAttempts?: number,
    verifierAgent?: AgentOverride,
    verifierSkills?: string[],
    verifierComposio?: ComposioSetup,
    verifierMcpServers?: Record<string, McpServerConfig>,
    onWorkerComplete?: (idx, attempt, status) => void,
    onVerifierComplete?: (idx, attempt, passed, feedback?) => void,
}
```

### bestOf

Run N agents on the same `item` in parallel, then a judge picks the best. `Agent[i]` outputs `candidates[i]`, judge selects `winner`.

```
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│    Sandbox 0    │ │    Sandbox 1    │ │    Sandbox 2    │
│    Agent 0      │ │    Agent 1      │ │    Agent 2      │
│                 │ │                 │ │                 │
│  context/       │ │  context/       │ │  context/       │
│    item         │ │    item         │ │    item         │
│  output/        │ │  output/        │ │  output/        │
│    candidates[0]│ │    candidates[1]│ │    candidates[2]│
└───────┬─────────┘ └───────┬─────────┘ └───────┬─────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
                    ┌───────────────┐
                    │     Judge     │
                    └───────┬───────┘
                            │
                            ▼
                         winner
```

```ts
// Signature
swarm.bestOf<T>({
    item: FileMap | SwarmResult,
    prompt: string,
    config: BestOfConfig,               // { n?, judgeCriteria, taskAgents?, judgeAgent?, mcpServers?, judgeMcpServers?, skills?, judgeSkills?, composio?, judgeComposio?, ... }
    name?: string,                      // Operation name for observability (appears in meta.operationName)
    schema?: z.ZodType<T> | JsonSchema,
    systemPrompt?: string,
    retry?: RetryConfig,                // Per-candidate retry (judge uses default)
    timeoutMs?: number,
}): Promise<BestOfResult<T>>
```

```ts
const input = { "task.txt": "Complex problem..." };

const result = await swarm.bestOf({
    item: input,
    prompt: "Solve this problem",
    config: {
        n: 3,
        judgeCriteria: "Most accurate and well-explained solution",
        onCandidateComplete: (idx, candIdx, status) => console.log(`Candidate ${candIdx}: ${status}`),
        onJudgeComplete: (idx, winnerIdx, reasoning) => console.log(`Winner: ${winnerIdx}`),
    },
});

console.log(result.winner);         // Best SwarmResult
console.log(result.winnerIndex);    // 0, 1, or 2
console.log(result.judgeReasoning); // Why this was chosen
console.log(result.candidates);     // All candidate results
```

Use different agents per candidate:

```ts
const claudeAgent = { type: "claude", model: "opus" };
const codexAgent = { type: "codex", model: "gpt-5.2-codex" };
const geminiAgent = { type: "gemini", model: "gemini-3-flash" };

const result = await swarm.bestOf({
    item: input,
    prompt: "Solve this",
    config: {
        taskAgents: [claudeAgent, codexAgent, geminiAgent],
        judgeCriteria: "Best solution quality",
        judgeAgent: claudeAgent,
        mcpServers: {...},        // (optional) MCP servers for candidates
        judgeMcpServers: {...},   // (optional) MCP servers for judge
        skills: ["pdf"],          // (optional) Skills for candidates
        judgeSkills: ["pdf"],     // (optional) Skills for judge
        composio: {...},          // (optional) Composio config for candidates
        judgeComposio: {...},     // (optional) Composio config for judge
    },
});
```

### map

Process items in parallel. `Agent[i]` sees `items[i]` and outputs `results[i]` (which includes `result.json` if `schema` provided).

```
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│    Sandbox 0    │ │    Sandbox 1    │ │    Sandbox 2    │
│    Agent 0      │ │    Agent 1      │ │    Agent 2      │
│                 │ │                 │ │                 │
│  context/       │ │  context/       │ │  context/       │
│    items[0]     │ │    items[1]     │ │    items[2]     │
│  output/        │ │  output/        │ │  output/        │
│    results[0]   │ │    results[1]   │ │    results[2]   │
└───────┬─────────┘ └───────┬─────────┘ └───────┬─────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
              [results[0], results[1], results[2]]
```

```ts
// Signature (schema accepts Zod or JSON Schema object)
swarm.map<T>({
    items: FileMap[] | SwarmResult[],
    prompt: string | ((files: FileMap, index: number) => string),
    name?: string,                      // Operation name for observability (appears in meta.operationName)
    schema?: z.ZodType<T> | JsonSchema,
    systemPrompt?: string,
    agent?: AgentOverride,
    bestOf?: BestOfConfig,              // N candidates + judge (mutually exclusive with verify)
    verify?: VerifyConfig,              // LLM-as-judge quality check with retry loop
    retry?: RetryConfig,                // Auto-retry on error with backoff
    mcpServers?: Record<string, McpServerConfig>,
    skills?: string[],                  // e.g. ["pdf"]
    composio?: ComposioSetup,           // Composio Tool Router config
    timeoutMs?: number,
}): Promise<SwarmResultList<T>>
```

```ts
// Basic
const results = await swarm.map({
    items: documents,
    prompt: "Summarize this document",
});
```

When `schema` is provided, a structured output prompt is automatically embedded—instructing the agent to write `output/result.json` matching the schema.

```ts
// With Zod schema
const SummarySchema = z.object({
    title: z.string(),
    keyPoints: z.array(z.string()),
});

const results = await swarm.map({
    items: documents,
    prompt: "Extract summary",
    schema: SummarySchema,
});

// Or with JSON Schema
const SummaryJsonSchema = {
    type: "object",
    properties: {
        title: { type: "string" },
        keyPoints: { type: "array", items: { type: "string" } },
    },
    required: ["title", "keyPoints"],
};

const results = await swarm.map({
    items: documents,
    prompt: "Extract summary",
    schema: SummaryJsonSchema,
});

// With dynamic prompt
const results = await swarm.map({
    items: documents,
    prompt: (files, index) => `Analyze document ${index + 1}: focus on revenue`,
});

// Access results
for (const r of results) {
    if (r.status === "success") {
        console.log(r.data);   // Parsed schema or FileMap
        console.log(r.files);  // Output files from agent
    }
}
```

### map + bestOf

Combine map parallelism with bestOf quality:

```ts
const AnalysisSchema = z.object({
    findings: z.array(z.string()),
    confidence: z.number(),
});

// Each item gets N candidates, judge picks best per item
const results = await swarm.map({
    items: documents,
    prompt: "Analyze thoroughly",
    schema: AnalysisSchema,
    bestOf: {
        n: 3,
        judgeCriteria: "Most comprehensive analysis",
        // taskAgents?: AgentOverride[],     // Different agent per candidate
        // judgeAgent?: AgentOverride,       // Override judge agent
        // mcpServers?: {...},               // MCP servers for candidates
        // judgeMcpServers?: {...},          // MCP servers for judge
        // skills?: [...],                   // Skills for candidates
        // judgeSkills?: [...],              // Skills for judge
        // composio?: {...},                 // Composio for candidates
        // judgeComposio?: {...},            // Composio for judge
    },
});

// Results contain only winners (one per input item)
```

### filter

Two-step evaluation (`schema` and `condition` are required):
1. `Agent[i]` sees `items[i]`, assesses it, outputs `result.json` matching `schema`
2. SDK parses `result.json` → `data`, your `condition(data)` applies the threshold
3. Passing items forward their original input files, not agent output

```
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│    Sandbox 0    │ │    Sandbox 1    │ │    Sandbox 2    │
│    Agent 0      │ │    Agent 1      │ │    Agent 2      │
│                 │ │                 │ │                 │
│  context/       │ │  context/       │ │  context/       │
│    items[0]     │ │    items[1]     │ │    items[2]     │
│  output/        │ │  output/        │ │  output/        │
│    result.json  │ │    result.json  │ │    result.json  │
└───────┬─────────┘ └───────┬─────────┘ └───────┬─────────┘
        │                   │                   │
        └───────────────────┼───────────────────┘
                            ▼
                   condition(data)
                      ✓    ✗    ✓
                      │         │
                      ▼         ▼
                [items[0], items[2]]
```

```ts
// Signature (schema accepts Zod or JSON Schema object)
swarm.filter<T>({
    items: FileMap[] | SwarmResult[],
    prompt: string,           // Describe what to assess (agent outputs result.json)
    name?: string,                      // Operation name for observability (appears in meta.operationName)
    schema: z.ZodType<T> | JsonSchema,  // Required - defines evaluation output structure
    condition: (data: T) => boolean,    // Local function applies threshold
    systemPrompt?: string,
    agent?: AgentOverride,
    verify?: VerifyConfig,              // LLM-as-judge quality check with retry loop
    retry?: RetryConfig,                // Auto-retry on error with backoff
    mcpServers?: Record<string, McpServerConfig>,
    skills?: string[],                  // e.g. ["pdf"]
    composio?: ComposioSetup,           // Composio Tool Router config
    timeoutMs?: number,
}): Promise<SwarmResultList<T>>
```

```ts
const EvalSchema = z.object({
    severity: z.enum(["critical", "warning", "info"]),
    score: z.number(),
});

const results = await swarm.filter({
    items: documents,
    prompt: "Assess the severity of issues in this document",  // Agent evaluates
    schema: EvalSchema,
    condition: (data) => data.severity === "critical",  // Code applies threshold
});

// Three possible statuses:
results.success;   // Passed condition
results.filtered;  // Evaluated but didn't pass
results.error;     // Agent error

// Chain to next step
await swarm.reduce({
    items: results.success,
    prompt: "Summarize critical issues",
});
```

### reduce

Synthesize many items into one. A single agent sees all `items` as `item_0/`, `item_1/`, etc. and outputs a unified `result` (which includes `result.json` if `schema` provided).

```
        ┌─────────────────────────┐
        │         Sandbox         │
        │         Agent           │
        │                         │
        │  context/               │
        │    item_0/items[0]      │
        │    item_1/items[1]      │
        │    item_2/items[2]      │
        │  output/                │
        │    result               │
        └────────────┬────────────┘
                     │
                     ▼
                  result
```

```ts
// Signature (schema accepts Zod or JSON Schema object)
swarm.reduce<T>({
    items: FileMap[] | SwarmResult[],
    prompt: string,
    name?: string,                      // Operation name for observability (appears in meta.operationName)
    schema?: z.ZodType<T> | JsonSchema,
    systemPrompt?: string,
    agent?: AgentOverride,
    verify?: VerifyConfig,              // LLM-as-judge quality check with retry loop
    retry?: RetryConfig,                // Auto-retry on error with backoff
    mcpServers?: Record<string, McpServerConfig>,
    skills?: string[],                  // e.g. ["pdf"]
    composio?: ComposioSetup,           // Composio Tool Router config
    timeoutMs?: number,
}): Promise<ReduceResult<T>>
```

```ts
// Agent sees: item_0/, item_1/, item_2/, etc.
const report = await swarm.reduce({
    items: results.success,
    prompt: "Create a unified report from all analyses",
});

if (report.status === "success") {
    console.log(report.files);  // Final output files
    console.log(report.data);   // Parsed schema if provided
}

// With schema
const ReportSchema = z.object({
    summary: z.string(),
    recommendations: z.array(z.string()),
});

const report = await swarm.reduce({
    items,
    prompt: "Create report",
    schema: ReportSchema,
});
```

### verify (quality gate)

Add a verification loop to any operation (`map`, `filter`, `reduce`). A separate verifier agent checks if the worker's output meets your criteria. On failure, the worker retries with the verifier's feedback — up to `maxAttempts` times.

```
┌───────────────┐      ┌──────────────┐
│    Worker     │─────▶│   Verifier   │
│  (attempt 1)  │      │              │
└───────────────┘      └──────┬───────┘
                              │
                       pass?  │  fail + feedback
                         │    │    │
                         ▼    │    ▼
                      output  │  ┌───────────────┐
                              └─▶│    Worker     │──▶ Verifier ──▶ ...
                                 │  (attempt 2)  │   (up to maxAttempts)
                                 └───────────────┘
```

```ts
const results = await swarm.map({
    items: documents,
    prompt: "Write a detailed analysis",
    schema: AnalysisSchema,
    verify: {
        criteria: "Analysis must include specific data points and cite sources",
        maxAttempts: 3,              // Default: 3
        // verifierAgent: { type: "claude", model: "opus" },  // Override verifier agent
        // verifierSkills: ["pdf"],   // Skills for verifier
        onWorkerComplete: (idx, attempt, status) => {
            console.log(`Item ${idx}, attempt ${attempt}: ${status}`);
        },
        onVerifierComplete: (idx, attempt, passed, feedback) => {
            console.log(`Verify item ${idx}: ${passed ? "PASS" : feedback}`);
        },
    },
});

// Check verification outcome
for (const r of results) {
    if (r.verify) {
        console.log(`Passed: ${r.verify.passed}, attempts: ${r.verify.attempts}`);
        console.log(`Reasoning: ${r.verify.reasoning}`);
    }
}
```

On each failed attempt, the verifier's feedback is appended to the worker's prompt so it can address specific issues. The final result includes `verify: VerifyInfo` with the outcome.

> **Note:** `verify` and `bestOf` are mutually exclusive on `map`. Use one or the other per operation.

---

## Result Types

```ts
// SwarmResult<T> - from map, filter, bestOf candidates
interface SwarmResult<T> {
    status: "success" | "filtered" | "error";
    data: T | null;      // Parsed schema, or null on error
    files: FileMap;      // Output files (map/bestOf) or input files (filter)
    meta: IndexedMeta;   // { operationId, operation, tag, sandboxId, itemIndex }
    error?: string;      // Error message if status === "error"
    rawData?: string;    // Raw result.json when parse/validation failed (for debugging)
    bestOf?: {           // Present when map used bestOf option
        winnerIndex: number;
        judgeReasoning: string;
        judgeMeta: JudgeMeta;   // { operationId, operation, tag, sandboxId, candidateCount }
        candidates: SwarmResult<T>[];
    };
    verify?: VerifyInfo; // Present when verify option was used
}

// SwarmResultList<T> - from map, filter (extends Array)
results.success;   // SwarmResult[] with status "success"
results.filtered;  // SwarmResult[] with status "filtered"
results.error;     // SwarmResult[] with status "error"

// ReduceResult<T> - from reduce
interface ReduceResult<T> {
    status: "success" | "error";
    data: T | null;
    files: FileMap;
    meta: ReduceMeta;   // { operationId, operation, tag, sandboxId, inputCount, inputIndices }
    error?: string;
    rawData?: string;   // Raw result.json when parse/validation failed (for debugging)
    verify?: VerifyInfo; // Present when verify option was used
}

// VerifyInfo - verification outcome
interface VerifyInfo {
    passed: boolean;        // Final verification status
    reasoning: string;      // Verifier's reasoning
    verifyMeta: VerifyMeta; // { operationId, operation, tag, sandboxId, attempts }
    attempts: number;       // Total attempts made
}

// BestOfResult<T> - from bestOf
interface BestOfResult<T> {
    winner: SwarmResult<T>;
    winnerIndex: number;
    judgeReasoning: string;
    judgeMeta: JudgeMeta;   // { operationId, operation, tag, sandboxId, candidateCount }
    candidates: SwarmResult<T>[];
}
```

## Chaining Operations

When chaining Swarm operations, `result.json` from a previous step is automatically renamed to `data.json`. This avoids confusion when the downstream agent writes its own `result.json`. This also applies to [Pipeline](#pipeline).

**Example: map → reduce chain**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  MAP (parallel)                                                             │
│                                                                             │
│  item_0 agent writes:          item_1 agent writes:                         │
│  output/                       output/                                      │
│    result.json ← schema        result.json ← schema                         │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  REDUCE (single agent)                                                      │
│                                                                             │
│  context/                                                                   │
│    item_0/                                                                  │
│      data.json      ← renamed from result.json                              │
│    item_1/                                                                  │
│      data.json      ← renamed from result.json                              │
│  output/                                                                    │
│    result.json      ← reduce agent writes its own                           │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

```ts
const AnalysisSchema = z.object({ summary: z.string() });
const SeveritySchema = z.object({ severity: z.enum(["critical", "warning", "info"]) });

// Full pipeline: map → filter → reduce
const analyzed = await swarm.map({
    items: documents,
    prompt: "Analyze",
    schema: AnalysisSchema,
});

const critical = await swarm.filter({
    items: analyzed.success,
    prompt: "Evaluate severity",
    schema: SeveritySchema,
    condition: (d) => d.severity === "critical",
});

const report = await swarm.reduce({
    items: critical.success,
    prompt: "Create summary report",
});

// Combine success and filtered
const allEvaluated = [...critical.success, ...critical.filtered];
await swarm.reduce({
    items: allEvaluated,
    prompt: "Summarize all evaluated items",
});
```

## AgentOverride

Override the default agent for any operation (apiKey inherited from Swarm config):

```ts
interface AgentOverride {
    type: "claude" | "codex" | "gemini" | "qwen" | "kimi" | "opencode";
    model?: string;
    reasoningEffort?: "low" | "medium" | "high" | "xhigh";  // Codex only
}
```

```ts
const codexAgent: AgentOverride = {
    type: "codex",
    reasoningEffort: "high",
};

const results = await swarm.map({
    items,
    prompt: "Analyze",
    agent: codexAgent,
});
```

## Concurrency

Global semaphore limits parallel sandboxes across all operations.

```ts
const swarm = new Swarm({
    agent,
    sandbox,
    concurrency: 4,  // Max 4 sandboxes at once (default: 4)
});

// map(10) with bestOf(5) = 60 agent calls, but only 4 run at any time
```

**Ordering guarantees:**
- `bestOf`: Judge runs only after all candidates complete
- `map` → `filter` → `reduce`: Each phase completes before next starts
- Within a phase: Items run in parallel (up to concurrency limit)

---

## Pipeline

Fluent wrapper over Swarm for chaining operations. **All Swarm features work in Pipeline steps** — `schema`, `bestOf`, `verify`, `retry`, `agent`, `mcpServers`, `skills`, `composio`, dynamic prompts.

```ts
import "dotenv/config";
import { Swarm, Pipeline } from "@evolvingmachines/sdk";

const swarm = new Swarm();  // See Swarm Abstractions for full config

const pipeline = new Pipeline(swarm)
    .map({
        name: "analyze",
        prompt: "Analyze...",
        schema: AnalysisSchema,
    })
    .filter({
        name: "critical",
        prompt: "Rate...",
        schema: SeveritySchema,
        condition: d => d.severity === "critical",
    })
    .reduce({
        name: "report",
        prompt: "Summarize...",
    });

// Reusable — run with different data
const result1 = await pipeline.run(batch1);
const result2 = await pipeline.run(batch2);
```

### Step Configurations

Each step accepts the same options as the corresponding Swarm method, plus `name` for observability:

```ts
// Map step — same as swarm.map() + name
.map<T>({
    name?: string,                        // Step name (appears in events)
    prompt: string | ((files, idx) => string),
    schema?: z.ZodType<T> | JsonSchema,
    bestOf?: BestOfConfig,                // N candidates + judge
    verify?: VerifyConfig,                // LLM-as-judge quality check
    retry?: RetryConfig,                  // Auto-retry on error
    agent?: AgentOverride,
    mcpServers?: Record<string, McpServerConfig>,
    skills?: string[],                    // Skills for workers
    composio?: ComposioSetup,             // Composio Tool Router config
    systemPrompt?: string,
    timeoutMs?: number,
})

// Filter step — same as swarm.filter() + name + emit
.filter<T>({
    name?: string,
    prompt: string,
    schema: z.ZodType<T> | JsonSchema,    // Required
    condition: (data: T) => boolean,      // Required
    emit?: "success" | "filtered" | "all",  // What passes to next step: "success" (default), "filtered", or "all"
    verify?: VerifyConfig,
    retry?: RetryConfig,
    agent?: AgentOverride,
    mcpServers?: Record<string, McpServerConfig>,
    skills?: string[],                    // Skills for workers
    composio?: ComposioSetup,             // Composio Tool Router config
    systemPrompt?: string,
    timeoutMs?: number,
})

// Reduce step — same as swarm.reduce() + name (terminal: no steps after)
.reduce<T>({
    name?: string,
    prompt: string,
    schema?: z.ZodType<T> | JsonSchema,
    verify?: VerifyConfig,
    retry?: RetryConfig,
    agent?: AgentOverride,
    mcpServers?: Record<string, McpServerConfig>,
    skills?: string[],                    // Skills for workers
    composio?: ComposioSetup,             // Composio Tool Router config
    systemPrompt?: string,
    timeoutMs?: number,
})
```

### Full Example

```ts
const pipeline = new Pipeline(swarm)

    .map({
        name: "analyze",
        prompt: (files, idx) => `Analyze document ${idx + 1}`,
        schema: AnalysisSchema,
        bestOf: {
            n: 3,
            judgeCriteria: "Most thorough analysis",
        },
        retry: { maxAttempts: 2 },
        agent: { type: "claude", model: "opus" },
    })

    .filter({
        name: "quality-gate",
        prompt: "Rate the analysis quality",
        schema: z.object({
            score: z.number(),
            reasoning: z.string(),
        }),
        condition: d => d.score >= 8,
        emit: "success",                  // Only high-quality pass through
        verify: {
            criteria: "Rating must be justified with specific examples",
        },
    })

    .reduce({
        name: "synthesize",
        prompt: "Create executive summary from all analyses",
        schema: ReportSchema,
        verify: {
            criteria: "Summary must cover all key findings",
        },
    })

    .on("stepComplete", e => {
        console.log(`${e.name}: ${e.successCount}/${e.successCount + e.errorCount}`);
    });

const result = await pipeline.run(documents);
```

### Events

Pipeline unifies all Swarm callbacks at the pipeline level, adding `stepIndex` and `stepName`:

```ts
pipeline
    .on("stepStart", e => {
        console.log(`Step ${e.index} started with ${e.itemCount} items`);
    })
    .on("stepComplete", e => {
        console.log(`Step ${e.index} done in ${e.durationMs}ms`);
    })
    .on("stepError", e => {
        console.error(`Step ${e.index} failed:`, e.error);
    });

// Or object style
pipeline.on({
    onStepComplete: e => console.log(`${e.name}: ${e.successCount} success`),
    onItemRetry: e => console.log(`Retry: step ${e.stepIndex}, item ${e.itemIndex}`),
    onVerifierComplete: e => console.log(`Verify: ${e.passed ? "PASS" : e.feedback}`),
});
```

| Event | Fields |
|-------|--------|
| `stepStart` | `type`, `index`, `name?`, `itemCount` |
| `stepComplete` | `type`, `index`, `name?`, `durationMs`, `successCount`, `errorCount`, `filteredCount` |
| `stepError` | `type`, `index`, `name?`, `error` |
| `itemRetry` | `stepIndex`, `stepName?`, `itemIndex`, `attempt`, `error` |
| `workerComplete` | `stepIndex`, `stepName?`, `itemIndex`, `attempt`, `status` |
| `verifierComplete` | `stepIndex`, `stepName?`, `itemIndex`, `attempt`, `passed`, `feedback?` |
| `candidateComplete` | `stepIndex`, `stepName?`, `itemIndex`, `candidateIndex`, `status` |
| `judgeComplete` | `stepIndex`, `stepName?`, `itemIndex`, `winnerIndex`, `reasoning` |

### Result

```ts
interface PipelineResult<T> {
  pipelineRunId: string;
  steps: StepResult[];        // { type, index, durationMs, results }
  output: SwarmResult<T>[] | ReduceResult<T>;
  totalDurationMs: number;
}

// Access step results
for (const step of result.steps) {
  console.log(`${step.type} took ${step.durationMs}ms`);
}
```

### Terminal Pipeline

After `.reduce()`, no more steps can be added (returns `TerminalPipeline`):

```ts
const terminal = pipeline.reduce({ prompt: "..." });
terminal.map({ prompt: "..." });  // Throws: "Cannot add steps after reduce"
```

---
