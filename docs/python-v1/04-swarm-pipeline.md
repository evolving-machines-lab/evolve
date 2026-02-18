# Swarm Abstractions

Functional programming for AI agents: `map`, `filter`, `reduce`, `best_of`.

```python
from evolve import Swarm, SwarmConfig, AgentConfig, ComposioSetup, ComposioConfig
from pydantic import BaseModel  # Or use plain JSON Schema dicts instead

agent = AgentConfig(type='claude')

swarm = Swarm(SwarmConfig(
    agent=agent,                     # Default agent for all operations
    concurrency=4,                   # Max parallel sandboxes (default: 4)
    timeout_ms=3_600_000,            # Default timeout per worker (default: 1 hour)
    tag='my-pipeline',               # Tag prefix for observability
    skills=['pdf'],                  # Default skills (browser-use included by default)
    composio=ComposioSetup(          # Default Composio config for all workers
        user_id='user_123',
        config=ComposioConfig(toolkits=['gmail', 'notion']),
    ),
    mcp_servers={...},               # Default MCP servers for all workers
    retry=RetryConfig(               # Default retry config for all operations
        max_attempts=3,
        backoff_ms=1000,
        backoff_multiplier=2,
    ),
))
```

> **Defaults**: `agent`, `skills`, `composio`, `mcp_servers`, `timeout_ms`, and `retry` set here are inherited by all operations (`map`, `filter`, `reduce`, `best_of`). Pass these options to individual operations to override.

**SwarmConfig** — configuration for Swarm instance:
```python
SwarmConfig(
    agent=AgentConfig,
    skills=list[str],
    composio=ComposioSetup,
    mcp_servers=dict[str, McpServerConfig],
    concurrency=int,
    timeout_ms=int,
    tag=str,
    retry=RetryConfig,
)
```

| Option | Default | Notes |
|--------|---------|-------|
| `agent.type` | `'claude'` | Auto-resolved from env |
| `agent.model` | per type | `'opus'` (claude), `'gpt-5.2'` (codex), etc. |
| `skills` | `None` | Set here or per-operation |
| `composio` | `None` | Set here or per-operation |
| `mcp_servers` | `None` | Set here or per-operation |
| `concurrency` | `4` | Max parallel sandboxes |
| `timeout_ms` | `3_600_000` | 1 hour per worker |
| `tag` | `'swarm'` | Observability prefix |
| `retry` | `None` | Set here or per-operation |

**Minimal setup** — with `EVOLVE_API_KEY` set (see [1.1 Authentication](#11-authentication)):

```python
from dotenv import load_dotenv
load_dotenv()  # If using .env file

from evolve import Swarm

swarm = Swarm()  # Auto-resolves agent (claude) and sandbox from env
```

**RetryConfig** — auto-retry on error with exponential backoff:
```python
RetryConfig(
    max_attempts=3,
    backoff_ms=1000,
    backoff_multiplier=2,
    retry_on=lambda r: r.status == 'error',        # Custom condition
    on_item_retry=lambda idx, attempt, error: ..., # Callback
)
```

## 1. Input Types

Swarm runs in **knowledge mode** by default—files are uploaded to `context/` in the sandbox.

**FileMap structure:**

```python
# FileMap: dict[path, content]
#   - path: str              → file path in context/ folder
#   - content: str | bytes   → file content

FileMap = dict[str, str | bytes]
```

---

**Case 1: One file per worker**

```python
# 3 workers, each gets 1 file
items: list[FileMap] = [
    {'report.txt': 'Q1 revenue...'},      # → Worker 0: context/report.txt
    {'report.txt': 'Q2 revenue...'},      # → Worker 1: context/report.txt
    {'report.txt': 'Q3 revenue...'},      # → Worker 2: context/report.txt
]

results = await swarm.map(
    items=items,
    prompt='Summarize this report',
)
```

---

**Case 2: Multiple files per worker**

```python
# 3 workers, each gets 2 files
items: list[FileMap] = [
    {                                       # → Worker 0:
        'doc1.pdf': open('./doc1.pdf', 'rb').read(),  #   context/doc1.pdf
        'doc2.pdf': open('./doc2.pdf', 'rb').read(),  #   context/doc2.pdf
    },
    {                                       # → Worker 1:
        'doc3.pdf': open('./doc3.pdf', 'rb').read(),  #   context/doc3.pdf
        'doc4.pdf': open('./doc4.pdf', 'rb').read(),  #   context/doc4.pdf
    },
    {                                       # → Worker 2:
        'doc5.pdf': open('./doc5.pdf', 'rb').read(),  #   context/doc5.pdf
        'doc6.pdf': open('./doc6.pdf', 'rb').read(),  #   context/doc6.pdf
    },
]

results = await swarm.map(
    items=items,
    prompt='Compare these two documents',
)
```

---

**Case 3: Entire folder per worker**

```python
from evolve import read_local_dir

# read_local_dir(path, recursive) → returns FileMap with all files
items: list[FileMap] = [
    read_local_dir('./project-a', recursive=True),   # → Worker 0: all files from project-a
    read_local_dir('./project-b', recursive=True),   # → Worker 1: all files from project-b
    read_local_dir('./project-c', recursive=True),   # → Worker 2: all files from project-c
]

results = await swarm.map(
    items=items,
    prompt='Review this codebase',
)
```

## 2. Abstractions

Two types of operations:

| Operation | Type | Description | Passes On |
|-----------|------|-------------|-----------|
| `best_of` | transform + select | `input` → `output` (best of N candidates) | winner output |
| `map` | transform | `input` → `output` (agent produces new data) | agent output |
| `filter` | gate | `input` → `input` (agent evaluates, condition decides) | original input + status (`success` \| `filtered`) |
| `reduce` | transform | `inputs` → `output` (agent synthesizes) | agent output |

**Transforms** produce new output files. **Filter** passes through original input files unchanged.

**BestOfConfig** — run N candidates in parallel, judge picks the best:
```python
BestOfConfig(
    n=int,
    judge_criteria=str,
    task_agents=list[AgentConfig],
    judge_agent=AgentConfig,
    skills=list[str],
    judge_skills=list[str],
    composio=ComposioSetup,
    judge_composio=ComposioSetup,
    mcp_servers=dict[str, McpServerConfig],
    judge_mcp_servers=dict[str, McpServerConfig],
    on_candidate_complete=Callable[[int, int, str], None],
    on_judge_complete=Callable[[int, int, str], None],
)
```

**VerifyConfig** — LLM-as-judge verifies output, retries with feedback if failed:
```python
VerifyConfig(
    criteria=str,
    max_attempts=int,
    verifier_agent=AgentConfig,
    verifier_skills=list[str],
    verifier_composio=ComposioSetup,
    verifier_mcp_servers=dict[str, McpServerConfig],
    on_worker_complete=Callable[[int, int, str], None],
    on_verifier_complete=Callable[[int, int, bool, str | None], None],
)
```

### 2.1 best_of

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

```python
# Signature
await swarm.best_of(
    item=FileMap | SwarmResult,
    prompt=str,
    config=BestOfConfig(                    # n?, judge_criteria, task_agents?, judge_agent?, callbacks
        judge_criteria='...',
        n=3,
        on_candidate_complete=lambda idx, cand_idx, status: ...,
        on_judge_complete=lambda idx, winner_idx, reasoning: ...,
    ),
    name=str,                               # Operation name for observability (appears in meta.operation_name)
    schema=PydanticModel | dict,            # Optional
    system_prompt=str,                      # Optional
    retry=RetryConfig(...),                 # Per-candidate retry (judge uses default)
    timeout_ms=int,                         # Optional
) -> BestOfResult
```

```python
input_item = {'task.txt': 'Complex problem...'}

result = await swarm.best_of(
    item=input_item,
    prompt='Solve this problem',
    config=BestOfConfig(
        n=3,
        judge_criteria='Most accurate and well-explained solution',
        on_candidate_complete=lambda idx, cand_idx, status: print(f'Candidate {cand_idx}: {status}'),
        on_judge_complete=lambda idx, winner_idx, reasoning: print(f'Winner: {winner_idx}'),
    ),
)

print(result.winner)          # Best SwarmResult
print(result.winner_index)    # 0, 1, or 2
print(result.judge_reasoning) # Why this was chosen
print(result.candidates)      # All candidate results
```

Use different agents per candidate:

```python
claude_agent = AgentConfig(type='claude', model='opus')
codex_agent = AgentConfig(type='codex', model='gpt-5.2-codex')
gemini_agent = AgentConfig(type='gemini', model='gemini-3-flash')

result = await swarm.best_of(
    item=input_item,
    prompt='Solve this',
    config=BestOfConfig(
        task_agents=[claude_agent, codex_agent, gemini_agent],
        judge_criteria='Best solution quality',
        judge_agent=claude_agent,
        mcp_servers={...},           # (optional) MCP servers for candidates
        judge_mcp_servers={...},     # (optional) MCP servers for judge
        skills=['pdf'],              # (optional) Skills for candidates
        judge_skills=['pdf'],        # (optional) Skills for judge
        composio=ComposioSetup(...), # (optional) Composio config for candidates
        judge_composio=ComposioSetup(...),  # (optional) Composio config for judge
    ),
)
```

### 2.2 map

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

```python
# Signature (schema accepts Pydantic model or JSON Schema dict)
await swarm.map(
    items=list[FileMap] | list[SwarmResult],
    prompt=str | Callable[[FileMap, int], str],
    name=str,                               # Operation name for observability (appears in meta.operation_name)
    schema=PydanticModel | dict,            # Optional
    system_prompt=str,                      # Optional
    agent=AgentConfig,                      # Optional override
    best_of=BestOfConfig,                   # N candidates + judge (mutually exclusive with verify)
    verify=VerifyConfig,                    # LLM-as-judge quality check with retry loop
    retry=RetryConfig,                      # Auto-retry on error with backoff
    mcp_servers=dict[str, McpServerConfig], # Optional
    skills=list[str],                       # Optional - e.g. ['pdf']
    composio=ComposioSetup,                 # Composio Tool Router config
    timeout_ms=int,                         # Optional
) -> SwarmResultList
```

```python
# Basic
results = await swarm.map(
    items=documents,
    prompt='Summarize this document',
)
```

When `schema` is provided, a structured output prompt is automatically embedded—instructing the agent to write `output/result.json` matching the schema.

```python
# With Pydantic schema
class SummarySchema(BaseModel):
    title: str
    key_points: list[str]

results = await swarm.map(
    items=documents,
    prompt='Extract summary',
    schema=SummarySchema,
)

# Or with JSON Schema
summary_json_schema = {
    'type': 'object',
    'properties': {
        'title': {'type': 'string'},
        'key_points': {'type': 'array', 'items': {'type': 'string'}},
    },
    'required': ['title', 'key_points'],
}

results = await swarm.map(
    items=documents,
    prompt='Extract summary',
    schema=summary_json_schema,
)

# With dynamic prompt
results = await swarm.map(
    items=documents,
    prompt=lambda files, index: f'Analyze document {index + 1}: focus on revenue',
)

# Access results
for r in results:
    if r.status == 'success':
        print(r.data)   # Parsed schema instance or FileMap
        print(r.files)  # Output files from agent
```

### 2.3 map with best_of

Combine map parallelism with best_of quality:

```python
class AnalysisSchema(BaseModel):
    findings: list[str]
    confidence: float

# Each item gets N candidates, judge picks best per item
results = await swarm.map(
    items=documents,
    prompt='Analyze thoroughly',
    schema=AnalysisSchema,
    best_of=BestOfConfig(
        n=3,
        judge_criteria='Most comprehensive analysis',
        # task_agents=[...],       # Different agent per candidate
        # judge_agent=...,         # Override judge agent
        # mcp_servers={...},       # MCP servers for candidates
        # judge_mcp_servers={...}, # MCP servers for judge
        # skills=[...],            # Skills for candidates
        # judge_skills=[...],      # Skills for judge
    ),
)

# Results contain only winners (one per input item)
```

### 2.4 filter

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

```python
# Signature (schema accepts Pydantic model or JSON Schema dict)
await swarm.filter(
    items=list[FileMap] | list[SwarmResult],
    prompt=str,                             # Describe what to assess (agent outputs result.json)
    name=str,                               # Operation name for observability (appears in meta.operation_name)
    schema=PydanticModel | dict,            # Required - defines evaluation output structure
    condition=Callable[[Any], bool],        # Local function applies threshold
    system_prompt=str,                      # Optional
    agent=AgentConfig,                      # Optional override
    verify=VerifyConfig,                    # LLM-as-judge quality check with retry loop
    retry=RetryConfig,                      # Auto-retry on error with backoff
    mcp_servers=dict[str, McpServerConfig], # Optional
    skills=list[str],                       # Optional - e.g. ['pdf']
    composio=ComposioSetup,                 # Composio Tool Router config
    timeout_ms=int,                         # Optional
) -> SwarmResultList
```

```python
class EvalSchema(BaseModel):
    severity: Literal['critical', 'warning', 'info']
    score: float

results = await swarm.filter(
    items=documents,
    prompt='Assess the severity of issues in this document',  # Agent evaluates
    schema=EvalSchema,
    condition=lambda data: data.severity == 'critical',       # Code applies threshold
)

# Three possible statuses:
results.success    # Passed condition
results.filtered   # Evaluated but didn't pass
results.error      # Agent error

# Chain to next step
await swarm.reduce(
    items=results.success,
    prompt='Summarize critical issues',
)
```

### 2.5 reduce

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

```python
# Signature (schema accepts Pydantic model or JSON Schema dict)
await swarm.reduce(
    items=list[FileMap] | list[SwarmResult],
    prompt=str,
    name=str,                               # Operation name for observability (appears in meta.operation_name)
    schema=PydanticModel | dict,            # Optional
    system_prompt=str,                      # Optional
    agent=AgentConfig,                      # Optional override
    verify=VerifyConfig,                    # LLM-as-judge quality check with retry loop
    retry=RetryConfig,                      # Auto-retry on error with backoff
    mcp_servers=dict[str, McpServerConfig], # Optional
    skills=list[str],                       # Optional - e.g. ['pdf']
    composio=ComposioSetup,                 # Composio Tool Router config
    timeout_ms=int,                         # Optional
) -> ReduceResult
```

```python
# Agent sees: item_0/, item_1/, item_2/, etc.
report = await swarm.reduce(
    items=results.success,
    prompt='Create a unified report from all analyses',
)

if report.status == 'success':
    print(report.files)  # Final output files
    print(report.data)   # Parsed schema if provided

# With schema
class ReportSchema(BaseModel):
    summary: str
    recommendations: list[str]

report = await swarm.reduce(
    items=items,
    prompt='Create report',
    schema=ReportSchema,
)
```

## 3. Result Types

```python
@dataclass
class SwarmResult:
    """Result from map, filter, best_of candidates."""
    status: Literal['success', 'filtered', 'error']
    data: Any | None        # Parsed schema, or None on error
    files: FileMap          # Output files (map/best_of) or input files (filter)
    meta: IndexedMeta       # operation_id, operation, tag, sandbox_id, item_index
    error: str | None       # Error message if status == 'error'
    raw_data: str | None    # Raw result.json when parse/validation failed
    best_of: BestOfInfo | None  # Present when map used best_of option
    verify: VerifyInfo | None   # Present when verify option was used

# SwarmResultList - from map, filter (extends list)
results.success    # list[SwarmResult] with status 'success'
results.filtered   # list[SwarmResult] with status 'filtered'
results.error      # list[SwarmResult] with status 'error'

@dataclass
class ReduceResult:
    """Result from reduce."""
    status: Literal['success', 'error']
    data: Any | None
    files: FileMap
    meta: ReduceMeta        # operation_id, operation, tag, sandbox_id, input_count, input_indices
    error: str | None
    raw_data: str | None
    verify: VerifyInfo | None

@dataclass
class VerifyInfo:
    """Verification outcome."""
    passed: bool            # Final verification status
    reasoning: str          # Verifier's reasoning
    verify_meta: VerifyMeta # operation_id, operation, tag, sandbox_id, attempts
    attempts: int           # Total attempts made

@dataclass
class BestOfInfo:
    """Present when map used best_of option."""
    winner_index: int
    judge_reasoning: str
    judge_meta: JudgeMeta   # operation_id, operation, tag, sandbox_id, candidate_count
    candidates: list[SwarmResult]

@dataclass
class BestOfResult:
    """Result from best_of."""
    winner: SwarmResult
    winner_index: int
    judge_reasoning: str
    judge_meta: JudgeMeta   # operation_id, operation, tag, sandbox_id, candidate_count
    candidates: list[SwarmResult]
```

## 4. Chaining Operations

When chaining Swarm operations, `result.json` from a previous step is automatically renamed to `data.json`. This avoids confusion when the downstream agent writes its own `result.json`. This also applies to [Pipeline](#7-pipeline).

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

```python
class AnalysisSchema(BaseModel):
    summary: str

class SeveritySchema(BaseModel):
    severity: Literal['critical', 'warning', 'info']

# Full pipeline: map → filter → reduce
analyzed = await swarm.map(
    items=documents,
    prompt='Analyze',
    schema=AnalysisSchema,
)

critical = await swarm.filter(
    items=analyzed.success,
    prompt='Evaluate severity',
    schema=SeveritySchema,
    condition=lambda d: d.severity == 'critical',
)

report = await swarm.reduce(
    items=critical.success,
    prompt='Create summary report',
)

# Combine success and filtered
all_evaluated = [*critical.success, *critical.filtered]
await swarm.reduce(
    items=all_evaluated,
    prompt='Summarize all evaluated items',
)
```

## 5. AgentOverride

Override the default agent for any operation (api_key inherited from Swarm config):

```python
@dataclass
class AgentConfig:
    type: Literal['claude', 'codex', 'gemini', 'qwen', 'kimi', 'opencode']
    api_key: str | None = None
    model: str | None = None
    reasoning_effort: Literal['low', 'medium', 'high', 'xhigh'] | None = None  # Codex only
    betas: list[str] | None = None  # Claude only
```

```python
codex_agent = AgentConfig(
    type='codex',
    reasoning_effort='high',
)

results = await swarm.map(
    items=items,
    prompt='Analyze',
    agent=codex_agent,
)
```

## 6. Concurrency

Global semaphore limits parallel sandboxes across all operations.

```python
swarm = Swarm(SwarmConfig(
    agent=agent,
    concurrency=4,  # Max 4 sandboxes at once (default: 4)
))

# map(10) with best_of(5) = 60 agent calls, but only 4 run at any time
```

**Ordering guarantees:**
- `best_of`: Judge runs only after all candidates complete
- `map` → `filter` → `reduce`: Each phase completes before next starts
- Within a phase: Items run in parallel (up to concurrency limit)

---

## 7. Pipeline

Fluent wrapper over Swarm for chaining operations. **All Swarm features work in Pipeline steps** — `schema`, `best_of`, `verify`, `retry`, `agent`, `mcp_servers`, `skills`, `composio`, dynamic prompts.

```python
from dotenv import load_dotenv
load_dotenv()

from evolve import Swarm, Pipeline

swarm = Swarm()  # See Swarm Abstractions for full config

pipeline = (
    Pipeline(swarm)
    .map(MapConfig(
        name='analyze',
        prompt='Analyze...',
        schema=AnalysisSchema,
    ))
    .filter(FilterConfig(
        name='critical',
        prompt='Rate...',
        schema=SeveritySchema,
        condition=lambda d: d.severity == 'critical',
    ))
    .reduce(ReduceConfig(
        name='report',
        prompt='Summarize...',
    ))
)

# Reusable — run with different data
result1 = await pipeline.run(batch1)
result2 = await pipeline.run(batch2)
```

### Step Configurations

Each step accepts the same options as the corresponding Swarm method, plus `name` for observability:

```python
# Map step — same as swarm.map() + name
MapConfig(
    name=str,                               # Step name (appears in events)
    prompt=str | Callable[[FileMap, int], str],
    schema=PydanticModel | dict,            # Optional
    best_of=BestOfConfig,                   # N candidates + judge
    verify=VerifyConfig,                    # LLM-as-judge quality check
    retry=RetryConfig,                      # Auto-retry on error
    agent=AgentConfig,
    mcp_servers=dict[str, McpServerConfig],
    skills=list[str],                       # Skills for workers
    composio=ComposioSetup,                 # Composio Tool Router config
    system_prompt=str,
    timeout_ms=int,
)

# Filter step — same as swarm.filter() + name + emit
FilterConfig(
    name=str,
    prompt=str,
    schema=PydanticModel | dict,            # Required
    condition=Callable[[Any], bool],        # Required
    emit='success' | 'filtered' | 'all',    # What passes to next step (default: 'success')
    verify=VerifyConfig,
    retry=RetryConfig,
    agent=AgentConfig,
    mcp_servers=dict[str, McpServerConfig],
    skills=list[str],                       # Skills for workers
    composio=ComposioSetup,                 # Composio Tool Router config
    system_prompt=str,
    timeout_ms=int,
)

# Reduce step — same as swarm.reduce() + name (terminal: no steps after)
ReduceConfig(
    name=str,
    prompt=str,
    schema=PydanticModel | dict,            # Optional
    verify=VerifyConfig,
    retry=RetryConfig,
    agent=AgentConfig,
    mcp_servers=dict[str, McpServerConfig],
    skills=list[str],                       # Skills for workers
    composio=ComposioSetup,                 # Composio Tool Router config
    system_prompt=str,
    timeout_ms=int,
)
```

### Full Example

```python
pipeline = (
    Pipeline(swarm)

    .map(MapConfig(
        name='analyze',
        prompt=lambda files, idx: f'Analyze document {idx + 1}',
        schema=AnalysisSchema,
        best_of=BestOfConfig(
            n=3,
            judge_criteria='Most thorough analysis',
        ),
        retry=RetryConfig(max_attempts=2),
        agent=AgentConfig(type='claude', model='opus'),
    ))

    .filter(FilterConfig(
        name='quality-gate',
        prompt='Rate the analysis quality',
        schema=QualitySchema,  # Has score: float, reasoning: str
        condition=lambda d: d.score >= 8,
        emit='success',                     # Only high-quality pass through
        verify=VerifyConfig(
            criteria='Rating must be justified with specific examples',
        ),
    ))

    .reduce(ReduceConfig(
        name='synthesize',
        prompt='Create executive summary from all analyses',
        schema=ReportSchema,
        verify=VerifyConfig(
            criteria='Summary must cover all key findings',
        ),
    ))

    .on('step_complete', lambda e: print(f'{e.name}: {e.success_count}/{e.success_count + e.error_count}'))
)

result = await pipeline.run(documents)
```

### Events

Pipeline unifies all Swarm callbacks at the pipeline level, adding `step_index` and `step_name`:

```python
(
    pipeline
    .on('step_start', lambda e: print(f'Step {e.index} started with {e.item_count} items'))
    .on('step_complete', lambda e: print(f'Step {e.index} done in {e.duration_ms}ms'))
    .on('step_error', lambda e: print(f'Step {e.index} failed: {e.error}'))
)

# Or object style
pipeline.on(PipelineEvents(
    on_step_complete=lambda e: print(f'{e.name}: {e.success_count} success'),
    on_item_retry=lambda e: print(f'Retry: step {e.step_index}, item {e.item_index}'),
    on_verifier_complete=lambda e: print(f"Verify: {'PASS' if e.passed else e.feedback}"),
))
```

| Event | Fields |
|-------|--------|
| `step_start` | `type`, `index`, `name?`, `item_count` |
| `step_complete` | `type`, `index`, `name?`, `duration_ms`, `success_count`, `error_count`, `filtered_count` |
| `step_error` | `type`, `index`, `name?`, `error` |
| `item_retry` | `step_index`, `step_name?`, `item_index`, `attempt`, `error` |
| `worker_complete` | `step_index`, `step_name?`, `item_index`, `attempt`, `status` |
| `verifier_complete` | `step_index`, `step_name?`, `item_index`, `attempt`, `passed`, `feedback?` |
| `candidate_complete` | `step_index`, `step_name?`, `item_index`, `candidate_index`, `status` |
| `judge_complete` | `step_index`, `step_name?`, `item_index`, `winner_index`, `reasoning` |

### Result

```python
@dataclass
class PipelineResult:
    pipeline_run_id: str
    steps: list[StepResult]   # type, index, duration_ms, results
    output: list[SwarmResult] | ReduceResult
    total_duration_ms: int

# Access step results
for step in result.steps:
    print(f'{step.type} took {step.duration_ms}ms')
```

### Terminal Pipeline

After `.reduce()`, no more steps can be added (returns `TerminalPipeline`):

```python
terminal = pipeline.reduce(ReduceConfig(prompt='...'))
terminal.map(MapConfig(prompt='...'))  # Raises: "Cannot add steps after reduce"
```

---
