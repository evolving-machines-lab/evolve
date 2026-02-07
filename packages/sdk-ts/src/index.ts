// =============================================================================
// MAIN EXPORTS
// =============================================================================

// Evolve orchestrator (multi-turn, stateful sessions)
export { Evolve, type EvolveEvents, type EvolveConfig } from "./evolve";

// Swarm abstractions (parallel, stateless operations)
export {
  Swarm,
  Semaphore,
  SwarmResultList,
  SWARM_RESULT_BRAND,
  type SwarmConfig,
  type AgentOverride,
  type BestOfConfig,
  type VerifyConfig,
  type SwarmResult,
  type ReduceResult,
  type BestOfResult,
  type ItemInput,
  type MapParams,
  type FilterParams,
  type ReduceParams,
  type BestOfParams,
  type Prompt,
  type PromptFn,
  type IndexedMeta,
  type ReduceMeta,
  type JudgeMeta,
  type VerifyMeta,
  type BaseMeta,
  type OperationType,
  type JudgeDecision,
  type VerifyDecision,
  type VerifyInfo,
  type RetryConfig,
  type PipelineContext,
  type OnItemRetryCallback,
  type OnWorkerCompleteCallback,
  type OnVerifierCompleteCallback,
  type OnCandidateCompleteCallback,
  type OnJudgeCompleteCallback,
} from "./swarm";

// Pipeline (fluent API for chaining Swarm operations)
export {
  Pipeline,
  TerminalPipeline,
  type EmitOption,
  type MapConfig,
  type FilterConfig,
  type ReduceConfig,
  type StepResult,
  type PipelineResult,
  type PipelineEvents,
  type PipelineEventMap,
  type EventName,
  type EventHandler,
  type StepEvent,
  type StepStartEvent,
  type StepCompleteEvent,
  type StepErrorEvent,
  type ItemRetryEvent,
  type WorkerCompleteEvent,
  type VerifierCompleteEvent,
  type CandidateCompleteEvent,
  type JudgeCompleteEvent,
} from "./pipeline";

// Agent class (for advanced use cases)
export {
  Agent,
  type AgentConfig,
  type AgentOptions,
  type AgentResponse,
  type RunOptions,
  type ExecuteCommandOptions,
  type StreamCallbacks,
} from "./agent";

// Sandbox providers (re-exported for single-import convenience)
export { E2BProvider } from "@evolvingmachines/e2b";
export { DaytonaProvider } from "@evolvingmachines/daytona";
export { ModalProvider } from "@evolvingmachines/modal";

// =============================================================================
// TYPES
// =============================================================================

// Core types
export type {
  AgentType,
  WorkspaceMode,
  ReasoningEffort,
  SandboxLifecycleState,
  AgentRuntimeState,
  SessionStatus,
  LifecycleEvent,
  LifecycleReason,
  FileMap,
  McpServerConfig,
  OutputResult,
  JsonSchema,
  ValidationMode,
  SchemaValidationOptions,
  SkillName,
  SkillsConfig,
  ComposioConfig,
  ComposioSetup,
  ToolsFilter,
} from "./types";

// Composio types (for static helper return types)
export type {
  ComposioAuthResult,
  ComposioConnectionStatus,
} from "./composio";

// Schema validation presets
export { VALIDATION_PRESETS } from "./types";

// Sandbox provider types (provider-agnostic abstraction)
export type {
  SandboxInstance,
  SandboxProvider,
  SandboxCommands,
  SandboxFiles,
  SandboxCommandResult,
  SandboxCommandHandle,
  ProcessInfo,
  SandboxRunOptions,
  SandboxSpawnOptions,
  SandboxCreateOptions,
} from "./types";

// =============================================================================
// CONSTANTS
// =============================================================================

// Agent type constants
export { AGENT_TYPES } from "./types";

// =============================================================================
// PARSERS
// =============================================================================

// Output event types
export type { OutputEvent, AgentParser } from "./parsers";

// Parser functions
export {
  createAgentParser,
  parseNdjsonLine,
  parseNdjsonOutput,
} from "./parsers";

// Individual parser factory functions (for advanced use cases)
export {
  createClaudeParser,
  createCodexParser,
  createGeminiParser,
  parseQwenOutput,
} from "./parsers";

// =============================================================================
// REGISTRY (for advanced use cases)
// =============================================================================

export {
  AGENT_REGISTRY,
  getAgentConfig,
  isValidAgentType,
  expandPath,
  getMcpSettingsPath,
  getMcpSettingsDir,
  type AgentRegistryEntry,
  type ModelInfo,
  type McpConfigInfo,
} from "./registry";

// =============================================================================
// MCP (for advanced use cases)
// =============================================================================

export {
  writeMcpConfig,
  writeClaudeMcpConfig,
  writeCodexMcpConfig,
  writeGeminiMcpConfig,
  writeQwenMcpConfig,
} from "./mcp";

// =============================================================================
// PROMPTS (for advanced use cases)
// =============================================================================

export {
  buildWorkerSystemPrompt,
  applyTemplate,
  WORKSPACE_PROMPT,
  WORKSPACE_SWE_PROMPT,
  SYSTEM_PROMPT,
  SCHEMA_PROMPT,
  JUDGE_PROMPT,
  VERIFY_PROMPT,
  RETRY_FEEDBACK_PROMPT,
} from "./prompts";

// =============================================================================
// UTILITIES
// =============================================================================

export {
  // Schema utilities
  isZodSchema,
  zodSchemaToJson,
  jsonSchemaToString,
  // File utilities
  readLocalDir,
  saveLocalDir,
  // Retry utilities
  executeWithRetry,
} from "./utils";
