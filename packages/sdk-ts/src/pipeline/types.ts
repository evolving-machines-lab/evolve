/**
 * Pipeline Types
 *
 * Fluent API for chaining Swarm operations.
 */

import type { z } from "zod";
import type { JsonSchema, SchemaValidationOptions, McpServerConfig, SkillName } from "../types";
import type {
  AgentOverride,
  BestOfConfig,
  VerifyConfig,
  RetryConfig,
  SwarmResult,
  ReduceResult,
  Prompt,
  ComposioSetup,
} from "../swarm/types";

// =============================================================================
// EMIT OPTION (filter only)
// =============================================================================

/**
 * What filter emits to the next step.
 *
 * - "success": Items that passed condition (default)
 * - "filtered": Items that failed condition
 * - "all": Both success and filtered
 */
export type EmitOption = "success" | "filtered" | "all";

// =============================================================================
// STEP CONFIGURATIONS
// =============================================================================

/** Base fields shared by all step types */
interface BaseStepConfig {
  /** Step name for observability (appears in events) */
  name?: string;
  /** System prompt override */
  systemPrompt?: string;
  /** Agent override */
  agent?: AgentOverride;
  /** MCP servers override (replaces swarm default for this step) */
  mcpServers?: Record<string, McpServerConfig>;
  /** Skills override (replaces swarm default for this step) */
  skills?: SkillName[];
  /** Composio override (replaces swarm default for this step) */
  composio?: ComposioSetup;
  /** Timeout in ms */
  timeoutMs?: number;
}

/** Map step configuration */
export interface MapConfig<T> extends BaseStepConfig {
  /** Task prompt */
  prompt: Prompt;
  /** Schema for structured output */
  schema?: z.ZodType<T> | JsonSchema;
  /** Validation options for JSON Schema */
  schemaOptions?: SchemaValidationOptions;
  /** BestOf configuration (mutually exclusive with verify) */
  bestOf?: BestOfConfig;
  /** Verify configuration (mutually exclusive with bestOf) */
  verify?: VerifyConfig;
  /** Retry configuration */
  retry?: RetryConfig<SwarmResult<T>>;
}

/** Filter step configuration */
export interface FilterConfig<T> extends BaseStepConfig {
  /** Evaluation prompt */
  prompt: string;
  /** Schema for structured output (required) */
  schema: z.ZodType<T> | JsonSchema;
  /** Validation options for JSON Schema */
  schemaOptions?: SchemaValidationOptions;
  /** Condition function to determine pass/fail */
  condition: (data: T) => boolean;
  /** What to emit to next step (default: "success") */
  emit?: EmitOption;
  /** Verify configuration */
  verify?: VerifyConfig;
  /** Retry configuration */
  retry?: RetryConfig<SwarmResult<T>>;
}

/** Reduce step configuration */
export interface ReduceConfig<T> extends BaseStepConfig {
  /** Synthesis prompt */
  prompt: string;
  /** Schema for structured output */
  schema?: z.ZodType<T> | JsonSchema;
  /** Validation options for JSON Schema */
  schemaOptions?: SchemaValidationOptions;
  /** Verify configuration */
  verify?: VerifyConfig;
  /** Retry configuration */
  retry?: RetryConfig<ReduceResult<T>>;
}

// =============================================================================
// INTERNAL
// =============================================================================

/** @internal Step representation */
export type Step =
  | { type: "map"; config: MapConfig<unknown> }
  | { type: "filter"; config: FilterConfig<unknown> }
  | { type: "reduce"; config: ReduceConfig<unknown> };

/** @internal Step type literal */
export type StepType = "map" | "filter" | "reduce";

// =============================================================================
// RESULTS
// =============================================================================

/** Result of a single pipeline step */
export interface StepResult<T = unknown> {
  type: StepType;
  index: number;
  durationMs: number;
  results: SwarmResult<T>[] | ReduceResult<T>;
}

/** Final result from pipeline execution */
export interface PipelineResult<T = unknown> {
  /** Unique identifier for this pipeline run */
  pipelineRunId: string;
  steps: StepResult<unknown>[];
  output: SwarmResult<T>[] | ReduceResult<T>;
  totalDurationMs: number;
}

// =============================================================================
// EVENTS
// =============================================================================

/** Step lifecycle event */
export interface StepEvent {
  type: StepType;
  index: number;
  name?: string;
}

/** Emitted when step starts */
export interface StepStartEvent extends StepEvent {
  itemCount: number;
}

/** Emitted when step completes */
export interface StepCompleteEvent extends StepEvent {
  durationMs: number;
  successCount: number;
  errorCount: number;
  filteredCount: number;
}

/** Emitted when step errors */
export interface StepErrorEvent extends StepEvent {
  error: Error;
}

/** Emitted on item retry */
export interface ItemRetryEvent {
  stepIndex: number;
  stepName?: string;
  itemIndex: number;
  attempt: number;
  error: string;
}

/** Emitted when verify worker completes */
export interface WorkerCompleteEvent {
  stepIndex: number;
  stepName?: string;
  itemIndex: number;
  attempt: number;
  status: "success" | "error";
}

/** Emitted when verifier completes */
export interface VerifierCompleteEvent {
  stepIndex: number;
  stepName?: string;
  itemIndex: number;
  attempt: number;
  passed: boolean;
  feedback?: string;
}

/** Emitted when bestOf candidate completes */
export interface CandidateCompleteEvent {
  stepIndex: number;
  stepName?: string;
  itemIndex: number;
  candidateIndex: number;
  status: "success" | "error";
}

/** Emitted when bestOf judge completes */
export interface JudgeCompleteEvent {
  stepIndex: number;
  stepName?: string;
  itemIndex: number;
  winnerIndex: number;
  reasoning: string;
}

/** Event handlers */
export interface PipelineEvents {
  onStepStart?: (event: StepStartEvent) => void;
  onStepComplete?: (event: StepCompleteEvent) => void;
  onStepError?: (event: StepErrorEvent) => void;
  onItemRetry?: (event: ItemRetryEvent) => void;
  onWorkerComplete?: (event: WorkerCompleteEvent) => void;
  onVerifierComplete?: (event: VerifierCompleteEvent) => void;
  onCandidateComplete?: (event: CandidateCompleteEvent) => void;
  onJudgeComplete?: (event: JudgeCompleteEvent) => void;
}

/** Event name mapping for chainable .on() */
export type EventName =
  | "stepStart"
  | "stepComplete"
  | "stepError"
  | "itemRetry"
  | "workerComplete"
  | "verifierComplete"
  | "candidateComplete"
  | "judgeComplete";

/** Map event name to handler type */
export type EventHandler<E extends EventName> =
  E extends "stepStart" ? (event: StepStartEvent) => void :
  E extends "stepComplete" ? (event: StepCompleteEvent) => void :
  E extends "stepError" ? (event: StepErrorEvent) => void :
  E extends "itemRetry" ? (event: ItemRetryEvent) => void :
  E extends "workerComplete" ? (event: WorkerCompleteEvent) => void :
  E extends "verifierComplete" ? (event: VerifierCompleteEvent) => void :
  E extends "candidateComplete" ? (event: CandidateCompleteEvent) => void :
  E extends "judgeComplete" ? (event: JudgeCompleteEvent) => void :
  never;

/** Event name to handler type mapping (for chainable .on() style) */
export interface PipelineEventMap {
  stepStart: (event: StepStartEvent) => void;
  stepComplete: (event: StepCompleteEvent) => void;
  stepError: (event: StepErrorEvent) => void;
  itemRetry: (event: ItemRetryEvent) => void;
  workerComplete: (event: WorkerCompleteEvent) => void;
  verifierComplete: (event: VerifierCompleteEvent) => void;
  candidateComplete: (event: CandidateCompleteEvent) => void;
  judgeComplete: (event: JudgeCompleteEvent) => void;
}
