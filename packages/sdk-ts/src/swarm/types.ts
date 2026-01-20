/**
 * Swarm Abstractions - Type Definitions
 *
 * Functional programming for AI agents.
 * map, filter, reduce, bestOf - with AI reasoning.
 */

import type { z } from "zod";
import type {
  AgentConfig,
  AgentType,
  ReasoningEffort,
  SandboxProvider,
  FileMap,
  JsonSchema,
  SchemaValidationOptions,
  WorkspaceMode,
  McpServerConfig,
  SkillName,
  ComposioConfig,
  ComposioSetup,
} from "../types";
import type { RetryConfig } from "../utils/retry";

// Re-export for convenience
export type { FileMap, ComposioConfig, ComposioSetup } from "../types";
export type { RetryConfig, OnItemRetryCallback } from "../utils/retry";

// =============================================================================
// BRAND (runtime detection for chaining)
// =============================================================================

export const SWARM_RESULT_BRAND = Symbol.for("evolve.SwarmResult");

// =============================================================================
// CONFIGURATION
// =============================================================================

/** Agent override for method options (apiKey inherited from Swarm instance) */
export interface AgentOverride {
  type: AgentType;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  betas?: string[];
}

export interface SwarmConfig {
  /** Default agent for all operations (defaults to env resolution) */
  agent?: AgentConfig;
  /** Sandbox provider (defaults to E2B via E2B_API_KEY env var) */
  sandbox?: SandboxProvider;
  /** User prefix for worker tags */
  tag?: string;
  /** Max parallel sandboxes globally (default: 4) */
  concurrency?: number;
  /** Per-worker timeout in ms (default: 1 hour) */
  timeoutMs?: number;
  /** Workspace mode (default: SDK default 'knowledge') */
  workspaceMode?: WorkspaceMode;
  /** Default retry configuration for all operations (per-operation config takes precedence) */
  retry?: RetryConfig;
  /** Default MCP servers for all operations (per-operation config takes precedence) */
  mcpServers?: Record<string, McpServerConfig>;
  /** Default skills for all operations (per-operation config takes precedence) */
  skills?: SkillName[];
  /** Default Composio configuration for all operations (per-operation config takes precedence) */
  composio?: ComposioSetup;
}

/** Callback for bestOf candidate completion */
export type OnCandidateCompleteCallback = (itemIndex: number, candidateIndex: number, status: "success" | "error") => void;

/** Callback for bestOf judge completion */
export type OnJudgeCompleteCallback = (itemIndex: number, winnerIndex: number, reasoning: string) => void;

export interface BestOfConfig {
  /** Number of candidates (>= 2). Required if taskAgents omitted, else inferred from taskAgents.length */
  n?: number;
  /** Evaluation criteria for judge */
  judgeCriteria: string;
  /** Optional: agents for each candidate. If provided, n defaults to taskAgents.length */
  taskAgents?: AgentOverride[];
  /** Optional: override agent for judge */
  judgeAgent?: AgentOverride;
  /** MCP servers for candidates (defaults to operation mcpServers) */
  mcpServers?: Record<string, McpServerConfig>;
  /** MCP servers for judge (defaults to mcpServers) */
  judgeMcpServers?: Record<string, McpServerConfig>;
  /** Skills for candidates (defaults to operation skills) */
  skills?: SkillName[];
  /** Skills for judge (defaults to skills) */
  judgeSkills?: SkillName[];
  /** Composio config for candidates (defaults to operation composio) */
  composio?: ComposioSetup;
  /** Composio config for judge (defaults to composio) */
  judgeComposio?: ComposioSetup;
  /** Callback when a candidate completes */
  onCandidateComplete?: OnCandidateCompleteCallback;
  /** Callback when judge completes */
  onJudgeComplete?: OnJudgeCompleteCallback;
}

/** Callback for verify worker completion (before verification runs) */
export type OnWorkerCompleteCallback = (itemIndex: number, attempt: number, status: "success" | "error") => void;

/** Callback for verifier completion */
export type OnVerifierCompleteCallback = (itemIndex: number, attempt: number, passed: boolean, feedback?: string) => void;

export interface VerifyConfig {
  /** Verification criteria - what the output must satisfy */
  criteria: string;
  /** Maximum attempts with feedback (default: 3). Includes initial attempt. */
  maxAttempts?: number;
  /** Optional: override agent for verifier */
  verifierAgent?: AgentOverride;
  /** MCP servers for verifier (defaults to operation mcpServers) */
  verifierMcpServers?: Record<string, McpServerConfig>;
  /** Skills for verifier (defaults to operation skills) */
  verifierSkills?: SkillName[];
  /** Composio config for verifier (defaults to operation composio) */
  verifierComposio?: ComposioSetup;
  /** Callback invoked after each worker completion (before verification) */
  onWorkerComplete?: OnWorkerCompleteCallback;
  /** Callback invoked after each verifier completion */
  onVerifierComplete?: OnVerifierCompleteCallback;
}

// =============================================================================
// METADATA
// =============================================================================

export type OperationType =
  | "map"
  | "filter"
  | "reduce"
  | "bestof-cand"
  | "bestof-judge"
  | "verify";

export interface BaseMeta {
  /** Unique identifier for this operation (map/filter/reduce/bestOf call) */
  operationId: string;
  operation: OperationType;
  tag: string;
  sandboxId: string;
  /** Swarm name (from Swarm.config.tag) - identifies the swarm instance */
  swarmName?: string;
  /** Operation name (from params.name) - user-defined label for this operation */
  operationName?: string;

  // Retry tracking (optional - only present when retrying)
  /** Error retry number (1, 2, 3...) - only present when retrying after error */
  errorRetry?: number;
  /** Verify retry number (1, 2, 3...) - only present when retrying after verify failure */
  verifyRetry?: number;

  // BestOf tracking (optional - only for candidates)
  /** Candidate index (0, 1, 2...) - only present for bestOf candidates */
  candidateIndex?: number;

  // Pipeline tracking (optional - only when run via Pipeline)
  /** Pipeline run identifier - only present when run via Pipeline */
  pipelineRunId?: string;
  /** Pipeline step index - only present when run via Pipeline */
  pipelineStepIndex?: number;
}

export interface IndexedMeta extends BaseMeta {
  /** Item index in the batch (0, 1, 2...) */
  itemIndex: number;
}

export interface ReduceMeta extends BaseMeta {
  inputCount: number;
  inputIndices: number[];
}

export interface JudgeMeta extends BaseMeta {
  candidateCount: number;
}

export interface VerifyMeta extends BaseMeta {
  /** Total verification attempts made */
  attempts: number;
}

// =============================================================================
// RESULTS
// =============================================================================

/**
 * Result from a single worker (map, filter, bestof candidate).
 *
 * Status meanings:
 * - "success": Positive outcome (agent succeeded / condition passed)
 * - "filtered": Neutral outcome (evaluated but didn't pass condition) - filter only
 * - "error": Negative outcome (agent error)
 *
 * @typeParam T - Data type. Defaults to FileMap when no schema provided.
 */
export interface SwarmResult<T = FileMap> {
  readonly [SWARM_RESULT_BRAND]: true;
  status: "success" | "filtered" | "error";
  /** Parsed result.json if schema provided, else FileMap. Null if failed. */
  data: T | null;
  /** Output files (map/bestof) or original input files (filter) */
  files: FileMap;
  meta: IndexedMeta;
  error?: string;
  /** Raw result.json string when parse or validation failed (for debugging) */
  rawData?: string;
  /** Present when map used bestOf option. Matches BestOfResult structure (minus winner). */
  bestOf?: {
    winnerIndex: number;
    judgeReasoning: string;
    judgeMeta: JudgeMeta;
    candidates: SwarmResult<T>[];
  };
  /** Present when verify option was used. Contains verification outcome. */
  verify?: VerifyInfo;
}

/**
 * List of SwarmResults with helper properties.
 * Extends Array so all normal array operations work.
 *
 * Getters:
 * - `.success` - items with positive outcome
 * - `.filtered` - items that didn't pass condition (filter only)
 * - `.error` - items that encountered errors
 *
 * Chaining examples:
 * - `swarm.reduce(results.success, ...)` - forward only successful
 * - `swarm.reduce([...results.success, ...results.filtered], ...)` - forward all evaluated
 */
export class SwarmResultList<T = FileMap> extends Array<SwarmResult<T>> {
  /** Returns items with status "success" */
  get success(): SwarmResult<T>[] {
    return this.filter((r) => r.status === "success");
  }

  /** Returns items with status "filtered" (didn't pass condition) */
  get filtered(): SwarmResult<T>[] {
    return this.filter((r) => r.status === "filtered");
  }

  /** Returns items with status "error" */
  get error(): SwarmResult<T>[] {
    return this.filter((r) => r.status === "error");
  }

  static from<T>(results: SwarmResult<T>[]): SwarmResultList<T> {
    const list = new SwarmResultList<T>();
    list.push(...results);
    return list;
  }
}

/**
 * Result from reduce operation.
 *
 * @typeParam T - Data type. Defaults to FileMap when no schema provided.
 */
export interface ReduceResult<T = FileMap> {
  status: "success" | "error";
  data: T | null;
  files: FileMap;
  meta: ReduceMeta;
  error?: string;
  /** Raw result.json string when parse or validation failed (for debugging) */
  rawData?: string;
  /** Present when verify option was used. Contains verification outcome. */
  verify?: VerifyInfo;
}

/**
 * Result from bestOf operation.
 *
 * @typeParam T - Data type for candidates.
 */
export interface BestOfResult<T = FileMap> {
  winner: SwarmResult<T>;
  winnerIndex: number;
  judgeReasoning: string;
  judgeMeta: JudgeMeta;
  candidates: SwarmResult<T>[];
}

/** Fixed schema for bestOf judge output */
export interface JudgeDecision {
  winner: number;
  reasoning: string;
}

/** Fixed schema for verify output */
export interface VerifyDecision {
  passed: boolean;
  reasoning: string;
  feedback?: string;
}

/** Verification info attached to results when verify option used */
export interface VerifyInfo {
  passed: boolean;
  reasoning: string;
  verifyMeta: VerifyMeta;
  attempts: number;
}

// =============================================================================
// INPUT / PARAMS
// =============================================================================

export type ItemInput = FileMap | SwarmResult<unknown>;
export type PromptFn = (files: FileMap, index: number) => string;
export type Prompt = string | PromptFn;

/** @internal Pipeline context for observability (set by Pipeline, not user) */
export interface PipelineContext {
  pipelineRunId: string;
  pipelineStepIndex: number;
}

/** Parameters for map operation */
export interface MapParams<T> {
  /** Items to process (FileMaps or SwarmResults from previous operation) */
  items: ItemInput[];
  /** Task prompt (string or function(files, index) -> string) */
  prompt: Prompt;
  /** Optional operation name for observability */
  name?: string;
  /** Optional system prompt */
  systemPrompt?: string;
  /** @internal Pipeline context (set by Pipeline, not user) */
  _pipelineContext?: PipelineContext;
  /** Schema for structured output (Zod or JSON Schema) */
  schema?: z.ZodType<T> | JsonSchema;
  /** Validation options for JSON Schema (ignored for Zod) */
  schemaOptions?: SchemaValidationOptions;
  /** Optional agent override */
  agent?: AgentOverride;
  /** MCP servers override (replaces swarm default) */
  mcpServers?: Record<string, McpServerConfig>;
  /** Skills override (replaces swarm default) */
  skills?: SkillName[];
  /** Composio override (replaces swarm default) */
  composio?: ComposioSetup;
  /** Optional bestOf configuration for N candidates + judge (mutually exclusive with verify) */
  bestOf?: BestOfConfig;
  /** Optional verify configuration for LLM-as-judge quality verification with retry (mutually exclusive with bestOf) */
  verify?: VerifyConfig;
  /** Per-item retry configuration. Typed to allow retryOn access to SwarmResult fields. */
  retry?: RetryConfig<SwarmResult<T>>;
  /** Optional timeout in ms */
  timeoutMs?: number;
}

/** Parameters for filter operation */
export interface FilterParams<T> {
  /** Items to filter (FileMaps or SwarmResults from previous operation) */
  items: ItemInput[];
  /** Evaluation prompt - describe what to assess and how (agent outputs result.json) */
  prompt: string;
  /** Optional operation name for observability */
  name?: string;
  /** @internal Pipeline context (set by Pipeline, not user) */
  _pipelineContext?: PipelineContext;
  /** Schema for structured output (Zod or JSON Schema) */
  schema: z.ZodType<T> | JsonSchema;
  /** Validation options for JSON Schema (ignored for Zod) */
  schemaOptions?: SchemaValidationOptions;
  /** Local condition function to determine pass/fail */
  condition: (data: T) => boolean;
  /** Optional system prompt */
  systemPrompt?: string;
  /** Optional agent override */
  agent?: AgentOverride;
  /** MCP servers override (replaces swarm default) */
  mcpServers?: Record<string, McpServerConfig>;
  /** Skills override (replaces swarm default) */
  skills?: SkillName[];
  /** Composio override (replaces swarm default) */
  composio?: ComposioSetup;
  /** Optional verify configuration for LLM-as-judge quality verification with retry */
  verify?: VerifyConfig;
  /** Per-item retry configuration. Typed to allow retryOn access to SwarmResult fields. */
  retry?: RetryConfig<SwarmResult<T>>;
  /** Optional timeout in ms */
  timeoutMs?: number;
}

/** Parameters for reduce operation */
export interface ReduceParams<T> {
  /** Items to reduce (FileMaps or SwarmResults from previous operation) */
  items: ItemInput[];
  /** Synthesis prompt */
  prompt: string;
  /** Optional operation name for observability */
  name?: string;
  /** Optional system prompt */
  systemPrompt?: string;
  /** @internal Pipeline context (set by Pipeline, not user) */
  _pipelineContext?: PipelineContext;
  /** Schema for structured output (Zod or JSON Schema) */
  schema?: z.ZodType<T> | JsonSchema;
  /** Validation options for JSON Schema (ignored for Zod) */
  schemaOptions?: SchemaValidationOptions;
  /** Optional agent override */
  agent?: AgentOverride;
  /** MCP servers override (replaces swarm default) */
  mcpServers?: Record<string, McpServerConfig>;
  /** Skills override (replaces swarm default) */
  skills?: SkillName[];
  /** Composio override (replaces swarm default) */
  composio?: ComposioSetup;
  /** Optional verify configuration for LLM-as-judge quality verification with retry */
  verify?: VerifyConfig;
  /** Retry configuration (retries entire reduce on error). Typed to allow retryOn access to ReduceResult fields. */
  retry?: RetryConfig<ReduceResult<T>>;
  /** Optional timeout in ms */
  timeoutMs?: number;
}

/** Parameters for bestOf operation */
export interface BestOfParams<T> {
  /** Single item to process */
  item: ItemInput;
  /** Task prompt */
  prompt: string;
  /** Optional operation name for observability */
  name?: string;
  /** BestOf configuration (n, judgeCriteria, taskAgents, judgeAgent, mcpServers, skills, composio) */
  config: BestOfConfig;
  /** Optional system prompt */
  systemPrompt?: string;
  /** Schema for structured output (Zod or JSON Schema) */
  schema?: z.ZodType<T> | JsonSchema;
  /** Validation options for JSON Schema (ignored for Zod) */
  schemaOptions?: SchemaValidationOptions;
  /**
   * Per-candidate retry configuration. Typed to allow retryOn access to SwarmResult fields.
   * Note: Judge always uses default retryOn (status === "error"), ignoring custom retryOn.
   */
  retry?: RetryConfig<SwarmResult<T>>;
  /** Optional timeout in ms */
  timeoutMs?: number;
}
