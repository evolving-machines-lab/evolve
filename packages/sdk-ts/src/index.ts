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
export { E2BProvider, createE2BProvider, type E2BConfig } from "@evolvingmachines/e2b";
export { DaytonaProvider, createDaytonaProvider, type DaytonaConfig } from "@evolvingmachines/daytona";
export { ModalProvider, createModalProvider, type ModalConfig } from "@evolvingmachines/modal";

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
  BrowserRuntimeInfo,
  FileMap,
  McpServerConfig,
  OutputResult,
  JsonSchema,
  ValidationMode,
  SchemaValidationOptions,
  SkillName,
  BrowserProvider,
  ManagedBrowserProvider,
  BrowserConfig,
  BrowserCredentialScopeEntry,
  BrowserCredentialsConfig,
  DefaultBrowserConfig,
  ActionbookBrowserConfig,
  AgentBrowserConfig,
  AgentPluginConfig,
  MarketplaceAgentPluginConfig,
  GeminiAgentPluginConfig,
  CodexAgentPluginConfig,
  SkillsConfig,
  IntegrationsConfig,
  IntegrationsSetup,
  IntegrationToolsFilter,
  // Storage & Checkpointing
  StorageConfig,
  ResolvedStorageConfig,
  CheckpointInfo,
  StorageClient,
  DownloadCheckpointOptions,
  DownloadFilesOptions,
  // Cost
  RunCost,
  SessionCost,
} from "./types";

// Managed integration helper return types
export type {
  IntegrationAuthParams,
  IntegrationAuthResult,
  IntegrationAccount,
  IntegrationAccountListParams,
  IntegrationAccountUpdateParams,
  IntegrationAccountDeleteParams,
  IntegrationAccountUpdateResult,
  IntegrationAccountDeleteResult,
} from "./integrations";

export { managedSecrets } from "./managed-secrets";
export type {
  ManagedSecretRef,
  ManagedSecretMetadata,
  ManagedSecretsClient,
  ManagedSecretsClientConfig,
} from "./managed-secrets";

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
  SandboxNetworkPolicy,
  ExternalGatewayConfig,
} from "./types";

// Managed sandboxes — the platform runs the box, the caller holds only an
// Evolve API key. Which provider backs it is an argument, never an env var.
export { managedSandbox } from "./utils/sandbox";
export {
  MANAGED_SANDBOX_PROVIDERS,
  type ManagedSandboxProviderName,
} from "./constants";

// =============================================================================
// CONSTANTS
// =============================================================================

// Agent type constants
export { AGENT_TYPES } from "./types";

// =============================================================================
// PARSERS
// =============================================================================

// Output event types
export type { OutputEvent, AgentParser, SessionUpdate, AgentError } from "./parsers";
export { isAgentWorkUpdate } from "./parsers";

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
  createDroidParser,
  createGeminiParser,
  parseQwenOutput,
} from "./parsers";

// =============================================================================
// REGISTRY (for advanced use cases)
// =============================================================================

export {
  AGENT_REGISTRY,
  BINARY_EFFORT_VALUES,
  DEFAULT_REASONING_EFFORT,
  REASONING_EFFORTS,
  getAgentConfig,
  harnessEffortVocabulary,
  isValidAgentType,
  expandPath,
  getMcpSettingsPath,
  getMcpSettingsDir,
  type AgentRegistryEntry,
  type EffortSupport,
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
  writeDroidGatewaySettings,
  writeDroidMcpConfig,
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
  BROWSER_ACTIONBOOK_PROMPT,
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

// =============================================================================
// STORAGE
// =============================================================================

export { resolveStorageConfig, storage } from "./storage";

// =============================================================================
// BROWSER CREDENTIALS
// =============================================================================

export {
  BrowserCredentialsClient,
  browserCredentials,
  BROWSER_LOGIN_MCP_SERVER_NAME,
  type BrowserCredentialCreateInput,
  type BrowserCredentialDeleteInput,
  type BrowserCredentialListOptions,
  type BrowserCredentialMetadata,
  type BrowserCredentialsClientConfig,
} from "./browser-credentials";

// =============================================================================
// BROWSER PROFILES
// =============================================================================

export {
  BrowserProfilesClient,
  browserProfiles,
  type BrowserProfileDeleteInput,
  type BrowserProfileMetadata,
  type BrowserProfilesClientConfig,
} from "./browser-profiles";

// =============================================================================
// SESSIONS
// =============================================================================

export {
  sessions,
  type SessionsClient,
  type SessionsConfig,
  type ListSessionsOptions,
  type SessionPage,
  type SessionInfo,
  type SessionEvent,
  type GetEventsOptions,
  type DownloadSessionOptions,
  type BrowserReplay,
  type BrowserReplayOptions,
} from "./sessions";

// =============================================================================
// HOSTED EVALS (datasets + jobs + trials + agents)
// =============================================================================

export {
  agents,
  auth,
  datasets,
  jobs,
  trials,
  hosted,
  meta,
  HOSTED_ERROR_CODES,
  isHostedErrorCode,
  EvolveApiError,
  EvolveDigestMismatchError,
  EvolveIncompleteDownloadError,
  NoActiveVersionError,
  type HostedEvolve,
  type HostedErrorCode,
  type CapabilityDocument,
  type AgentCapability,
  type ProviderCapability,
  type ManagedProviderCapability,
  type StatusVocabulary,
  type UpstreamStatus,
  type Awaitable,
  type DatasetImportList,
  type DatasetImportPage,
  type ListImportsOptions,
  type HostedClientConfig,
  type DatasetsClient,
  type AgentsClient,
  type JobsClient,
  type TrialsClient,
  type AuthClient,
  type AuthStatus,
  type ApiKey,
  type JobTaskRollup,
  type JobTaskRollupPage,
  type JobTaskRollupList,
  type ListJobTasksOptions,
  type Dataset,
  type ActiveDataset,
  type DatasetVersion,
  type DatasetVersionState,
  type DatasetRef,
  type DatasetSelector,
  type Task,
  type TaskProviderVerdict,
  type AgentArm,
  type AgentArmInput,
  type JobCreate,
  type Job,
  type JobStats,
  type AgentDatasetStats,
  type JobStatus,
  type EvalSandboxProvider,
  type Trial,
  type TrialStatus,
  type TrialCounts,
  type TrialStatusTally,
  type TimingInfo,
  type ModelInfo as EvalModelInfo,
  type AgentInfo,
  type AgentResult,
  type VerifierResult,
  type ExceptionInfo,
  type StepResult as EvalStepResult,
  type AttemptPhase,
  type StopResponse,
  type TraceEvent,
  type TraceEventPage,
  type JobEvent,
  type JobWatch,
  type VerifierEnvironmentMode,
  type CompareJobAggregate,
  type CompareCell,
  type CompareCoverage,
  type CompareTaskRow,
  type CompareResponse,
  type SourceJob,
  type ResumeRequest,
  type RegradeRequest,
  type DatasetImport,
  type DatasetPatch,
  type PublishDatasetInput,
  type DatasetSource,
  type DatasetImportStatus,
  type DatasetImportFailure,
  type ImportWarning,
  type Agent as EvalAgent,
  type AgentInput,
  type AgentUpsertInput,
  type AgentSource,
  type AgentSourceInput,
  type SpendSource,
  type JobPage,
  type JobList,
  type TrialPage,
  type TrialList,
  type StartJobOptions,
  type ListJobsOptions,
  type ListTrialsOptions,
  type TraceOptions,
  type WatchJobOptions,
  type WatchImportOptions,
  type DownloadJobOptions,
  type DownloadDatasetOptions,
} from "./hosted";
