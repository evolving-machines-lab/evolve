# Appendix: Types and Reference Blocks

This appendix keeps exhaustive interfaces and prompt templates in one place so core docs stay compact.

## Filesystem Instruction Template (default)

```text
## FILESYSTEM INSTRUCTIONS

You are running in a sandbox environment.

Present working directory: /home/user/workspace/

IMPORTANT - Directory structure:
/home/user/workspace/
├── context/   # Input files (read-only) provided by the user
├── scripts/   # Your code goes here
├── temp/      # Scratch space
└── output/    # Final deliverables

## OUTPUT RESULTS (DELIVERABLES) MUST BE SAVED to `output/` as files.
```

Any `systemPrompt` text is appended after this default in `CLAUDE.md` / `AGENT.md` / `GEMINI.md` / `QWEN.md`.

## Structured Output Prompt Template

When schema is set, SDK appends a schema-specific structured output block. Canonical shape:

```text
## STRUCTURED OUTPUT

Your final result MUST be saved to `output/result.json` following this schema:

{...schema JSON...}

You are free to:
- Reason through the problem step by step
- Read and analyze context files
- Use any available tools
- Process incrementally
- Create intermediate files in `temp/` or `scripts/`

But your final `output/result.json` MUST conform to the schema above.

### OUTPUT RESULTS (DELIVERABLES) MUST BE WRITTEN to `output/result.json` as files.
### Never just state results as text.
```

## Core Runtime Types

```ts
type AgentResponse = {
  sandboxId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  checkpoint?: CheckpointInfo;
};

interface OutputResult<T = unknown> {
  files: FileMap;
  data: T | null;
  error?: string;
  rawData?: string;
}
```

## MCP and Composio Types

```ts
interface McpServerConfig {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
}

interface ComposioSetup {
  userId: string;
  config?: ComposioConfig;
}

interface ComposioConfig {
  toolkits?: string[];
  tools?: Record<string, ToolsFilter>;
  keys?: Record<string, string>;
  authConfigs?: Record<string, string>;
}

type ToolsFilter =
  | string[]
  | { enable: string[] }
  | { disable: string[] }
  | { tags: string[] };
```

## Streaming Types

```ts
interface LifecycleEvent {
  sandboxId: string | null;
  sandbox: SandboxLifecycleState;
  agent: AgentRuntimeState;
  timestamp: string;
  reason: LifecycleReason;
}

type SandboxLifecycleState =
  | "booting"
  | "error"
  | "ready"
  | "running"
  | "paused"
  | "stopped";

type AgentRuntimeState =
  | "idle"
  | "running"
  | "interrupted"
  | "error";

type LifecycleReason =
  | "sandbox_boot"
  | "sandbox_ready"
  | "sandbox_connected"
  | "sandbox_pause"
  | "sandbox_resume"
  | "sandbox_killed"
  | "sandbox_error"
  | "run_start"
  | "run_complete"
  | "run_interrupted"
  | "run_failed"
  | "run_background_complete"
  | "run_background_failed"
  | "command_start"
  | "command_complete"
  | "command_failed"
  | "command_interrupted"
  | "command_background_complete"
  | "command_background_failed";

interface OutputEvent {
  sessionId?: string;
  update: SessionUpdate;
}

type SessionUpdate =
  | AgentMessageChunk
  | AgentThoughtChunk
  | UserMessageChunk
  | ToolCall
  | ToolCallUpdate
  | Plan;

interface AgentMessageChunk {
  sessionUpdate: "agent_message_chunk";
  content: ContentBlock;
}

interface AgentThoughtChunk {
  sessionUpdate: "agent_thought_chunk";
  content: ContentBlock;
}

interface UserMessageChunk {
  sessionUpdate: "user_message_chunk";
  content: ContentBlock;
}

interface ToolCall {
  sessionUpdate: "tool_call";
  toolCallId: string;
  title: string;
  kind: ToolKind;
  status: ToolCallStatus;
  rawInput?: unknown;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
}

interface ToolCallUpdate {
  sessionUpdate: "tool_call_update";
  toolCallId: string;
  status?: ToolCallStatus;
  title?: string;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
}

interface Plan {
  sessionUpdate: "plan";
  entries: PlanEntry[];
}

interface PlanEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

type ContentBlock = TextContent | ImageContent;

interface TextContent {
  type: "text";
  text: string;
}

interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
  uri?: string;
}

type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

type ToolCallStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed";

interface ToolCallLocation {
  path: string;
  line?: number;
}

type ToolCallContent =
  | { type: "content"; content: ContentBlock }
  | DiffContent;

interface DiffContent {
  type: "diff";
  path: string;
  oldText: string | null;
  newText: string;
}

interface BrowserUseResponse {
  task_id?: string;
  session_id?: string;
  live_url?: string;
  screenshot_url?: string;
  steps?: Array<{
    step_number: number;
    screenshot_url?: string;
    url?: string;
    memory?: string;
  }>;
  is_success?: boolean | null;
  task_output?: string | null;
}
```

## Storage Types

```ts
interface StorageConfig {
  url?: string;
  bucket?: string;
  prefix?: string;
  region?: string;
  endpoint?: string;
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
  };
}

interface CheckpointInfo {
  id: string;
  hash: string;
  tag: string;
  timestamp: string;
  sizeBytes?: number;
  agentType?: string;
  model?: string;
  workspaceMode?: string;
  parentId?: string;
  comment?: string;
}
```

## Swarm Types

```ts
type FileMap = Record<string, string | Uint8Array>;

interface AgentOverride {
  type: "claude" | "codex" | "gemini" | "qwen" | "kimi" | "opencode";
  model?: string;
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  betas?: string[];
}

interface RetryConfig {
  maxAttempts?: number;
  backoffMs?: number;
  backoffMultiplier?: number;
  retryOn?: (result: unknown) => boolean;
  onItemRetry?: (idx: number, attempt: number, error: unknown) => void;
}

interface SwarmConfig {
  agent?: AgentOverride;
  skills?: string[];
  composio?: ComposioSetup;
  mcpServers?: Record<string, McpServerConfig>;
  concurrency?: number;
  timeoutMs?: number;
  tag?: string;
  retry?: RetryConfig;
}

interface BestOfConfig {
  n?: number;
  judgeCriteria: string;
  taskAgents?: AgentOverride[];
  judgeAgent?: AgentOverride;
  skills?: string[];
  judgeSkills?: string[];
  composio?: ComposioSetup;
  judgeComposio?: ComposioSetup;
  mcpServers?: Record<string, McpServerConfig>;
  judgeMcpServers?: Record<string, McpServerConfig>;
  onCandidateComplete?: (idx: number, candIdx: number, status: string) => void;
  onJudgeComplete?: (idx: number, winnerIdx: number, reasoning: string) => void;
}

interface VerifyConfig {
  criteria: string;
  maxAttempts?: number;
  verifierAgent?: AgentOverride;
  verifierSkills?: string[];
  verifierComposio?: ComposioSetup;
  verifierMcpServers?: Record<string, McpServerConfig>;
  onWorkerComplete?: (idx: number, attempt: number, status: string) => void;
  onVerifierComplete?: (idx: number, attempt: number, passed: boolean, feedback?: string) => void;
}

interface IndexedMeta {
  operationId: string;
  operation: string;
  tag: string;
  sandboxId: string;
  itemIndex: number;
  operationName?: string;
}

interface ReduceMeta {
  operationId: string;
  operation: string;
  tag: string;
  sandboxId: string;
  inputCount: number;
  inputIndices: number[];
  operationName?: string;
}

interface JudgeMeta {
  operationId: string;
  operation: string;
  tag: string;
  sandboxId: string;
  candidateCount: number;
  operationName?: string;
}

interface VerifyMeta {
  operationId: string;
  operation: string;
  tag: string;
  sandboxId: string;
  attempts: number;
  operationName?: string;
}

interface VerifyInfo {
  passed: boolean;
  reasoning: string;
  verifyMeta: VerifyMeta;
  attempts: number;
}

interface SwarmResult<T> {
  status: "success" | "filtered" | "error";
  data: T | null;
  files: FileMap;
  meta: IndexedMeta;
  error?: string;
  rawData?: string;
  bestOf?: {
    winnerIndex: number;
    judgeReasoning: string;
    judgeMeta: JudgeMeta;
    candidates: SwarmResult<T>[];
  };
  verify?: VerifyInfo;
}

interface ReduceResult<T> {
  status: "success" | "error";
  data: T | null;
  files: FileMap;
  meta: ReduceMeta;
  error?: string;
  rawData?: string;
  verify?: VerifyInfo;
}

interface BestOfResult<T> {
  winner: SwarmResult<T>;
  winnerIndex: number;
  judgeReasoning: string;
  judgeMeta: JudgeMeta;
  candidates: SwarmResult<T>[];
}

interface PipelineResult<T> {
  pipelineRunId: string;
  steps: StepResult[];
  output: SwarmResult<T>[] | ReduceResult<T>;
  totalDurationMs: number;
}

interface StepResult {
  type: "map" | "filter" | "reduce";
  index: number;
  name?: string;
  durationMs: number;
  results: unknown;
}
```

## Pipeline Event Fields

| Event | Fields |
|---|---|
| `stepStart` | `type`, `index`, `name?`, `itemCount` |
| `stepComplete` | `type`, `index`, `name?`, `durationMs`, `successCount`, `errorCount`, `filteredCount` |
| `stepError` | `type`, `index`, `name?`, `error` |
| `itemRetry` | `stepIndex`, `stepName?`, `itemIndex`, `attempt`, `error` |
| `workerComplete` | `stepIndex`, `stepName?`, `itemIndex`, `attempt`, `status` |
| `verifierComplete` | `stepIndex`, `stepName?`, `itemIndex`, `attempt`, `passed`, `feedback?` |
| `candidateComplete` | `stepIndex`, `stepName?`, `itemIndex`, `candidateIndex`, `status` |
| `judgeComplete` | `stepIndex`, `stepName?`, `itemIndex`, `winnerIndex`, `reasoning` |
