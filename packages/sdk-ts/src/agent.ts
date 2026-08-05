/**
 * Unified Agent Implementation
 *
 * Single Agent class that uses registry lookup for agent-specific behavior.
 * All agent differences are data (in registry), not code.
 */

import type { z } from "zod";
import Ajv, { type ValidateFunction } from "ajv";
import { randomUUID, randomBytes } from "crypto";
import type {
  AgentType,
  SandboxInstance,
  SandboxCommandHandle,
  FileMap,
  AgentConfig,
  ResolvedAgentConfig,
  AgentOptions,
  RunOptions,
  ExecuteCommandOptions,
  AgentResponse,
  OutputResult,
  StreamCallbacks,
  JsonSchema,
  SchemaValidationOptions,
  McpServerConfig,
  AgentRuntimeState,
  SandboxLifecycleState,
  LifecycleReason,
  BrowserRuntimeInfo,
  SessionStatus,
  LifecycleEvent,
  ResolvedStorageConfig,
  CheckpointInfo,
  RunCost,
  SessionCost,
} from "./types";
import { VALIDATION_PRESETS } from "./types";
import {
  expandPath,
  getAgentConfig,
  getOpenCodeReasoningVariant,
  isThinkingEnabled,
  resolveReasoningEffort,
  type AgentRegistryEntry,
} from "./registry";
import {
  writeMcpConfig,
  writeCodexSpendProvider,
  writeJsonSpendHeaders,
  writeQwenThinkingConfig,
  writeKimiSpendConfig,
  writeDroidGatewaySettings,
} from "./mcp";
import { stringify as stringifyToml } from "smol-toml";
import { createAgentParser, type AgentParser } from "./parsers";
import { mountSkills, resolveSkills, type ResolvedSkill, type SkillRef } from "./skills";
import type { OutputEvent } from "./parsers/types";
import {
  DEFAULT_TIMEOUT_MS,
  DEFAULT_HOME_DIR,
  DEFAULT_DASHBOARD_URL,
  ENV_EVOLVE_API_KEY,
  LITELLM_CUSTOMER_ID_HEADER,
  LITELLM_TAGS_HEADER,
  RUN_TAG_PREFIX,
  getGatewayUrl,
  resolveHomeDir,
} from "./constants";
import { buildWorkerSystemPrompt } from "./prompts";
import {
  isEvolveManagedSandboxProvider,
  isZodSchema,
  stampNativeConfig,
  validateAgentConfig,
  validateObservabilityMeta,
  validateRunOptions,
} from "./utils";
import { SessionLogger } from "./observability";
import { setupIntegrations } from "./integrations";
import {
  createCheckpoint,
  restoreCheckpoint,
  getLatestCheckpoint,
  type RestoreMetadata,
} from "./storage";
import { installAgentPlugins } from "./plugins";
import {
  createManagedBrowserSession,
  getManagedBrowserSandboxSetup,
  stopManagedBrowserSession,
  type ManagedBrowserSession,
} from "./browser";
import {
  BROWSER_LOGIN_MCP_SERVER_NAME,
  createBrowserLoginMcpServer,
} from "./browser-credentials";
import {
  bindProviderRuntimeToken as bindProviderRuntimeTokenRequest,
  createProviderRuntimeToken,
  isProviderRuntimeTokenEndpointMissing,
  PROVIDER_RUNTIME_BINDING_HEADER,
  revokeProviderRuntimeToken as revokeProviderRuntimeTokenRequest,
  type ProviderRuntimeToken,
} from "./provider-secrets";
import {
  bindManagedSecretRuntimeToken,
  createManagedSecretRuntimeToken,
  managedSecretCaSetupCommand,
  managedSecretProxyConfigCleanupCommand,
  managedSecretProxyConfig,
  managedSecretProxyStartCommand,
  managedSecretProxyEnvNames,
  managedSecretSandboxEnvs,
  MANAGED_SECRET_PROXY_CONFIG_PATH,
  MANAGED_SECRET_PROXY_DIR,
  MANAGED_SECRET_PROXY_SCRIPT,
  MANAGED_SECRET_PROXY_SCRIPT_PATH,
  MANAGED_SECRET_PROXY_PORT,
  revokeManagedSecretRuntimeToken,
  type ManagedSecretRuntimeToken,
} from "./managed-secrets";
import { collectSandboxArtifacts } from "./sandbox-artifacts";

// Re-export types for external consumers
export type {
  AgentConfig,
  AgentOptions,
  RunOptions,
  ExecuteCommandOptions,
  AgentResponse,
  StreamCallbacks,
  AgentRuntimeState,
  SandboxLifecycleState,
  SessionStatus,
  LifecycleEvent,
};

// =============================================================================
// PROMPT ESCAPING
// =============================================================================

const PROVIDER_RUNTIME_BINDING_ENV = "EVOLVE_PROVIDER_RUNTIME_BINDING";
const GEMINI_GATEWAY_AUTH_TYPE = "gemini-api-key";

function providerRuntimeProviderForAgent(
  agentType: AgentType,
): ProviderRuntimeToken["provider"] | null {
  switch (agentType) {
    case "claude":
      return "anthropic";
    case "codex":
      return "openai";
    case "gemini":
      return "gemini";
    case "qwen":
      return "dashscope";
    case "kimi":
      return "kimi";
    case "opencode":
      return "openrouter";
    case "droid":
      return "droid";
    default:
      return null;
  }
}

/**
 * Escape prompt for bash double-quoted strings
 *
 * Only escape characters that are special inside double quotes.
 */
function escapePrompt(prompt: string): string {
  return prompt
    .replace(/\\/g, "\\\\") // Escape backslashes FIRST
    .replace(/"/g, '\\"') // Escape double quotes
    .replace(/\$/g, "\\$") // Escape dollar signs
    .replace(/`/g, "\\`"); // Escape backticks (command substitution)
}

// =============================================================================
// SPEND TRACKING HELPERS
// =============================================================================

/** Generate a session tag: `{prefix}-{16 hex chars}` */
function generateSessionTag(prefix: string): string {
  return `${prefix}-${randomBytes(8).toString("hex")}`;
}

/**
 * Merge spend tracking headers into an existing custom headers env value.
 * Preserves user-supplied headers; spend headers overwrite only matching keys.
 *
 * Tag append behavior varies by format:
 * - newline (Claude): x-litellm-tags values are comma-appended (safe, no ambiguity)
 * - comma (Gemini): x-litellm-tags is overwritten — appending "run:<id>" after a comma
 *   would be mis-parsed by Gemini's regex /,(?=\s*[^,:]+:)/ as a separate header
 *
 * @param format - "newline" for Claude (ANTHROPIC_CUSTOM_HEADERS), "comma" for Gemini (GEMINI_CLI_CUSTOM_HEADERS)
 */
function mergeCustomHeaders(
  existing: string | undefined,
  updates: Record<string, string>,
  format: "newline" | "comma" = "newline",
): string {
  const merged = new Map<string, string>();

  // Parse existing headers (case-insensitive key lookup)
  if (existing) {
    // Newline format (Claude): "Name: Value\nName2: Value2"
    // Comma format (Gemini):   "Name: Value, Name2: Value2"
    const entries =
      format === "comma"
        ? existing.split(/,(?=\s*[^,:]+:)/) // Gemini: split on commas before "key:" pattern
        : existing.split(/\r?\n/); // Claude: split on newlines
    for (const entry of entries) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const colon = trimmed.indexOf(":");
      if (colon <= 0) continue;
      const name = trimmed.slice(0, colon).trim();
      const value = trimmed.slice(colon + 1).trim();
      merged.set(name.toLowerCase(), `${name}: ${value}`);
    }
  }

  // Apply updates (overwrites matching keys, except tags which are appended in newline format)
  for (const [name, value] of Object.entries(updates)) {
    const key = name.toLowerCase();
    if (
      key === LITELLM_TAGS_HEADER &&
      merged.has(key) &&
      format === "newline"
    ) {
      // Append to existing tags (comma-separated list) — safe in newline format only.
      // In comma format (Gemini), appending "run:<id>" after a comma creates ambiguity:
      // Gemini's regex /,(?=\s*[^,:]+:)/ would split "run:<id>" as a new header.
      // So for comma format, we overwrite the tag entirely.
      const existing = merged.get(key)!;
      const existingValue = existing.slice(existing.indexOf(":") + 1).trim();
      merged.set(key, `${name}: ${existingValue},${value}`);
    } else {
      merged.set(key, `${name}: ${value}`);
    }
  }

  return Array.from(merged.values()).join(format === "comma" ? ", " : "\n");
}

const KIMI_CODE_DEFAULT_CONTEXT_SIZE = 262144;
/**
 * Conservative ceiling used when the resolved model is NOT one the harness's
 * own registry entry declares.
 *
 * Kimi Code turns its `max_context_size` into the request's `max_tokens`, and
 * an OpenAI-compatible gateway rejects a `max_tokens` above the model's real
 * completion ceiling (LiteLLM answers 400 "max_tokens is too large"). Kimi's
 * own 262144 is therefore never asserted for a foreign model. Callers that
 * know the exact per-model ceiling pass it as `AgentConfig.maxContextSize`.
 */
const FOREIGN_MODEL_MAX_CONTEXT_SIZE = 128000;

/** True when `model` is an identifier the registry entry itself declares. */
function registryOwnsModel(registry: AgentRegistryEntry, model: string): boolean {
  if (registry.models.some((entry) => entry.alias === model || entry.modelId === model)) {
    return true;
  }
  const aliases = registry.gatewayModelAliases;
  if (aliases && (model in aliases || Object.values(aliases).includes(model))) {
    return true;
  }
  const directAliases = registry.directModelAliases;
  return Boolean(
    directAliases && (model in directAliases || Object.values(directAliases).includes(model)),
  );
}
// Kimi Code accepts these as provider-dependent config/env values. Moonshot's
// K3 API documents reasoning_effort low|high|max (default max, thinking
// always on); the Kimi Code CLI effort enum is low|medium|high|xhigh|max.
const KIMI_CODE_THINKING_EFFORTS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

// The omitted-effort pin ("max", matching K3's own API default) lives in
// AGENT_REGISTRY.kimi.defaultReasoningEffort and is applied by
// Agent.reasoningEffort() before this mapper runs — callers here always
// receive the resolved value. Values outside the CLI's effort enum (e.g.
// "thinking"/"no-thinking") map to undefined: thinking on/off is carried
// separately via isThinkingEnabled().
function getKimiCodeThinkingEffort(
  reasoningEffort?: string,
): string | undefined {
  if (!reasoningEffort) return undefined;
  return KIMI_CODE_THINKING_EFFORTS.has(reasoningEffort)
    ? reasoningEffort
    : undefined;
}

function withOpenAiV1Path(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

// =============================================================================
// AGENT CLASS
// =============================================================================

/**
 * Unified Agent class
 *
 * Uses registry lookup for agent-specific behavior.
 * Tracks hasRun state for continue flag handling.
 */
export class Agent {
  private agentConfig: ResolvedAgentConfig;
  private options: AgentOptions;
  private sandbox?: SandboxInstance;
  private hasRun: boolean = false;
  private readonly workingDir: string;
  private readonly homeDir: string;
  private lastRunTimestamp?: number;
  private readonly registry: AgentRegistryEntry;
  /** Unified session ID — used for both observability (SessionLogger) and spend tracking (gateway customer-id) */
  private sessionTag: string;
  /** Previous session tag — preserved across kill()/setSession() so cost queries still work */
  private previousSessionTag?: string;
  private sessionLogger?: SessionLogger;
  private activeCommand?: SandboxCommandHandle;
  private activeProcessId: string | null = null;
  private activeOperationId: number | null = null;
  private activeOperationKind: "run" | "command" | null = null;
  private nextOperationId: number = 0;
  private interruptedOperations = new Set<number>();
  private sandboxState: SandboxLifecycleState;
  private agentState: AgentRuntimeState = "idle";
  private droidSessionId?: string;
  private managedBrowserSession?: ManagedBrowserSession;
  private providerRuntimeToken?: ProviderRuntimeToken;
  private managedSecretRuntimeToken?: ManagedSecretRuntimeToken;
  private managedSecretProxy?: SandboxCommandHandle;
  private credentialsSealed = false;

  // Skills storage: real references (skills.sh / git / local folders),
  // resolved and mounted by the one resolver in skills.ts at setup time.
  private readonly skills?: SkillRef[];
  private resolvedSkillsList?: ResolvedSkill[];

  // Storage / Checkpointing
  private readonly storage?: ResolvedStorageConfig;
  private lastCheckpointId?: string;

  // Schema storage (mutually exclusive)
  private readonly zodSchema?: z.ZodType<unknown>;
  private readonly jsonSchema?: JsonSchema;
  private readonly schemaOptions?: SchemaValidationOptions;
  private readonly compiledValidator?: ValidateFunction;

  constructor(agentConfig: ResolvedAgentConfig, options: AgentOptions = {}) {
    // Every run reaches the command builder through here — Evolve, Swarm, and a
    // hand-built Agent alike — so a field the caller filled in wrong is named
    // at construction rather than thrown from a shell-quoting helper later.
    validateAgentConfig(agentConfig);
    validateObservabilityMeta(options.observability);
    if (options.managedSecrets) {
      if (agentConfig.isDirectMode) {
        throw new Error("managed secrets are available only in gateway mode with EVOLVE_API_KEY");
      }
      if (options.sandboxId) {
        throw new Error("managed secrets cannot be used with an existing sandbox; grants are sandbox-scoped.");
      }
      if (options.sandboxProvider && !isEvolveManagedSandboxProvider(options.sandboxProvider)) {
        throw new Error("managed secrets require an Evolve-managed sandbox provider");
      }
    }
    this.agentConfig = agentConfig;
    this.options = options;
    if (options.sandboxId && options.sandboxCreateOptions?.user) {
      // A user can only be enforced at sandbox creation; attaching to an
      // existing sandbox would silently run operations as its default user.
      throw new Error(
        "sandbox user cannot be enforced when attaching to an existing sandbox; create a fresh sandbox with the user instead",
      );
    }
    this.homeDir = resolveHomeDir(
      options.sandboxCreateOptions?.user,
      options.sandboxCreateOptions?.homeDir,
    );
    if (this.homeDir !== DEFAULT_HOME_DIR) {
      // Checkpoint storage and managed browser config paths are pinned to the
      // default /home/user home; fail loudly instead of writing to dead paths.
      if (options.storage) {
        throw new Error(
          "Checkpoint storage requires the default /home/user sandbox home directory; remove sandbox user/homeDir or storage",
        );
      }
      if (options.managedBrowser || options.browserCredentials) {
        throw new Error(
          "Managed browser features require the default /home/user sandbox home directory",
        );
      }
    }
    this.workingDir =
      options.workingDirectory ||
      options.sandboxCreateOptions?.workingDirectory ||
      `${this.homeDir}/workspace`;
    this.sandboxState = options.sandboxId ? "ready" : "stopped";

    if (options.workspaceMode === "task") {
      const generatedWorkspaceInputs = [
        options.context,
        options.files,
        options.systemPrompt,
        options.browserPrompt,
        options.schema,
      ];
      if (generatedWorkspaceInputs.some(Boolean)) {
        throw new Error(
          'workspaceMode "task" cannot be combined with context, files, systemPrompt, browserPrompt, or schema; the task owns the working directory',
        );
      }
    }

    // Store skills
    this.skills = options.skills;

    // Store storage config
    this.storage = options.storage;

    // Auto-detect and store schema type
    if (options.schema) {
      if (isZodSchema(options.schema)) {
        this.zodSchema = options.schema;
        if (options.schemaOptions) {
          console.warn(
            "[Evolve] schemaOptions ignored for Zod schemas - use .passthrough(), .strip(), z.coerce instead",
          );
        }
      } else {
        // JSON Schema - validate at config time (fail fast)
        this.jsonSchema = options.schema as JsonSchema;
        this.schemaOptions = options.schemaOptions;

        // Compile schema (validates it's valid JSON Schema + creates reusable validator)
        try {
          const ajv = this.createAjvValidator();
          this.compiledValidator = ajv.compile(this.jsonSchema);
        } catch (e) {
          throw new Error(`Invalid JSON Schema: ${(e as Error).message}`);
        }
      }
    }

    // Cache registry lookup once in constructor
    this.registry = getAgentConfig(agentConfig.type);

    // Unified session tag — generated early for spend tracking headers at sandbox creation,
    // then shared with SessionLogger on first run(). Rotated on kill()/setSession().
    this.sessionTag = generateSessionTag(options.sessionTagPrefix || "evolve");
  }

  private browserRuntimeInfo(): BrowserRuntimeInfo | undefined {
    if (!this.managedBrowserSession) return undefined;
    return {
      liveUrl: this.managedBrowserSession.liveUrl,
      sessionId: this.managedBrowserSession.sessionId,
      sessionTag: this.managedBrowserSession.sessionTag,
    };
  }

  private browserResponseInfo():
    Pick<BrowserRuntimeInfo, "liveUrl"> | undefined {
    if (!this.managedBrowserSession) return undefined;
    return { liveUrl: this.managedBrowserSession.liveUrl };
  }

  private emitLifecycle(
    callbacks: StreamCallbacks | undefined,
    reason: LifecycleReason,
  ): void {
    const browser = this.browserRuntimeInfo();
    callbacks?.onLifecycle?.({
      sandboxId: this.getSession(),
      sandbox: this.sandboxState,
      agent: this.agentState,
      timestamp: new Date().toISOString(),
      reason,
      ...(browser ? { browser } : {}),
    });
  }

  private invalidateActiveOperation(): void {
    this.activeCommand = undefined;
    this.activeProcessId = null;
    this.activeOperationId = null;
    this.activeOperationKind = null;
  }

  private beginOperation(
    kind: "run" | "command",
    handle: SandboxCommandHandle,
    callbacks: StreamCallbacks | undefined,
    reason: LifecycleReason,
  ): number {
    const opId = ++this.nextOperationId;
    this.activeOperationId = opId;
    this.activeOperationKind = kind;
    this.activeCommand = handle;
    this.activeProcessId = handle.processId;
    this.sandboxState = "running";
    this.agentState = "running";
    this.emitLifecycle(callbacks, reason);
    return opId;
  }

  private finalizeOperation(
    opId: number,
    callbacks: StreamCallbacks | undefined,
    reason: LifecycleReason,
    nextAgentState: AgentRuntimeState = "idle",
    nextSandboxState: SandboxLifecycleState = "ready",
  ): boolean {
    if (this.activeOperationId !== opId) {
      return false;
    }
    this.invalidateActiveOperation();
    this.sandboxState = nextSandboxState;
    this.agentState = nextAgentState;
    this.emitLifecycle(callbacks, reason);
    return true;
  }

  private watchBackgroundOperation(
    opId: number,
    kind: "run" | "command",
    handle: SandboxCommandHandle,
    callbacks?: StreamCallbacks,
    sandbox?: SandboxInstance,
  ): void {
    const completeReason: LifecycleReason =
      kind === "run"
        ? "run_background_complete"
        : "command_background_complete";
    const failedReason: LifecycleReason =
      kind === "run" ? "run_background_failed" : "command_background_failed";
    const interruptedReason: LifecycleReason =
      kind === "run" ? "run_interrupted" : "command_interrupted";

    void handle
      .wait()
      .then(async (result) => {
        const interrupted =
          this.interruptedOperations.delete(opId) || result.exitCode === 130;
        if (interrupted) {
          this.finalizeOperation(
            opId,
            callbacks,
            interruptedReason,
            "interrupted",
          );
          return;
        }
        if (kind === "run" && sandbox) {
          await this.writeDroidSessionState(sandbox);
        }
        const reason = result.exitCode === 0 ? completeReason : failedReason;
        const nextState = result.exitCode === 0 ? "idle" : "error";
        this.finalizeOperation(opId, callbacks, reason, nextState);
      })
      .catch(() => {
        this.interruptedOperations.delete(opId);
        this.finalizeOperation(opId, callbacks, failedReason, "error");
      });
  }

  /**
   * Create Ajv validator instance with configured options
   */
  private createAjvValidator(): Ajv {
    // Start with loose preset (default), then apply mode, then individual options
    const preset = VALIDATION_PRESETS[this.schemaOptions?.mode || "loose"];
    const opts = {
      ...preset,
      // Individual options override preset
      ...(this.schemaOptions?.coerceTypes !== undefined && {
        coerceTypes: this.schemaOptions.coerceTypes,
      }),
      ...(this.schemaOptions?.removeAdditional !== undefined && {
        removeAdditional: this.schemaOptions.removeAdditional,
      }),
      ...(this.schemaOptions?.useDefaults !== undefined && {
        useDefaults: this.schemaOptions.useDefaults,
      }),
      ...(this.schemaOptions?.allErrors !== undefined && {
        allErrors: this.schemaOptions.allErrors,
      }),
    };
    // Disable strict mode - allows unknown formats (e.g., date-time from Pydantic schemas)
    // Ajv validates structure, Pydantic handles format validation for rich types
    return new Ajv({ ...opts, strict: false });
  }

  // ===========================================================================
  // SANDBOX MANAGEMENT
  // ===========================================================================

  /**
   * Get or create sandbox instance
   */
  async getSandbox(callbacks?: StreamCallbacks): Promise<SandboxInstance> {
    if (this.sandbox) return this.sandbox;
    if (this.credentialsSealed) {
      throw new Error(
        "Agent credentials are sealed and this Evolve instance cannot create or attach another sandbox",
      );
    }

    if (!this.options.sandboxProvider) {
      throw new Error("No sandbox provider configured");
    }

    const provider = this.options.sandboxProvider;
    this.sandboxState = "booting";
    this.emitLifecycle(callbacks, "sandbox_boot");
    let createdSandboxInThisCall = false;
    try {
      if (this.options.sandboxId) {
        // Connect to existing sandbox - skip setup
        if (
          this.options.mcpServers ||
          this.options.integrations ||
          this.options.plugins ||
          this.options.context ||
          this.options.files ||
          this.options.systemPrompt ||
          this.options.managedBrowser ||
          this.options.browserCredentials
        ) {
          console.warn(
            "[Evolve] Connecting to existing sandbox - ignoring mcpServers, integrations, plugins, context, files, systemPrompt, managed browser setup, and browser credentials",
          );
        }
        this.sandbox = await provider.connect(this.options.sandboxId);
        // Existing sandbox may have prior runs - use resume/continue command
        this.hasRun = true;
        await this.loadDroidSessionState(this.sandbox);
        this.sandboxState = "ready";
        this.agentState = "idle";
        this.emitLifecycle(callbacks, "sandbox_connected");
      } else {
        // Create new sandbox with full initialization
        await this.ensureManagedBrowserSession(callbacks);
        await this.ensureProviderRuntimeToken();
        await this.ensureManagedSecretRuntimeToken();
        const envVars = this.buildEnvironmentVariables();

        this.sandbox = await provider.create(
          this.buildSandboxCreateOptions(envVars),
        );
        createdSandboxInThisCall = true;
        await this.bindProviderRuntimeToken(this.sandbox.sandboxId);
        await this.bindManagedSecretRuntimeToken(this.sandbox.sandboxId);
        await this.setupManagedSecretEgress(this.sandbox);

        await this.setupManagedBrowser(this.sandbox);

        // Agent-specific setup (e.g., codex login)
        await this.setupAgentAuth(this.sandbox);

        // Agent plugins/extensions must be installed before the first agent command.
        await this.setupAgentPlugins(this.sandbox);

        // Workspace setup
        await this.setupWorkspace(this.sandbox);
        this.sandboxState = "ready";
        this.agentState = "idle";
        this.emitLifecycle(callbacks, "sandbox_ready");
      }
    } catch (error) {
      if (createdSandboxInThisCall && this.sandbox) {
        await this.sandbox.kill().catch(() => {});
        this.sandbox = undefined;
      }
      await this.closeManagedBrowserSession().catch(() => {});
      await this.closeProviderRuntimeToken().catch(() => {});
      await this.closeManagedSecretRuntimeToken().catch(() => {});
      this.sandboxState = "error";
      this.agentState = "error";
      this.emitLifecycle(callbacks, "sandbox_error");
      throw error;
    }

    return this.sandbox;
  }

  /**
   * The `max_context_size` Kimi Code is told, which it sends as the request's
   * `max_tokens`. Three cases, in order:
   *
   *   1. `maxContextSize` on the agent config wins verbatim — the caller knows
   *      the model's real ceiling.
   *   2. A model the kimi registry entry itself declares keeps that model's
   *      own ceiling when the row declares one (K3: 1048576), else the
   *      harness default (262144).
   *   3. Any other model — e.g. driving Kimi Code against `gpt-5.5` through an
   *      OpenAI-compatible gateway — gets the conservative constant, because
   *      262144 is above that model's ceiling and the gateway answers 400.
   *
   * Both kimi wiring paths (KIMI_MODEL_MAX_CONTEXT_SIZE and the config.toml
   * `max_context_size`) resolve it here, so they can never disagree.
   */
  private resolveKimiMaxContextSize(): number {
    if (typeof this.agentConfig.maxContextSize === "number") {
      return this.agentConfig.maxContextSize;
    }
    const configuredModel = this.agentConfig.model || this.registry.defaultModel;
    const ownsModel =
      registryOwnsModel(this.registry, configuredModel) ||
      registryOwnsModel(this.registry, this.resolveCommandModel(configuredModel));
    if (!ownsModel) return FOREIGN_MODEL_MAX_CONTEXT_SIZE;
    const ownedRow = this.registry.models.find(
      (m) => m.alias === configuredModel || m.modelId === configuredModel,
    );
    return (
      ownedRow?.maxContextSize ??
      this.registry.spendTrackingTomlProvider?.maxContextSize ??
      KIMI_CODE_DEFAULT_CONTEXT_SIZE
    );
  }

  /**
   * The effort this agent's runs stamp on the wire: the caller's
   * reasoningEffort when given, else the harness's registry-pinned default.
   * Every command/env/config build path reads this, so an omitted effort is
   * an explicit stamp of the pin — never the vendor's silent default.
   */
  private reasoningEffort(): string | undefined {
    return resolveReasoningEffort(
      this.agentConfig.type,
      this.agentConfig.reasoningEffort,
    );
  }

  /**
   * Kimi Code model envs for direct-style credential injection (direct mode
   * and externalGateway mode). Kimi Code reads KIMI_MODEL_* — the registry's
   * KIMI_API_KEY/KIMI_BASE_URL are SDK-facing inputs the CLI never reads.
   */
  private buildKimiDirectModelEnvs(): Record<string, string> {
    const thinkingEnabled = isThinkingEnabled(this.reasoningEffort());
    const thinkingEffort = getKimiCodeThinkingEffort(this.reasoningEffort());
    const envVars: Record<string, string> = {
      KIMI_MODEL_NAME: this.resolveCommandModel(
        this.agentConfig.model || this.registry.defaultModel,
      ),
      KIMI_MODEL_API_KEY: this.agentConfig.apiKey,
      KIMI_MODEL_PROVIDER_TYPE: "kimi",
      KIMI_MODEL_MAX_CONTEXT_SIZE: String(this.resolveKimiMaxContextSize()),
      KIMI_MODEL_DEFAULT_THINKING: thinkingEnabled ? "true" : "false",
      KIMI_MODEL_THINKING_MODE: thinkingEnabled ? "on" : "off",
    };
    if (thinkingEffort) {
      envVars.KIMI_MODEL_THINKING_EFFORT = thinkingEffort;
    }
    if (this.agentConfig.baseUrl) {
      envVars.KIMI_MODEL_BASE_URL = this.agentConfig.baseUrl;
    }
    return envVars;
  }

  /**
   * Build environment variables for sandbox
   */
  private buildEnvironmentVariables(): Record<string, string> {
    const envVars: Record<string, string> = {};
    const userSecrets = this.validatedUserSecretsForEnvironment();

    if (this.agentConfig.type === "kimi" && this.agentConfig.isDirectMode) {
      Object.assign(envVars, this.buildKimiDirectModelEnvs());
    } else if (this.agentConfig.oauthFileContent) {
      // File-based OAuth (Codex, Gemini): auth file handles auth, no API key env var needed
      // Some agents need an activation env var (e.g., Gemini needs GOOGLE_GENAI_USE_GCA=true)
      if (this.registry.oauthActivationEnv) {
        envVars[this.registry.oauthActivationEnv.key] =
          this.registry.oauthActivationEnv.value;
      }
    } else if (
      this.agentConfig.type === "kimi" &&
      !this.agentConfig.isDirectMode
    ) {
      // Kimi Code gateway auth is written to ~/.kimi-code/config.toml per run.
      // The old KIMI_API_KEY/KIMI_BASE_URL envs are not read by Kimi Code.
    } else if (
      !this.agentConfig.isDirectMode &&
      providerRuntimeProviderForAgent(this.agentConfig.type)
    ) {
      // Managed gateway agents receive a session-scoped Dashboard model-proxy
      // token below, not the account-level Evolve API key.
    } else if (
      this.registry.skipApiKeyEnvInGateway &&
      !this.agentConfig.isDirectMode
    ) {
      // Gateway mode for generated-settings agents (Droid): auth is injected
      // below and referenced from the settings file, not provider env.
    } else if (this.registry.providerEnvMap && !this.agentConfig.isDirectMode) {
      // Multi-provider CLI in gateway mode (e.g., OpenCode): set ALL provider API keys
      // so any model prefix (anthropic/*, openai/*, google/*) can find its key
      for (const mapping of Object.values(this.registry.providerEnvMap)) {
        envVars[mapping.keyEnv] = this.agentConfig.apiKey;
      }
    } else {
      // Single-provider: resolve model-specific key env for multi-provider CLIs in direct mode
      const providerPrefix = this.agentConfig.model?.split("/")[0];
      const providerMapping = providerPrefix
        ? this.registry.providerEnvMap?.[providerPrefix]
        : undefined;
      const effectiveKeyEnv = providerMapping
        ? providerMapping.keyEnv
        : this.registry.apiKeyEnv;
      // OAuth mode uses oauthEnv (e.g., CLAUDE_CODE_OAUTH_TOKEN), else apiKeyEnv
      const keyEnv =
        this.agentConfig.isOAuth && this.registry.oauthEnv
          ? this.registry.oauthEnv
          : effectiveKeyEnv;
      envVars[keyEnv] = this.agentConfig.apiKey;
    }

    if (
      this.agentConfig.isDirectMode &&
      !this.agentConfig.isOAuth &&
      this.agentConfig.type !== "kimi"
    ) {
      // Direct mode (non-OAuth): use resolved baseUrl if set (e.g., Qwen needs Dashscope endpoint)
      if (this.agentConfig.baseUrl && this.registry.baseUrlEnv) {
        envVars[this.registry.baseUrlEnv] = this.agentConfig.baseUrl;
      }
    } else if (!this.agentConfig.isDirectMode) {
      // Gateway mode: route through Evolve gateway
      const gatewayUrl = getGatewayUrl(this.registry.gatewayPath);
      const providerRuntime =
        this.requireActiveProviderRuntimeToken();

      if (this.registry.gatewayConfigEnv) {
        // Session-level: only customer-id header. Per-run tag added in buildRunEnvs().
        envVars[this.registry.gatewayConfigEnv] = this.buildGatewayConfigJson({
          [LITELLM_CUSTOMER_ID_HEADER]: this.sessionTag,
          ...this.providerRuntimeHeaderUpdates(),
        });
      } else {
        // Single-provider: set base URL env var
        if (this.registry.baseUrlEnv && this.agentConfig.type !== "kimi") {
          envVars[this.registry.baseUrlEnv] =
            providerRuntime?.baseUrl ?? gatewayUrl;
        }
      }

      if (providerRuntime) {
        if (this.shouldExposeProviderRuntimeTokenEnv()) {
          envVars[this.registry.apiKeyEnv] = providerRuntime.token;
        }
        if (this.agentConfig.type === "gemini") {
          envVars.GEMINI_DEFAULT_AUTH_TYPE = GEMINI_GATEWAY_AUTH_TYPE;
        }
        if (this.registry.spendTrackingEnvs) {
          envVars[PROVIDER_RUNTIME_BINDING_ENV] =
            providerRuntime.bindingSecret;
        }
      }

      // Dashboard model proxy routing uses a session-scoped token instead of
      // exposing the account gateway key to the sandbox.
      if (!providerRuntime) {
        if (providerRuntimeProviderForAgent(this.agentConfig.type)) {
          throw new Error(
            `${this.agentConfig.type} gateway mode requires a Dashboard runtime token before sandbox setup`,
          );
        }
        envVars[ENV_EVOLVE_API_KEY] = this.agentConfig.apiKey;
      }
    }
    // OAuth direct mode: no baseUrl needed (Claude Code CLI handles it)

    // External gateway mode for inline-config CLIs (OpenCode): env vars alone
    // cannot route these CLIs — the provider config (caller-minted credential +
    // base URL, no LiteLLM spend headers) must ride the config env at boot too.
    if (this.agentConfig.externalGateway && this.registry.gatewayConfigEnv) {
      envVars[this.registry.gatewayConfigEnv] = this.buildGatewayConfigJson({});
    }

    // External gateway + Gemini: the CLI picks its auth method from
    // ~/.gemini/settings.json (written in setupAgentAuth) — NOT from an env var
    // — and refuses to run headless in an untrusted workspace (exit 55). Trust
    // the sandbox workspace explicitly so the run can proceed non-interactively.
    if (this.agentConfig.externalGateway && this.agentConfig.type === "gemini") {
      envVars.GEMINI_CLI_TRUST_WORKSPACE = "true";
    }

    // Claude Code always runs with --dangerously-skip-permissions, which the CLI
    // refuses under root ("cannot be used with root/sudo privileges") unless the
    // sandbox-mode bypass is set. Evolve always runs the agent inside a sandbox
    // (which may run as root), so declare sandbox mode.
    if (this.agentConfig.type === "claude") {
      envVars.IS_SANDBOX = "1";
    }

    if (this.managedBrowserSession && this.options.managedBrowser) {
      Object.assign(
        envVars,
        getManagedBrowserSandboxSetup(
          this.options.managedBrowser.provider,
          this.managedBrowserSession,
        ).envs,
      );
    }

    if (this.managedSecretRuntimeToken) {
      Object.assign(envVars, managedSecretSandboxEnvs(this.managedSecretRuntimeToken));
    }

    if (userSecrets) {
      Object.assign(envVars, userSecrets);
    }

    // Spend tracking: merge session-level LiteLLM header (gateway mode only).
    // Uses mergeCustomHeaders to preserve any user-supplied headers from secrets.
    if (!this.agentConfig.isDirectMode && this.registry.customHeadersEnv) {
      const headerEnv = this.registry.customHeadersEnv;
      const fmt = this.registry.customHeadersFormat || "newline";
      envVars[headerEnv] = mergeCustomHeaders(
        envVars[headerEnv],
        {
          [LITELLM_CUSTOMER_ID_HEADER]: this.sessionTag,
          ...this.providerRuntimeHeaderUpdates(),
        },
        fmt,
      );
    }

    // Spend tracking via per-env-var headers (e.g., Codex env_http_headers in TOML).
    // Session-level only — run-level tag is set per-run in buildRunEnvs().
    if (!this.agentConfig.isDirectMode && this.registry.spendTrackingEnvs) {
      envVars[this.registry.spendTrackingEnvs.sessionTagEnv] = this.sessionTag;
    }

    return envVars;
  }

  private buildSandboxCreateOptions(
    envs: Record<string, string>,
  ): import("./types").SandboxCreateOptions {
    return {
      ...this.options.sandboxCreateOptions,
      envs,
      workingDirectory: this.workingDir,
    };
  }

  private validatedUserSecretsForEnvironment():
    Record<string, string> | undefined {
    const supplied = {
      ...this.options.sandboxCreateOptions?.envs,
      ...this.options.secrets,
    };
    if (Object.keys(supplied).length === 0) return undefined;

    const reserved = new Set<string>();
    if (!this.agentConfig.isDirectMode) {
      reserved.add(ENV_EVOLVE_API_KEY);
      reserved.add(PROVIDER_RUNTIME_BINDING_ENV);
      if (this.agentConfig.type === "gemini") {
        reserved.add("GEMINI_DEFAULT_AUTH_TYPE");
      }
    }
    const add = (value?: string) => {
      if (value) reserved.add(value);
    };

    add(this.registry.apiKeyEnv);
    add(this.registry.baseUrlEnv);
    for (const mapping of Object.values(this.registry.providerEnvMap ?? {})) {
      add(mapping.keyEnv);
    }
    if (this.managedSecretRuntimeToken) {
      for (const key of managedSecretProxyEnvNames()) {
        reserved.add(key);
      }
    }
    for (const item of this.managedSecretRuntimeToken?.env ?? []) {
      add(item.envName);
    }

    const safeSecrets: Record<string, string> = {};
    for (const [key, value] of Object.entries(supplied)) {
      if (reserved.has(key)) {
        throw new Error(
          `${key} is reserved for Evolve-managed sandbox services and cannot be set with secrets`,
        );
      }
      if (key === this.registry.gatewayConfigEnv) {
        continue;
      }
      safeSecrets[key] = value;
    }
    return safeSecrets;
  }

  private async ensureManagedBrowserSession(
    callbacks?: StreamCallbacks,
  ): Promise<void> {
    if (this.managedBrowserSession || !this.options.managedBrowser) return;
    this.managedBrowserSession = await createManagedBrowserSession(
      this.options.managedBrowser,
      this.sessionTag,
      {
        browserCredentials: this.options.browserCredentials !== undefined,
      },
    );
    this.emitLifecycle(callbacks, "browser_ready");
  }

  private async ensureProviderRuntimeToken(): Promise<void> {
    const provider = providerRuntimeProviderForAgent(this.agentConfig.type);
    if (this.agentConfig.isDirectMode || !provider) return;
    if (!this.options.providerRouting) return;

    if (this.providerRuntimeToken) return;

    let token: ProviderRuntimeToken;
    try {
      token = await createProviderRuntimeToken(this.options.providerRouting, {
        provider,
        sessionTag: this.sessionTag,
      });
    } catch (error) {
      if (isProviderRuntimeTokenEndpointMissing(error)) {
        throw new Error(
          `${provider} runtime token endpoint is required in gateway mode: ${(error as Error).message}`,
        );
      }
      throw error;
    }

    this.providerRuntimeToken = token;
    if (this.providerRuntimeToken && this.sandbox?.sandboxId) {
      await this.bindProviderRuntimeToken(this.sandbox.sandboxId);
    }
  }

  private async bindProviderRuntimeToken(sandboxId: string): Promise<void> {
    if (!this.providerRuntimeToken || !this.options.providerRouting) return;
    const ok = await bindProviderRuntimeTokenRequest(
      this.options.providerRouting,
      {
        token: this.providerRuntimeToken.token,
        sandboxId,
      },
    );
    if (!ok) {
      throw new Error("Failed to bind provider runtime token to sandbox");
    }
  }

  private async setupManagedBrowser(sandbox: SandboxInstance): Promise<void> {
    if (!this.managedBrowserSession || !this.options.managedBrowser) return;

    const setup = getManagedBrowserSandboxSetup(
      this.options.managedBrowser.provider,
      this.managedBrowserSession,
    );
    for (const dir of setup.directories) {
      await sandbox.files.makeDir(dir);
    }
    for (const file of setup.files) {
      await sandbox.files.write(file.path, file.data);
    }
  }

  private async closeManagedBrowserSession(): Promise<void> {
    if (!this.managedBrowserSession || !this.options.managedBrowser) return;
    const session = this.managedBrowserSession;
    this.managedBrowserSession = undefined;
    try {
      await stopManagedBrowserSession(this.options.managedBrowser, session);
    } catch (error) {
      console.warn(
        `[Evolve] Managed browser cleanup failed: ${(error as Error).message}`,
      );
    }
  }

  private async closeProviderRuntimeToken(strict = false): Promise<void> {
    if (!this.providerRuntimeToken || !this.options.providerRouting) return;
    const token = this.providerRuntimeToken;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ok = await revokeProviderRuntimeTokenRequest(
          this.options.providerRouting,
          { token: token.token },
        );
        if (!ok) throw new Error("Dashboard returned ok=false");
        this.providerRuntimeToken = undefined;
        return;
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) =>
            setTimeout(resolve, 100 * (attempt + 1)),
          );
        }
      }
    }

    const message = `Provider runtime token cleanup failed: ${(lastError as Error).message}`;
    if (strict) {
      throw new Error(message);
    }
    console.warn(`[Evolve] ${message}`);
    this.providerRuntimeToken = undefined;
  }

  private async ensureManagedSecretRuntimeToken(): Promise<void> {
    if (this.managedSecretRuntimeToken || !this.options.managedSecrets) return;
    this.managedSecretRuntimeToken = await createManagedSecretRuntimeToken(
      {
        apiKey: this.options.managedSecrets.apiKey,
        dashboardUrl: this.options.managedSecrets.dashboardUrl,
      },
      {
        sessionTag: this.sessionTag,
        secrets: this.options.managedSecrets.secrets,
      },
    );
  }

  private async bindManagedSecretRuntimeToken(sandboxId: string): Promise<void> {
    if (!this.managedSecretRuntimeToken || !this.options.managedSecrets) return;
    const ok = await bindManagedSecretRuntimeToken(
      {
        apiKey: this.options.managedSecrets.apiKey,
        dashboardUrl: this.options.managedSecrets.dashboardUrl,
      },
      {
        token: this.managedSecretRuntimeToken.token,
        sandboxId,
      },
    );
    if (!ok) {
      throw new Error("Failed to bind managed secret runtime token to sandbox");
    }
  }

  private async setupManagedSecretEgress(sandbox: SandboxInstance): Promise<void> {
    if (!this.managedSecretRuntimeToken) return;
    await sandbox.files.makeDir(MANAGED_SECRET_PROXY_DIR);
    await sandbox.commands.run(
      `umask 077 && mkdir -p ${MANAGED_SECRET_PROXY_DIR}/certs && chmod 700 ${MANAGED_SECRET_PROXY_DIR} ${MANAGED_SECRET_PROXY_DIR}/certs`,
      { timeoutMs: 5_000 },
    );
    await sandbox.files.write(MANAGED_SECRET_PROXY_SCRIPT_PATH, MANAGED_SECRET_PROXY_SCRIPT);
    await sandbox.files.write(
      MANAGED_SECRET_PROXY_CONFIG_PATH,
      managedSecretProxyConfig(this.managedSecretRuntimeToken),
    );
    await sandbox.commands.run(
      `chmod 700 ${MANAGED_SECRET_PROXY_SCRIPT_PATH} && chmod 600 ${MANAGED_SECRET_PROXY_CONFIG_PATH}`,
      { timeoutMs: 5_000 },
    );
    await sandbox.commands.run(managedSecretCaSetupCommand(), { timeoutMs: 30_000 });
    this.managedSecretProxy = await sandbox.commands.spawn(
      managedSecretProxyStartCommand(),
      { timeoutMs: 30_000 },
    );
    const health = await sandbox.commands.run(
      `python3 - <<'PY'\nimport socket, sys, time\nfor _ in range(50):\n    try:\n        s = socket.create_connection(("127.0.0.1", ${MANAGED_SECRET_PROXY_PORT}), timeout=0.2)\n        s.close()\n        sys.exit(0)\n    except OSError:\n        time.sleep(0.1)\nsys.exit(1)\nPY`,
      { timeoutMs: 10_000 },
    );
    if (health.exitCode !== 0) {
      throw new Error("Managed secret egress proxy failed to start");
    }
    await sandbox.commands.run(managedSecretProxyConfigCleanupCommand(), { timeoutMs: 5_000 });
  }

  private async closeManagedSecretRuntimeToken(): Promise<void> {
    const proxy = this.managedSecretProxy;
    this.managedSecretProxy = undefined;
    if (proxy) {
      await proxy.kill().catch(() => false);
    }
    if (!this.managedSecretRuntimeToken || !this.options.managedSecrets) return;
    const token = this.managedSecretRuntimeToken;
    let lastError: unknown;
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const ok = await revokeManagedSecretRuntimeToken(
            {
              apiKey: this.options.managedSecrets.apiKey,
              dashboardUrl: this.options.managedSecrets.dashboardUrl,
            },
            { token: token.token },
          );
          if (!ok) throw new Error("Dashboard returned ok=false");
          return;
        } catch (error) {
          lastError = error;
          if (attempt < 2) {
            await new Promise((resolve) =>
              setTimeout(resolve, 100 * (attempt + 1)),
            );
          }
        }
      }
      console.warn(
        `[Evolve] Managed secret runtime token cleanup failed: ${(lastError as Error).message}`,
      );
    } finally {
      this.managedSecretRuntimeToken = undefined;
    }
  }

  /**
   * Build the inline gateway config JSON for agents using gatewayConfigEnv
   * (e.g., OpenCode OPENCODE_CONFIG_CONTENT). Centralizes the provider config
   * so buildEnvironmentVariables() and buildRunEnvs() don't duplicate it.
   *
   * Deep-merges with user-provided config from secrets (if any) so that
   * non-litellm providers, plugins, and other settings are preserved.
   * Only patches provider.litellm.models[selectedModel].headers and selected variant metadata.
   *
   * Source-verified: model.headers → provider.ts:1061 → llm.ts:221 → HTTP request.
   */
  private buildGatewayConfigJson(headers: Record<string, string>): string {
    const providerRuntime = this.requireActiveProviderRuntimeToken();
    // External gateway mode: the caller owns the base URL (and its path
    // shape) exactly as supplied — never the Evolve gateway default.
    const baseUrl = this.agentConfig.externalGateway
      ? this.agentConfig.baseUrl ?? withOpenAiV1Path(getGatewayUrl(this.registry.gatewayPath))
      : providerRuntime?.baseUrl ??
        withOpenAiV1Path(getGatewayUrl(this.registry.gatewayPath));
    const selectedModel = this.resolveCommandModel(
      this.agentConfig.model || this.registry.defaultModel,
    );

    // Start from user-provided config if available, preserving non-litellm settings
    let config: Record<string, unknown> = {};
    const userValue = this.options.secrets?.[this.registry.gatewayConfigEnv!];
    if (userValue) {
      try {
        config = JSON.parse(userValue);
      } catch {
        /* invalid JSON — start fresh */
      }
    }

    const providers = (config.provider as Record<string, unknown>) ?? {};
    const litellm = (providers.litellm as Record<string, unknown>) ?? {};
    const existingOptions = (litellm.options as Record<string, unknown>) ?? {};
    const existingModels = (litellm.models as Record<string, unknown>) ?? {};
    const existingModel =
      (existingModels[selectedModel] as Record<string, unknown>) ?? {};
    const existingHeaders =
      (existingModel.headers as Record<string, string>) ?? {};
    const reasoningVariant =
      this.agentConfig.type === "opencode"
        ? getOpenCodeReasoningVariant(this.reasoningEffort())
        : undefined;
    const existingVariants =
      (existingModel.variants as Record<string, unknown>) ?? {};
    const selectedVariant = reasoningVariant
      ? ((existingVariants[reasoningVariant] as Record<string, unknown>) ?? {})
      : undefined;

    config.provider = {
      ...providers,
      litellm: {
        ...litellm,
        npm: "@ai-sdk/openai-compatible",
        options: {
          ...existingOptions,
          baseURL: baseUrl,
          apiKey: providerRuntime?.token ?? this.agentConfig.apiKey,
        },
        models: {
          ...existingModels,
          [selectedModel]: {
            ...existingModel,
            name: selectedModel,
            headers: { ...existingHeaders, ...headers },
            ...(reasoningVariant
              ? {
                  variants: {
                    ...existingVariants,
                    [reasoningVariant]: {
                      ...selectedVariant,
                      reasoningEffort: reasoningVariant,
                    },
                  },
                }
              : {}),
          },
        },
      },
    };

    return JSON.stringify(config);
  }

  private activeProviderRuntimeToken(): ProviderRuntimeToken | undefined {
    const provider = providerRuntimeProviderForAgent(this.agentConfig.type);
    return provider && this.providerRuntimeToken?.provider === provider
      ? this.providerRuntimeToken
      : undefined;
  }

  private requireActiveProviderRuntimeToken():
    ProviderRuntimeToken | undefined {
    const provider = providerRuntimeProviderForAgent(this.agentConfig.type);
    const token = this.activeProviderRuntimeToken();
    if (!this.agentConfig.isDirectMode && provider && !token) {
      throw new Error(
        `${this.agentConfig.type} gateway mode requires a Dashboard runtime token before sandbox setup`,
      );
    }
    return token;
  }

  private ensureSessionLogger(sandbox: SandboxInstance): void {
    if (this.sessionLogger) return;
    const provider = this.options.sandboxProvider;
    this.sessionLogger = new SessionLogger({
      provider: provider?.name || provider?.providerType || "unknown",
      agent: this.agentConfig.type,
      model: this.agentConfig.model || this.registry.defaultModel,
      sandboxId: sandbox.sandboxId,
      tag: this.sessionTag,
      apiKey: this.agentConfig.isDirectMode
        ? undefined
        : this.agentConfig.apiKey,
      observability: {
        ...this.options.observability,
        ...(this.managedBrowserSession && this.options.managedBrowser
          ? {
              browser_provider: this.options.managedBrowser.provider,
              browser_session_id: this.managedBrowserSession.id,
              dashboard_session_id: this.managedBrowserSession.sessionId,
              browser_session_tag: this.managedBrowserSession.sessionTag,
              browser_live_url: this.managedBrowserSession.liveUrl,
            }
          : {}),
      },
    });
  }

  private async flushSessionLoggerWithTimeout(timeoutMs = 2000): Promise<void> {
    if (!this.sessionLogger) return;
    await Promise.race([
      this.sessionLogger.flush(),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  private requiresPreRunDashboardIngest(): boolean {
    return Boolean(this.activeProviderRuntimeToken() || this.managedSecretRuntimeToken);
  }

  private providerRuntimeHeaderUpdates(): Record<string, string> {
    const providerRuntime = this.activeProviderRuntimeToken();
    return providerRuntime
      ? { [PROVIDER_RUNTIME_BINDING_HEADER]: providerRuntime.bindingSecret }
      : {};
  }

  private shouldExposeProviderRuntimeTokenEnv(): boolean {
    return (
      this.agentConfig.type !== "kimi" &&
      !this.registry.gatewayConfigEnv
    );
  }

  private buildProviderRuntimeProcessEnvs(): Record<string, string> {
    // External gateway mode: re-inject the caller-minted credential per spawn,
    // mirroring each CLI's direct-mode env wiring. No runtime token or binding
    // exists. Kimi Code reads KIMI_MODEL_*, not the SDK-facing KIMI_API_KEY/
    // KIMI_BASE_URL; inline-config CLIs (OpenCode) additionally need the
    // provider config env re-injected so a spawn can never race a stale boot env.
    if (this.agentConfig.externalGateway) {
      if (this.agentConfig.type === "kimi") {
        return this.buildKimiDirectModelEnvs();
      }
      const envs: Record<string, string> = {
        [this.registry.apiKeyEnv]: this.agentConfig.apiKey,
      };
      if (this.registry.baseUrlEnv && this.agentConfig.baseUrl) {
        envs[this.registry.baseUrlEnv] = this.agentConfig.baseUrl;
      }
      if (this.registry.gatewayConfigEnv) {
        envs[this.registry.gatewayConfigEnv] = this.buildGatewayConfigJson({});
      }
      // Re-inject Gemini's workspace-trust flag per spawn (mirrors the boot env)
      // so a run can never race a stale boot env and hit the untrusted-workspace
      // exit-55 gate. Auth itself rides ~/.gemini/settings.json, not env.
      if (this.agentConfig.type === "gemini") {
        envs.GEMINI_CLI_TRUST_WORKSPACE = "true";
      }
      return envs;
    }
    const providerRuntime = this.activeProviderRuntimeToken();
    if (!providerRuntime) return {};
    const envs: Record<string, string> = {};
    if (this.shouldExposeProviderRuntimeTokenEnv()) {
      envs[this.registry.apiKeyEnv] = providerRuntime.token;
    }
    if (this.agentConfig.type === "gemini") {
      envs.GEMINI_DEFAULT_AUTH_TYPE = GEMINI_GATEWAY_AUTH_TYPE;
    }
    if (this.registry.baseUrlEnv && this.shouldExposeProviderRuntimeTokenEnv()) {
      envs[this.registry.baseUrlEnv] = providerRuntime.baseUrl;
    }
    if (this.registry.spendTrackingEnvs) {
      envs[PROVIDER_RUNTIME_BINDING_ENV] = providerRuntime.bindingSecret;
    }
    if (this.registry.customHeadersEnv) {
      const headerEnv = this.registry.customHeadersEnv;
      const fmt = this.registry.customHeadersFormat || "newline";
      envs[headerEnv] = mergeCustomHeaders(
        this.options.secrets?.[headerEnv],
        this.providerRuntimeHeaderUpdates(),
        fmt,
      );
    }
    return envs;
  }

  /**
   * Build per-run env overrides for spend tracking.
   * Merges session + run headers into the custom headers env var,
   * or sets per-env-var values for agents using spendTrackingEnvs.
   * Passed to spawn() so each .run() gets a unique run tag.
   */
  private buildRunEnvs(runId: string): Record<string, string> | undefined {
    if (this.agentConfig.externalGateway) {
      // External gateway mode: credential envs only — no LiteLLM spend headers.
      return this.buildProviderRuntimeProcessEnvs();
    }
    if (this.agentConfig.isDirectMode) return undefined;
    const envs = this.buildProviderRuntimeProcessEnvs();

    // Path 1: single custom headers env var (Claude, Gemini)
    const headerEnv = this.registry.customHeadersEnv;
    if (headerEnv) {
      const base = this.options.secrets?.[headerEnv];
      const fmt = this.registry.customHeadersFormat || "newline";
      envs[headerEnv] = mergeCustomHeaders(
        base,
        {
          [LITELLM_CUSTOMER_ID_HEADER]: this.sessionTag,
          [LITELLM_TAGS_HEADER]: `${RUN_TAG_PREFIX}${runId}`,
          ...this.providerRuntimeHeaderUpdates(),
        },
        fmt,
      );
      return envs;
    }

    // Path 2: per-env-var headers (Codex TOML env_http_headers)
    const trackingEnvs = this.registry.spendTrackingEnvs;
    if (trackingEnvs) {
      return {
        ...envs,
        [trackingEnvs.sessionTagEnv]: this.sessionTag,
        [trackingEnvs.runTagEnv]: `${RUN_TAG_PREFIX}${runId}`,
      };
    }

    // Path 3: inline config env with model.headers (OpenCode OPENCODE_CONFIG_CONTENT).
    // Per-run override with both session + run headers.
    if (this.registry.gatewayConfigEnv) {
      return {
        ...envs,
        [this.registry.gatewayConfigEnv]: this.buildGatewayConfigJson({
          [LITELLM_CUSTOMER_ID_HEADER]: this.sessionTag,
          [LITELLM_TAGS_HEADER]: `${RUN_TAG_PREFIX}${runId}`,
          ...this.providerRuntimeHeaderUpdates(),
        }),
      };
    }

    return Object.keys(envs).length > 0 ? envs : undefined;
  }

  private async writeCodexGatewayProviderConfig(
    sandbox: SandboxInstance,
  ): Promise<void> {
    if (this.agentConfig.type !== "codex") {
      return;
    }
    if (this.agentConfig.externalGateway) {
      // External gateway mode: route Codex at the caller-minted gateway.
      // No LiteLLM tracking or runtime binding headers exist in this mode.
      await writeCodexSpendProvider(
        sandbox,
        this.agentConfig.baseUrl || getGatewayUrl(),
        undefined,
        undefined,
        this.homeDir,
      );
      return;
    }
    if (this.agentConfig.isDirectMode || !this.registry.spendTrackingEnvs) {
      return;
    }
    await writeCodexSpendProvider(
      sandbox,
      this.activeProviderRuntimeToken()?.baseUrl ||
        this.agentConfig.baseUrl ||
        getGatewayUrl(),
      this.registry.spendTrackingEnvs,
      this.activeProviderRuntimeToken()
        ? { [PROVIDER_RUNTIME_BINDING_HEADER]: PROVIDER_RUNTIME_BINDING_ENV }
        : undefined,
      this.homeDir,
    );
  }

  private captureDroidSession(
    rawLine: string,
    events: OutputEvent[] | null,
  ): void {
    if (this.agentConfig.type !== "droid") return;

    const eventSessionId = events?.find(
      (event) =>
        typeof event.sessionId === "string" && event.sessionId.length > 0,
    )?.sessionId;
    if (eventSessionId) {
      this.droidSessionId = eventSessionId;
      return;
    }

    const rawSessionId = this.extractDroidSessionId(rawLine);
    if (rawSessionId) {
      this.droidSessionId = rawSessionId;
    }
  }

  private extractDroidSessionId(rawLine: string): string | undefined {
    try {
      return this.findDroidSessionId(JSON.parse(rawLine));
    } catch {
      return undefined;
    }
  }

  private findDroidSessionId(value: unknown): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return undefined;
    const record = value as Record<string, unknown>;
    const direct = record.sessionId ?? record.session_id;
    if (typeof direct === "string" && direct.length > 0) return direct;

    return (
      this.findDroidSessionId(record.result) ??
      this.findDroidSessionId(record.params) ??
      this.findDroidSessionId(record.notification)
    );
  }

  private droidSessionStatePath(): string {
    return `${this.homeDir}/.factory/evolve-session.json`;
  }

  private async loadDroidSessionState(sandbox: SandboxInstance): Promise<void> {
    if (this.agentConfig.type !== "droid" || this.droidSessionId) return;
    try {
      const existing = await sandbox.files.read(this.droidSessionStatePath());
      if (typeof existing !== "string") return;
      const parsed = JSON.parse(existing) as { sessionId?: unknown };
      if (typeof parsed.sessionId === "string" && parsed.sessionId.length > 0) {
        this.droidSessionId = parsed.sessionId;
      }
    } catch {
      // Missing or invalid session state means the next Droid run starts fresh.
    }
  }

  private async writeDroidSessionState(
    sandbox: SandboxInstance,
  ): Promise<void> {
    if (this.agentConfig.type !== "droid" || !this.droidSessionId) return;
    await sandbox.files.makeDir(`${this.homeDir}/.factory`);
    await sandbox.files.write(
      this.droidSessionStatePath(),
      JSON.stringify({ sessionId: this.droidSessionId }, null, 2),
    );
  }

  private resolveGatewayModel(model: string): string {
    if (this.agentConfig.isDirectMode) return model;
    return this.registry.gatewayModelAliases?.[model] ?? model;
  }

  private resolveCommandModel(model: string): string {
    const aliases = this.agentConfig.isDirectMode
      ? this.registry.directModelAliases
      : this.registry.gatewayModelAliases;
    return aliases?.[model] ?? model;
  }

  /**
   * Agent-specific authentication setup
   */
  private async setupAgentAuth(sandbox: SandboxInstance): Promise<void> {
    // File-based OAuth: write auth file directly
    if (this.agentConfig.oauthFileContent && this.registry.oauthFileName) {
      const settingsDir = expandPath(
        this.registry.mcpConfig.settingsDir,
        this.homeDir,
      );
      await sandbox.files.makeDir(settingsDir);
      await sandbox.files.write(
        `${settingsDir}/${this.registry.oauthFileName}`,
        this.agentConfig.oauthFileContent,
      );
      return;
    }
    if (
      this.agentConfig.type === "gemini" &&
      (!this.agentConfig.isDirectMode || this.agentConfig.externalGateway)
    ) {
      // External gateway mode resolves to isDirectMode=true, but Gemini still
      // needs its gateway auth method written to ~/.gemini/settings.json — the
      // CLI selects auth from this file, and without it fails with exit 41
      // ("Invalid auth method selected"). The env var alone is insufficient.
      await this.writeGeminiGatewayAuthSettings(sandbox);
    }
    // Default: run setup command (e.g., "codex login --with-api-key")
    if (this.registry.setupCommand) {
      await sandbox.commands.run(this.registry.setupCommand, {
        timeoutMs: 30000,
      });
    }
  }

  private async writeGeminiGatewayAuthSettings(
    sandbox: SandboxInstance,
  ): Promise<void> {
    const settingsDir = expandPath(
      this.registry.mcpConfig.settingsDir,
      this.homeDir,
    );
    const settingsPath = `${settingsDir}/${this.registry.mcpConfig.filename}`;

    await sandbox.files.makeDir(settingsDir);

    let settings: Record<string, unknown> = {};
    try {
      const existing = await sandbox.files.read(settingsPath);
      if (typeof existing === "string" && existing.trim()) {
        settings = JSON.parse(existing);
      }
    } catch (error) {
      const message = (error as Error).message || "";
      if (!/not found|no such file|does not exist/i.test(message)) {
        throw error;
      }
    }

    const security =
      typeof settings.security === "object" && settings.security !== null
        ? (settings.security as Record<string, unknown>)
        : {};
    const auth =
      typeof security.auth === "object" && security.auth !== null
        ? (security.auth as Record<string, unknown>)
        : {};

    settings.security = {
      ...security,
      auth: {
        ...auth,
        selectedType: GEMINI_GATEWAY_AUTH_TYPE,
      },
    };

    await sandbox.files.write(settingsPath, JSON.stringify(settings, null, 2));
  }

  private async setupAgentPlugins(sandbox: SandboxInstance): Promise<void> {
    await installAgentPlugins(
      this.agentConfig.type,
      sandbox,
      this.options.plugins,
    );
  }

  private assertProviderRuntimeDoesNotExposeGatewayKey(
    mcpServers: Record<string, McpServerConfig>,
  ): void {
    if (!this.activeProviderRuntimeToken()) return;
    const gatewayKey = this.agentConfig.apiKey;
    for (const [name, config] of Object.entries(mcpServers)) {
      for (const value of Object.values(config.headers || {})) {
        if (value.includes(gatewayKey)) {
          throw new Error(
            `MCP server "${name}" would expose the Evolve API key inside the sandbox. Use managed agent-browser or remove this gateway-authenticated MCP server.`,
          );
        }
      }
    }
  }

  /**
   * Setup workspace structure and files
   *
   * @param opts.skipSystemPrompt - When true, skip writing the system prompt file.
   *   Used on restore from checkpoint: the tar already contains the correct file.
   */
  private async setupWorkspace(
    sandbox: SandboxInstance,
    opts?: { skipSystemPrompt?: boolean },
  ): Promise<void> {
    const workspaceMode = this.options.workspaceMode || "knowledge";

    if (workspaceMode !== "task") {
      // Create workspace folders (swe mode includes repo/)
      const folders =
        workspaceMode === "swe"
          ? `${this.workingDir}/repo ${this.workingDir}/context ${this.workingDir}/scripts ${this.workingDir}/temp ${this.workingDir}/output`
          : `${this.workingDir}/context ${this.workingDir}/scripts ${this.workingDir}/temp ${this.workingDir}/output`;

      await sandbox.commands.run(`mkdir -p ${folders}`, { timeoutMs: 30000 });

      // Write system prompt file (skip on restore — checkpoint tar has the correct one)
      if (!opts?.skipSystemPrompt) {
        const fullPrompt = buildWorkerSystemPrompt({
          workingDir: this.workingDir,
          systemPrompt: this.options.systemPrompt,
          browserPrompt: this.options.browserPrompt,
          schema: this.zodSchema || this.jsonSchema,
          mode: workspaceMode,
        });

        const filePath = `${this.workingDir}/${this.registry.systemPromptFile}`;
        await sandbox.files.write(filePath, fullPrompt);
      }

      if (this.options.context) {
        await this.uploadContextFiles(sandbox, this.options.context);
      }
      if (this.options.files) {
        await this.uploadWorkspaceFiles(sandbox, this.options.files);
      }
    }

    // Setup managed integrations and MCP servers
    let mcpServers: Record<string, McpServerConfig> = {
      ...this.options.mcpServers,
    };

    if (this.options.integrations) {
      const integrationsMcp = await setupIntegrations({
        ...this.options.integrations,
        sessionTag: this.sessionTag,
      });
      mcpServers = {
        ...mcpServers,
        integrations: {
          type: "http",
          url: integrationsMcp.url,
          headers: integrationsMcp.headers,
        },
      };
    }

    if (this.options.browserCredentials) {
      if (
        !this.options.managedBrowser ||
        this.options.managedBrowser.provider !== "agent-browser"
      ) {
        throw new Error(
          "Browser credentials require managed remote agent-browser.",
        );
      }
      if (
        !this.managedBrowserSession?.id ||
        !this.managedBrowserSession.sessionTag ||
        !this.managedBrowserSession.browserAuthGrantToken
      ) {
        throw new Error(
          "Managed browser session is missing browser credential grant data.",
        );
      }
      const browserLoginMcp = await createBrowserLoginMcpServer({
        apiKey: this.options.browserCredentials.apiKey,
        dashboardUrl: this.options.browserCredentials.dashboardUrl,
        browserSessionId: this.managedBrowserSession.id,
        sessionTag: this.managedBrowserSession.sessionTag,
        grantToken: this.managedBrowserSession.browserAuthGrantToken,
        config: this.options.browserCredentials.config,
      });
      mcpServers = {
        ...mcpServers,
        [BROWSER_LOGIN_MCP_SERVER_NAME]: browserLoginMcp,
      };
    }

    // The user's native config document is the BASE layer and must exist
    // before the platform writers below parse-and-rewrite the same files —
    // that ordering is what stamps platform routing ON TOP of the user's keys
    // (Harbor's codex.py merge order). Claude's document is a separate file
    // delivered per run via --settings, so ordering is moot there but the
    // write belongs with the other settings setup either way.
    await this.writeNativeAgentConfig(sandbox);

    // Write MCP config if any servers configured.
    // NOTE: On restore, this intentionally overwrites the archived MCP config.
    // MCP servers require fresh auth tokens (managed URLs, API keys) that the
    // current Evolve instance generates — stale tokens from the checkpoint won't
    // work. Gateway mode and managed integrations both produce session-scoped URLs.
    if (Object.keys(mcpServers).length > 0) {
      this.assertProviderRuntimeDoesNotExposeGatewayKey(mcpServers);
      await writeMcpConfig(
        this.agentConfig.type,
        sandbox,
        this.workingDir,
        mcpServers,
        this.homeDir,
      );
    }

    // Spend tracking: write model provider config for agents using env_http_headers
    // (e.g., Codex). Must run after MCP config so we append to existing config.toml.
    // Internally guarded — also covers external gateway routing for Codex.
    await this.writeCodexGatewayProviderConfig(sandbox);

    // Spend tracking: write customHeaders to JSON settings file for agents that read
    // headers from config (e.g., Qwen). Session-level only — per-run tags are written
    // before each spawn in run().
    if (
      !this.agentConfig.isDirectMode &&
      this.registry.spendTrackingJsonConfig
    ) {
      await writeJsonSpendHeaders(
        sandbox,
        this.agentConfig.type as "qwen",
        this.registry.spendTrackingJsonConfig.headersPath,
        {
          [LITELLM_CUSTOMER_ID_HEADER]: this.sessionTag,
          ...this.providerRuntimeHeaderUpdates(),
        },
        this.homeDir,
      );
    }

    // Kimi TOML provider spend tracking: handled per-run in run() since we write
    // a dedicated config file from scratch each time (no session-level setup needed).

    // Setup skills
    if (this.skills?.length) {
      await this.setupSkills(sandbox);
    }
  }

  /**
   * Write the user's native config document into the sandbox — the delivery
   * half of the `config` agent option (the `--ak config=...` channel).
   *
   * The document was normalized to a plain object at resolve time
   * (loadNativeAgentConfig), so this method only serializes and writes:
   * JSON for Claude's settings layer, TOML for Codex's base config.toml.
   * chmod 600 because a user settings file may carry values the box's other
   * processes have no business reading (Harbor does the same, base.py:889-912).
   */
  private async writeNativeAgentConfig(sandbox: SandboxInstance): Promise<void> {
    const document = this.effectiveNativeConfigDocument();
    if (!document) return;
    const native = this.registry.nativeConfig;
    if (!native) {
      // Unreachable through validated doors; loud beats silent if a new door forgets.
      throw new Error(
        `Agent "${this.agentConfig.type}" has a config but no nativeConfig registry knowledge`,
      );
    }
    const path = expandPath(native.path, this.homeDir);
    const dir = path.substring(0, path.lastIndexOf("/"));
    const content =
      native.format === "toml"
        ? stringifyToml(document)
        : JSON.stringify(document, null, 2);
    await sandbox.commands.run(`mkdir -p ${dir}`, { timeoutMs: 30000 });
    await sandbox.files.write(path, content);
    await sandbox.commands.run(`chmod 600 ${path}`, { timeoutMs: 30000 });
  }

  /**
   * The native settings document to deliver: the user's config is the BASE
   * and the active preset's configStamp is merged ON TOP (arrays union,
   * scalars overwrite) — a preset is a platform stamp the user document can
   * never undo. A preset alone IS a document: the guarantee cannot depend on
   * whether the user also brought settings. Undefined when neither exists.
   */
  private effectiveNativeConfigDocument(): Record<string, unknown> | undefined {
    const userDocument = this.agentConfig.config;
    const preset = this.agentConfig.preset;
    const stamp = preset ? this.registry.presets?.[preset]?.configStamp : undefined;
    if (!stamp) return userDocument;
    return stampNativeConfig(userDocument ?? {}, stamp);
  }

  /**
   * The active preset's command flags (Codex `-c`), for harnesses whose
   * preset delivery must outrank the config file.
   */
  private presetCommandFlags(): string | undefined {
    const preset = this.agentConfig.preset;
    return preset ? this.registry.presets?.[preset]?.commandFlags : undefined;
  }

  /** Sandbox path of the per-run settings document, for 'settings-flag' delivery. */
  private nativeConfigFlagPath(): string | undefined {
    const native = this.registry.nativeConfig;
    if (!native || native.delivery !== "settings-flag" || !this.effectiveNativeConfigDocument()) {
      return undefined;
    }
    return expandPath(native.path, this.homeDir);
  }

  /**
   * Setup skills for the agent.
   *
   * References (skills.sh/<owner>/<repo>[/<skill>], org/repo[@ref], https git
   * URLs, local folders) go through the one resolver in skills.ts — fetched
   * pinned, cached by content, then mounted into the CLI-specific skills
   * directory where the harness auto-discovers them. The resolved provenance
   * (name, source, exact commit, content digest) is kept on the instance so
   * callers — the hosted eval worker included — can record what actually ran.
   */
  private async setupSkills(sandbox: SandboxInstance): Promise<void> {
    if (!this.skills?.length) return;

    const { skillsConfig } = this.registry;
    const targetDir = expandPath(skillsConfig.targetDir, this.homeDir);

    const resolved = await resolveSkills(this.skills);
    this.resolvedSkillsList = resolved;
    await mountSkills(sandbox, resolved, targetDir);
  }

  /**
   * Provenance of the skills mounted into this session's sandbox: one entry
   * per skill with its source reference, exact git commit (when git-backed)
   * and Harbor-recipe content digest. Empty until setup has run, and empty
   * for sessions configured without skills.
   */
  resolvedSkills(): ResolvedSkill[] {
    return this.resolvedSkillsList ?? [];
  }

  /**
   * Upload context files to context/ folder
   */
  private async uploadContextFiles(
    sandbox: SandboxInstance,
    files: FileMap,
  ): Promise<void> {
    const entries = Object.entries(files).map(([name, content]) => ({
      path: `${this.workingDir}/context/${name}`,
      data: content,
    }));

    if (entries.length === 0) return;

    // Create parent directories
    const dirs = new Set(
      entries
        .map((e) => e.path.substring(0, e.path.lastIndexOf("/")))
        .filter(Boolean),
    );
    if (dirs.size > 0) {
      await sandbox.commands.run(`mkdir -p ${Array.from(dirs).join(" ")}`, {
        timeoutMs: 30000,
      });
    }

    await sandbox.files.writeBatch(entries);
  }

  /**
   * Upload workspace files to working directory
   */
  private async uploadWorkspaceFiles(
    sandbox: SandboxInstance,
    files: FileMap,
  ): Promise<void> {
    const entries = Object.entries(files).map(([path, content]) => ({
      // Support absolute paths (use as-is) and relative paths (prefix with workingDir)
      path: path.startsWith("/") ? path : `${this.workingDir}/${path}`,
      data: content,
    }));

    if (entries.length === 0) return;

    // Create parent directories
    const dirs = new Set(
      entries
        .map((e) => e.path.substring(0, e.path.lastIndexOf("/")))
        .filter(Boolean),
    );
    if (dirs.size > 0) {
      await sandbox.commands.run(`mkdir -p ${Array.from(dirs).join(" ")}`, {
        timeoutMs: 30000,
      });
    }

    await sandbox.files.writeBatch(entries);
  }

  // ===========================================================================
  // COMMAND BUILDING
  // ===========================================================================

  /**
   * Build the CLI command for running the agent
   */
  private buildCommand(prompt: string): string {
    return this.registry.buildCommand({
      prompt: this.agentConfig.type === "droid" ? prompt : escapePrompt(prompt),
      model: this.resolveCommandModel(
        this.agentConfig.model || this.registry.defaultModel,
      ),
      isResume: this.hasRun,
      sessionId:
        this.agentConfig.type === "droid" ? this.droidSessionId : undefined,
      reasoningEffort: this.reasoningEffort(),
      nativeConfigPath: this.nativeConfigFlagPath(),
      presetFlags: this.presetCommandFlags(),
      isDirectMode: this.agentConfig.isDirectMode,
      isExternalGateway: Boolean(this.agentConfig.externalGateway),
      skills: this.skills,
      homeDir: this.homeDir,
    });
  }

  // ===========================================================================
  // RUN METHOD
  // ===========================================================================

  /**
   * Run agent with prompt
   *
   * Streams output via callbacks, returns final response.
   */
  /** Per-run TOML provider spend tracking (Kimi): write provider with
   *  custom_headers before spawning. CLI reads config at startup, so each run
   *  gets a fresh write. Extracted so the effort pin on this path is testable. */
  private async writeKimiPerRunConfig(
    sandbox: SandboxInstance,
    runId: string,
  ): Promise<void> {
    if (
      this.agentConfig.isDirectMode ||
      !this.registry.spendTrackingTomlProvider
    ) {
      return;
    }
    const providerRuntime = this.requireActiveProviderRuntimeToken();
    await writeKimiSpendConfig(
      sandbox,
      // Same per-model ceiling the direct-mode envs use — never Kimi's own
      // 262144 for a model from another family.
      {
        ...this.registry.spendTrackingTomlProvider,
        maxContextSize: this.resolveKimiMaxContextSize(),
      },
      {
        [LITELLM_CUSTOMER_ID_HEADER]: this.sessionTag,
        [LITELLM_TAGS_HEADER]: `${RUN_TAG_PREFIX}${runId}`,
        ...this.providerRuntimeHeaderUpdates(),
      },
      {
        baseUrl: withOpenAiV1Path(
          providerRuntime?.baseUrl ?? getGatewayUrl(this.registry.gatewayPath),
        ),
        apiKey: providerRuntime?.token ?? this.agentConfig.apiKey,
        model: this.resolveCommandModel(
          this.agentConfig.model || this.registry.defaultModel,
        ),
        defaultThinking: isThinkingEnabled(this.reasoningEffort()),
        thinkingEffort: getKimiCodeThinkingEffort(this.reasoningEffort()),
      },
      this.homeDir,
    );
  }

  async run(
    options: RunOptions,
    callbacks?: StreamCallbacks,
  ): Promise<AgentResponse> {
    if (this.credentialsSealed) {
      throw new Error(
        "Agent credentials are sealed; this Evolve instance cannot run the agent again",
      );
    }
    // Before any sandbox work or command building: a prompt is the one field a
    // run cannot default, and an absent one used to surface as a TypeError from
    // the shell-quoting helper.
    validateRunOptions(options);
    const {
      prompt,
      timeoutMs = DEFAULT_TIMEOUT_MS,
      background = false,
      checkpointComment,
    } = options;
    let { from } = options;
    if (this.activeCommand) {
      throw new Error(
        "Agent is already running. Call interrupt(), wait for the active/background run to finish, or create a new Evolve instance.",
      );
    }

    // =========================================================================
    // GUARD: mutual exclusivity check before any network calls
    // =========================================================================
    if (from) {
      if (this.sandbox || this.options.sandboxId) {
        throw new Error(
          "Cannot restore into existing sandbox. Call kill() first, or create a new Evolve instance.",
        );
      }
    }

    // =========================================================================
    // RESOLVE "latest": convert to concrete checkpoint ID
    // =========================================================================
    if (from === "latest") {
      if (!this.storage) {
        throw new Error(
          'Storage not configured. Call .withStorage() before using from: "latest".',
        );
      }
      const latest = await getLatestCheckpoint(this.storage);
      if (!latest) {
        throw new Error('No checkpoints found for from: "latest".');
      }
      from = latest.id;
    }

    // =========================================================================
    // RESTORE PATH: if `from` is provided, restore checkpoint into fresh sandbox
    // =========================================================================
    if (from) {
      if (!this.storage) {
        throw new Error(
          "Storage not configured. Call .withStorage() before using 'from'.",
        );
      }
      if (!this.options.sandboxProvider) {
        throw new Error("No sandbox provider configured");
      }

      // Create fresh sandbox
      await this.ensureManagedBrowserSession(callbacks);
      await this.ensureProviderRuntimeToken();
      await this.ensureManagedSecretRuntimeToken();
      const envVars = this.buildEnvironmentVariables();
      this.sandboxState = "booting";
      this.emitLifecycle(callbacks, "sandbox_boot");
      try {
        this.sandbox = await this.options.sandboxProvider.create(
          this.buildSandboxCreateOptions(envVars),
        );
        await this.bindProviderRuntimeToken(this.sandbox.sandboxId);
        await this.bindManagedSecretRuntimeToken(this.sandbox.sandboxId);
        await this.setupManagedSecretEgress(this.sandbox);

        // Restore checkpoint archive into sandbox (returns metadata for validation)
        const ckptMeta = await restoreCheckpoint(
          this.sandbox,
          this.storage,
          from,
        );

        await this.setupManagedBrowser(this.sandbox);

        // Validate agent type — changing agent type on restore is structural (wrong
        // dirs, wrong CLI, wrong config format). Model changes are fine.
        if (
          ckptMeta.agentType &&
          ckptMeta.agentType !== this.agentConfig.type
        ) {
          throw new Error(
            `Cannot restore checkpoint: agent type mismatch (checkpoint: ${ckptMeta.agentType}, current: ${this.agentConfig.type})`,
          );
        }

        // Validate workspace mode — changing mode on restore could break directory
        // layout and system prompt assumptions. Skip check for old checkpoints
        // that don't have this field.
        const currentMode = this.options.workspaceMode || "knowledge";
        if (ckptMeta.workspaceMode && ckptMeta.workspaceMode !== currentMode) {
          throw new Error(
            `Cannot restore checkpoint: workspace mode mismatch (checkpoint: ${ckptMeta.workspaceMode}, current: ${currentMode})`,
          );
        }

        // Fresh auth setup (overwrites stale tokens from archive)
        await this.setupAgentAuth(this.sandbox);

        // Re-apply plugin setup so restored sandboxes match the current config.
        await this.setupAgentPlugins(this.sandbox);

        // Workspace setup — skip system prompt write on restore UNLESS the user
        // explicitly configured prompt-affecting options on this instance
        const hasExplicitPromptConfig = !!(
          this.options.systemPrompt ||
          this.options.browserPrompt ||
          this.zodSchema ||
          this.jsonSchema
        );
        await this.setupWorkspace(this.sandbox, {
          skipSystemPrompt: !hasExplicitPromptConfig,
        });
        await this.loadDroidSessionState(this.sandbox);

        // Mark as resumed so CLI uses --continue flag
        this.hasRun = true;
        // Track lineage: the checkpoint we restored from
        this.lastCheckpointId = from;
        this.sandboxState = "ready";
        this.agentState = "idle";
        this.emitLifecycle(callbacks, "sandbox_ready");
      } catch (error) {
        if (this.sandbox) {
          await this.sandbox.kill().catch(() => {});
          this.sandbox = undefined;
        }
        await this.closeManagedBrowserSession().catch(() => {});
        await this.closeProviderRuntimeToken().catch(() => {});
        await this.closeManagedSecretRuntimeToken().catch(() => {});
        this.sandboxState = "error";
        this.agentState = "error";
        this.emitLifecycle(callbacks, "sandbox_error");
        throw error;
      }
    }

    const sandbox = await this.getSandbox(callbacks);
    await this.ensureProviderRuntimeToken();
    await this.loadDroidSessionState(sandbox);

    // Track turn start time BEFORE process starts (for output file filtering)
    // Files modified AFTER this time will be returned by getOutputFiles()
    this.lastRunTimestamp = Date.now();

    // Initialize session logger on first run (local logging always, dashboard sync only in gateway mode)
    this.ensureSessionLogger(sandbox);

    // Log the prompt (non-blocking)
    this.sessionLogger?.writePrompt(prompt);
    if (this.requiresPreRunDashboardIngest()) {
      await this.flushSessionLoggerWithTimeout();
    }

    // Build command and per-run spend tracking env
    const command = this.buildCommand(prompt);
    const runId = randomUUID();
    const runEnvs = this.buildRunEnvs(runId);

    await this.writeCodexGatewayProviderConfig(sandbox);

    // Per-run config-file spend tracking (Qwen): write both session + run headers
    // to settings.json before spawning. Each run gets a fresh file write because
    // the CLI reads the config at startup (not per-request from env).
    if (
      !this.agentConfig.isDirectMode &&
      this.registry.spendTrackingJsonConfig
    ) {
      await writeJsonSpendHeaders(
        sandbox,
        this.agentConfig.type as "qwen",
        this.registry.spendTrackingJsonConfig.headersPath,
        {
          [LITELLM_CUSTOMER_ID_HEADER]: this.sessionTag,
          [LITELLM_TAGS_HEADER]: `${RUN_TAG_PREFIX}${runId}`,
          ...this.providerRuntimeHeaderUpdates(),
        },
        this.homeDir,
      );
    }

    if (this.agentConfig.type === "qwen") {
      await writeQwenThinkingConfig(
        sandbox,
        isThinkingEnabled(this.reasoningEffort()),
        this.homeDir,
      );
    }

    await this.writeKimiPerRunConfig(sandbox, runId);

    // Per-run Droid gateway settings: Droid custom models read extraHeaders from
    // settings at startup, so rewrite the Evolve-owned settings file each run.
    // External gateway mode uses the same settings file (Droid cannot be routed
    // by env alone) with the caller's base URL VERBATIM and no LiteLLM headers.
    if (
      (!this.agentConfig.isDirectMode || this.agentConfig.externalGateway) &&
      this.registry.droidGatewaySettings
    ) {
      const isExternalGateway = Boolean(this.agentConfig.externalGateway);
      const providerRuntime = isExternalGateway
        ? undefined
        : this.requireActiveProviderRuntimeToken();
      await writeDroidGatewaySettings(
        sandbox,
        {
          ...this.registry.droidGatewaySettings,
          model: this.resolveCommandModel(
            this.agentConfig.model || this.registry.defaultModel,
          ),
          baseUrl: isExternalGateway
            ? this.agentConfig.baseUrl ?? getGatewayUrl()
            : withOpenAiV1Path(providerRuntime?.baseUrl ?? getGatewayUrl()),
          apiKeyEnv: this.registry.apiKeyEnv,
        },
        isExternalGateway
          ? {}
          : {
              [LITELLM_CUSTOMER_ID_HEADER]: this.sessionTag,
              [LITELLM_TAGS_HEADER]: `${RUN_TAG_PREFIX}${runId}`,
              ...this.providerRuntimeHeaderUpdates(),
            },
        this.homeDir,
      );
    }

    // Line buffer for NDJSON parsing (shared by both modes)
    let lineBuffer = "";

    // Create parser once (shared by onContent callback and session logger)
    const parser = createAgentParser(this.agentConfig.type);

    // Streaming callback for stdout (shared by both modes)
    const onStdout = (chunk: string) => {
      // Line-based NDJSON parsing
      lineBuffer += chunk;
      const lines = lineBuffer.split("\n");
      lineBuffer = lines.pop() ?? ""; // Keep incomplete line

      for (const line of lines) {
        if (!line.trim()) continue;

        // Parse once, use for both session logger and onContent
        const events = parser(line);
        this.captureDroidSession(line, events);

        // Log to session logger with pre-parsed events (non-blocking)
        this.sessionLogger?.writeEventParsed(line, events);

        // Emit raw stdout with newline (matches raw output)
        callbacks?.onStdout?.(line + "\n");

        // Emit content events to callback
        if (events && callbacks?.onContent) {
          for (const event of events) {
            callbacks.onContent(event);
          }
        }
      }
    };

    // Streaming callback for stderr (shared by both modes)
    const onStderr = (chunk: string) => {
      callbacks?.onStderr?.(chunk);
    };

    // Spawn for both background and foreground to support interrupt()
    const handle = await sandbox.commands.spawn(command, {
      cwd: this.workingDir,
      timeoutMs,
      envs: runEnvs,
      onStdout,
      onStderr,
    });
    const opId = this.beginOperation("run", handle, callbacks, "run_start");
    // Mark as resumed for subsequent runs as soon as execution starts.
    this.hasRun = true;

    if (background) {
      this.watchBackgroundOperation(opId, "run", handle, callbacks, sandbox);
      return {
        sandboxId: sandbox.sandboxId,
        sessionId: this.managedBrowserSession?.sessionId,
        browser: this.browserResponseInfo(),
        runId,
        exitCode: 0,
        stdout: `Background process started with ID ${handle.processId}`,
        stderr: "",
      };
    }

    let result;
    try {
      result = await handle.wait();
    } catch (error) {
      this.interruptedOperations.delete(opId);
      this.finalizeOperation(opId, callbacks, "run_failed", "error");
      throw error;
    }

    const interrupted =
      this.interruptedOperations.delete(opId) || result.exitCode === 130;
    if (interrupted) {
      this.finalizeOperation(opId, callbacks, "run_interrupted", "interrupted");
    } else if (result.exitCode === 0) {
      this.finalizeOperation(opId, callbacks, "run_complete", "idle");
    } else {
      this.finalizeOperation(opId, callbacks, "run_failed", "error");
    }

    // Process any remaining buffered content
    if (lineBuffer.trim()) {
      // Parse once, use for both session logger and onContent
      const events = parser(lineBuffer);
      this.captureDroidSession(lineBuffer, events);

      // Log to session logger with pre-parsed events (non-blocking)
      this.sessionLogger?.writeEventParsed(lineBuffer, events);

      // Emit raw stdout
      callbacks?.onStdout?.(lineBuffer + "\n");

      // Emit content events to callback
      if (events && callbacks?.onContent) {
        for (const event of events) {
          callbacks.onContent(event);
        }
      }
    }

    await this.writeDroidSessionState(sandbox);

    // Flush observability events so dashboard is complete before returning.
    // This ensures Python SDK (and any caller) gets deterministic flushing
    // as part of run() — no reliance on timers or explicit kill().
    // Capped at 2s so dashboard slowness never delays the caller.
    if (this.sessionLogger && !background) {
      await this.flushSessionLoggerWithTimeout();
    }

    // =========================================================================
    // AUTO-CHECKPOINT: after successful foreground run with storage configured
    // =========================================================================
    let checkpoint: CheckpointInfo | undefined;
    if (this.storage && !background && result.exitCode === 0) {
      try {
        checkpoint = await createCheckpoint(
          sandbox,
          this.storage,
          this.agentConfig.type,
          this.workingDir,
          {
            tag: this.sessionTag,
            model: this.agentConfig.model || this.registry.defaultModel,
            workspaceMode: this.options.workspaceMode || "knowledge",
            comment: checkpointComment,
            parentId: this.lastCheckpointId,
          },
        );
        this.lastCheckpointId = checkpoint.id;
      } catch (e) {
        // Non-fatal: log warning, return response without checkpoint
        console.warn(
          `[Evolve] Auto-checkpoint failed: ${(e as Error).message}`,
        );
      }
    }

    return {
      sandboxId: sandbox.sandboxId,
      sessionId: this.managedBrowserSession?.sessionId,
      browser: this.browserResponseInfo(),
      runId,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      checkpoint,
    };
  }

  // ===========================================================================
  // EXECUTE COMMAND
  // ===========================================================================

  /**
   * Execute arbitrary command in sandbox
   */
  async executeCommand(
    command: string,
    options: ExecuteCommandOptions = {},
    callbacks?: StreamCallbacks,
  ): Promise<AgentResponse> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, background = false } = options;
    if (this.activeCommand) {
      throw new Error(
        "Agent is already running. Call interrupt(), wait for the active/background command to finish, or create a new Evolve instance.",
      );
    }
    const sandbox = await this.getSandbox(callbacks);
    if (!this.credentialsSealed) {
      await this.ensureProviderRuntimeToken();
    }

    // Track turn start time BEFORE process starts (for output file filtering)
    // Files modified AFTER this time will be returned by getOutputFiles()
    this.lastRunTimestamp = Date.now();

    if (this.requiresPreRunDashboardIngest()) {
      this.ensureSessionLogger(sandbox);
      this.sessionLogger?.writePrompt(command);
      await this.flushSessionLoggerWithTimeout();
    }

    let stdout = "";
    let stderr = "";

    // Streaming callbacks (shared by both modes)
    const onStdout = (chunk: string) => {
      stdout += chunk;
      callbacks?.onStdout?.(chunk);
    };
    const onStderr = (chunk: string) => {
      stderr += chunk;
      callbacks?.onStderr?.(chunk);
    };

    const commandEnvs = this.credentialsSealed
      ? {}
      : this.buildProviderRuntimeProcessEnvs();
    const handle = await sandbox.commands.spawn(command, {
      cwd: this.workingDir,
      timeoutMs,
      envs: Object.keys(commandEnvs).length > 0 ? commandEnvs : undefined,
      onStdout,
      onStderr,
    });
    const opId = this.beginOperation(
      "command",
      handle,
      callbacks,
      "command_start",
    );

    if (background) {
      this.watchBackgroundOperation(opId, "command", handle, callbacks);
      return {
        sandboxId: sandbox.sandboxId,
        sessionId: this.managedBrowserSession?.sessionId,
        browser: this.browserResponseInfo(),
        exitCode: 0,
        stdout: `Background process started with ID ${handle.processId}`,
        stderr: "",
      };
    }

    let result;
    try {
      result = await handle.wait();
    } catch (error) {
      this.interruptedOperations.delete(opId);
      this.finalizeOperation(opId, callbacks, "command_failed", "error");
      throw error;
    }

    const interrupted =
      this.interruptedOperations.delete(opId) || result.exitCode === 130;
    if (interrupted) {
      this.finalizeOperation(
        opId,
        callbacks,
        "command_interrupted",
        "interrupted",
      );
    } else if (result.exitCode === 0) {
      this.finalizeOperation(opId, callbacks, "command_complete", "idle");
    } else {
      this.finalizeOperation(opId, callbacks, "command_failed", "error");
    }

    return {
      sandboxId: sandbox.sandboxId,
      sessionId: this.managedBrowserSession?.sessionId,
      browser: this.browserResponseInfo(),
      exitCode: result.exitCode,
      // Prefer streaming-collected output; fall back to wait() result
      // (handles race condition where command completes before stream connects)
      stdout: stdout || result.stdout || "",
      stderr: stderr || result.stderr || "",
    };
  }

  /**
   * Permanently revoke the model capability attached to this sandbox.
   * This is intentionally fail-closed: configurations that may have placed
   * other credentials in the sandbox cannot claim to be sealed.
   */
  async sealCredentials(): Promise<void> {
    if (this.credentialsSealed) return;
    if (!this.sandbox) {
      throw new Error("No active sandbox. Call run() or executeCommand() first.");
    }
    if (this.activeCommand) {
      throw new Error("Cannot seal credentials while a process is running.");
    }
    if (this.agentConfig.isDirectMode && !this.agentConfig.externalGateway) {
      throw new Error(
        "Credential sealing requires gateway mode; direct provider credentials cannot be revoked by Evolve",
      );
    }

    const unsafeInputs = [
      this.options.secrets && Object.keys(this.options.secrets).length > 0,
      this.options.sandboxCreateOptions?.envs &&
        Object.keys(this.options.sandboxCreateOptions.envs).length > 0,
      this.options.managedSecrets,
      this.options.integrations,
      this.options.mcpServers && Object.keys(this.options.mcpServers).length > 0,
      this.options.managedBrowser,
      this.options.browserCredentials,
    ];
    if (unsafeInputs.some(Boolean)) {
      throw new Error(
        "Credential sealing requires a credential-minimal sandbox: omit secrets, managed secrets, integrations, MCP servers, and browser credentials",
      );
    }
    // External gateway mode: the caller minted the credential, so the caller's
    // revoke() is the revocation authority. If it throws, sealing FAILS — the
    // sandbox is never marked sealed on a failed revocation.
    if (this.agentConfig.externalGateway) {
      await this.agentConfig.externalGateway.revoke();
      this.credentialsSealed = true;
      return;
    }
    // Mirror closeProviderRuntimeToken()'s early-return conditions exactly: if
    // either is missing, revocation would silently no-op and sealing would be a
    // false guarantee. Fail loudly instead.
    if (!this.providerRuntimeToken || !this.options.providerRouting) {
      throw new Error(
        "Cannot seal credentials: no active provider runtime token to revoke. " +
          "Without a gateway-issued runtime token the sandbox may hold credentials Evolve cannot revoke, so sealing would be a false guarantee.",
      );
    }

    await this.closeProviderRuntimeToken(true);
    this.credentialsSealed = true;
  }

  /** Whether sealCredentials() has completed — the sandbox holds no revocable model credential. */
  isSealed(): boolean {
    return this.credentialsSealed;
  }

  /** Collect caller-declared files or directories after the credential boundary. */
  async collectArtifacts(paths: string[]): Promise<FileMap> {
    if (!this.credentialsSealed) {
      throw new Error("Call sealCredentials() before collecting artifacts.");
    }
    if (!this.sandbox) {
      throw new Error("No active sandbox.");
    }
    if (this.activeCommand) {
      throw new Error("Cannot collect artifacts while a process is running.");
    }
    return collectSandboxArtifacts(this.sandbox, this.workingDir, paths);
  }

  // ===========================================================================
  // FILE OPERATIONS
  // ===========================================================================

  /**
   * Upload context files (to context/ folder)
   */
  async uploadContext(files: FileMap): Promise<void> {
    const sandbox = await this.getSandbox();
    await this.uploadContextFiles(sandbox, files);
  }

  /**
   * Upload files to working directory
   */
  async uploadFiles(files: FileMap): Promise<void> {
    const sandbox = await this.getSandbox();
    await this.uploadWorkspaceFiles(sandbox, files);
  }

  /**
   * Upload one LOCAL file into the sandbox by path, without holding its bytes
   * in the process heap.
   *
   * uploadFiles() takes a FileMap — the bytes as a value — so a caller
   * uploading a large artifact pays one full-size Buffer per concurrent
   * upload. This takes the local path instead: the provider streams it off
   * disk (or hands its own SDK the path), so peak memory is a chunk rather
   * than the file. Use it for anything big enough that N concurrent uploads
   * would matter; uploadFiles() stays the right call for small content.
   *
   * `sandboxPath` follows the uploadFiles() convention: absolute paths are
   * used as-is, relative paths resolve under the working directory.
   *
   * Providers that expose no cheaper path than a plain write fall back to
   * reading the file — correct everywhere, cheap where the provider helps.
   */
  async uploadFileFromPath(sandboxPath: string, localPath: string): Promise<void> {
    const sandbox = await this.getSandbox();
    const target = sandboxPath.startsWith("/")
      ? sandboxPath
      : `${this.workingDir}/${sandboxPath}`;
    const dir = target.substring(0, target.lastIndexOf("/"));
    if (dir) {
      await sandbox.commands.run(`mkdir -p ${dir}`, { timeoutMs: 30000 });
    }
    if (sandbox.files.writeFromPath) {
      await sandbox.files.writeFromPath(target, localPath);
      return;
    }
    const { readFile } = await import("node:fs/promises");
    await sandbox.files.write(target, await readFile(localPath));
  }

  /**
   * Get output files from output/ folder with optional schema validation
   *
   * Returns files modified after the last run() call.
   * If schema was provided, validates result.json and returns typed data.
   *
   * @param recursive - Include files in subdirectories (default: false)
   */
  async getOutputFiles<T = unknown>(
    recursive = false,
  ): Promise<OutputResult<T>> {
    const sandbox = await this.getSandbox();
    const outputDir = `${this.workingDir}/output`;

    // Get file list with ctime (inode change time)
    // ctime reflects when the file was actually written to disk, even if mtime is overwritten
    // (e.g., wget sets mtime to server's Last-Modified, but ctime is the local write time)
    const depthArg = recursive ? "" : "-maxdepth 1";
    const result = await sandbox.commands.run(
      `find ${outputDir} ${depthArg} -type f -exec stat -c '%n|%Z' {} \\; 2>/dev/null || true`,
      { timeoutMs: 30000 },
    );

    const lines = result.stdout.split("\n").filter(Boolean);

    // Convert turn start time to seconds for comparison with stat's ctime
    // Subtract 2 seconds to account for potential clock skew between host and sandbox
    const turnStartTimeSec = this.lastRunTimestamp
      ? Math.floor(this.lastRunTimestamp / 1000) - 2
      : 0;

    // Parse and filter files
    const filesToRead: string[] = [];
    const outputDirPrefix = `${outputDir}/`;

    for (const line of lines) {
      const [fullPath, ctimeStr] = line.split("|");
      if (!fullPath || !ctimeStr) continue;

      const ctimeSec = parseInt(ctimeStr, 10);

      // Only include files created/written after the current turn started
      if (turnStartTimeSec > 0 && ctimeSec < turnStartTimeSec) {
        continue;
      }

      filesToRead.push(fullPath);
    }

    // Read all files in parallel
    const files: FileMap = {};
    const results = await Promise.all(
      filesToRead.map(async (fullPath) => {
        try {
          const content = await sandbox.files.read(fullPath);
          // Get relative path from output/ directory
          const relativePath = fullPath.startsWith(outputDirPrefix)
            ? fullPath.slice(outputDirPrefix.length)
            : fullPath.split("/").pop() || fullPath;
          return { relativePath, content };
        } catch {
          return null;
        }
      }),
    );

    for (const r of results) {
      if (r) files[r.relativePath] = r.content;
    }

    // No schema - return files only
    if (!this.zodSchema && !this.jsonSchema) return { files, data: null };

    // Validate result.json against schema
    const json = files["result.json"];
    if (!json) {
      return {
        files,
        data: null,
        error: "Schema provided but agent did not create output/result.json",
      };
    }

    // Convert to string once (for parsing and rawData)
    const rawData =
      typeof json === "string"
        ? json
        : new TextDecoder().decode(json as Uint8Array);

    try {
      const parsed = JSON.parse(rawData);

      // Validate with Zod if provided
      if (this.zodSchema) {
        const validated = this.zodSchema.safeParse(parsed);
        return validated.success
          ? { files, data: validated.data as T }
          : {
              files,
              data: null,
              error: `Schema validation failed: ${validated.error.message}`,
              rawData,
            };
      }

      // Validate with Ajv (JSON Schema)
      if (this.compiledValidator) {
        const valid = this.compiledValidator(parsed);
        if (valid) {
          return { files, data: parsed as T };
        } else {
          const errors =
            this.compiledValidator.errors
              ?.map((e) => `${e.instancePath} ${e.message}`)
              .join(", ") || "Unknown validation error";
          return {
            files,
            data: null,
            error: `Schema validation failed: ${errors}`,
            rawData,
          };
        }
      }

      return { files, data: null };
    } catch (e) {
      return {
        files,
        data: null,
        error: `Failed to parse result.json: ${(e as Error).message}`,
        rawData,
      };
    }
  }

  // ===========================================================================
  // EXPLICIT CHECKPOINT
  // ===========================================================================

  /**
   * Create an explicit checkpoint of the current sandbox state.
   *
   * Requires an active sandbox (call run() first).
   *
   * @param options.comment - Optional label for this checkpoint
   */
  async checkpoint(options?: { comment?: string }): Promise<CheckpointInfo> {
    if (!this.storage) {
      throw new Error("Storage not configured. Call .withStorage().");
    }
    if (!this.sandbox) {
      throw new Error("No active sandbox. Call run() first.");
    }

    const result = await createCheckpoint(
      this.sandbox,
      this.storage,
      this.agentConfig.type,
      this.workingDir,
      {
        tag: this.sessionTag,
        model: this.agentConfig.model || this.registry.defaultModel,
        workspaceMode: this.options.workspaceMode || "knowledge",
        comment: options?.comment,
        parentId: this.lastCheckpointId,
      },
    );
    this.lastCheckpointId = result.id;
    return result;
  }

  // ===========================================================================
  // SANDBOX CONTROL
  // ===========================================================================

  /**
   * Get current session (sandbox ID)
   */
  getSession(): string | null {
    return this.sandbox?.sandboxId || this.options.sandboxId || null;
  }

  /**
   * Set session (sandbox ID) to connect to
   *
   * When reconnecting to an existing sandbox, we assume the agent
   * may have already run commands, so we set hasRun=true to use
   * the continue/resume command template instead of first-run.
   */
  async setSession(sandboxId: string): Promise<void> {
    if (this.credentialsSealed) {
      throw new Error(
        "Agent credentials are sealed and this Evolve instance cannot switch sandboxes",
      );
    }
    if (this.options.managedSecrets) {
      throw new Error("setSession() cannot be used with managed secrets; managed secret grants are sandbox-scoped.");
    }
    if (this.options.sandboxCreateOptions?.user) {
      throw new Error(
        "setSession() cannot be used with a configured sandbox user; the user cannot be enforced on an existing sandbox.",
      );
    }
    // Interrupt active operation before switching sessions
    if (this.activeCommand) {
      const interrupted = await this.interrupt();
      if (!interrupted) {
        throw new Error(
          "Cannot switch session while an active process is running and could not be interrupted.",
        );
      }
    }

    await this.rotateSession();
    await this.closeProviderRuntimeToken();
    await this.closeManagedSecretRuntimeToken();
    await this.closeManagedBrowserSession();

    this.options.sandboxId = sandboxId;
    this.sandbox = undefined;
    this.interruptedOperations.clear();
    this.invalidateActiveOperation();
    this.sandboxState = "ready";
    this.agentState = "idle";
    // Assume existing sandbox may have prior runs - use continue command
    this.hasRun = true;
    // Reset lineage — switching sandbox breaks checkpoint chain
    this.lastCheckpointId = undefined;
  }

  /**
   * Pause sandbox
   */
  async pause(callbacks?: StreamCallbacks): Promise<void> {
    if (this.sandbox) {
      if (this.activeCommand) {
        await this.interrupt(callbacks);
      }
      await this.sandbox.pause();
      this.sandboxState = "paused";
      this.agentState = "idle";
      this.emitLifecycle(callbacks, "sandbox_pause");
    }
  }

  /**
   * Resume sandbox
   */
  async resume(callbacks?: StreamCallbacks): Promise<void> {
    if (this.sandbox && this.options.sandboxProvider) {
      this.sandbox = await this.options.sandboxProvider.connect(
        this.sandbox.sandboxId,
      );
      this.sandboxState = "ready";
      this.agentState = "idle";
      this.emitLifecycle(callbacks, "sandbox_resume");
    }
  }

  /**
   * Interrupt active command without killing the sandbox.
   */
  async interrupt(callbacks?: StreamCallbacks): Promise<boolean> {
    if (!this.activeCommand && !this.activeProcessId) {
      return false;
    }

    const opId = this.activeOperationId;
    const operationKind = this.activeOperationKind;
    let killed = false;

    try {
      if (this.activeCommand) {
        killed = await this.activeCommand.kill();
      } else if (this.sandbox && this.activeProcessId) {
        killed = await this.sandbox.commands.kill(this.activeProcessId);
      }
    } catch {
      killed = false;
    }

    if (!killed) {
      this.sandboxState = "running";
      this.agentState = "running";
      return false;
    }

    if (opId !== null) {
      this.interruptedOperations.add(opId);
    }
    this.invalidateActiveOperation();
    this.sandboxState = "ready";
    this.agentState = "interrupted";

    const reason: LifecycleReason =
      operationKind === "run" ? "run_interrupted" : "command_interrupted";
    this.emitLifecycle(callbacks, reason);

    return killed;
  }

  /**
   * Get current runtime status for sandbox and agent.
   */
  status(): SessionStatus {
    const browser = this.browserRuntimeInfo();
    return {
      sandboxId: this.getSession(),
      sandbox: this.sandboxState,
      agent: this.agentState,
      activeProcessId: this.activeProcessId,
      hasRun: this.hasRun,
      timestamp: new Date().toISOString(),
      ...(browser ? { browser } : {}),
    };
  }

  /**
   * Kill sandbox (terminates all processes)
   */
  async kill(callbacks?: StreamCallbacks): Promise<void> {
    await this.rotateSession();

    let killError: unknown;

    try {
      // Interrupt active operation before killing sandbox
      if (this.activeCommand) {
        await this.interrupt(callbacks);
      }

      // Kill sandbox (terminates all processes inside)
      if (this.sandbox) {
        await this.sandbox.kill();
        this.sandbox = undefined;
      }
    } catch (error) {
      killError = error;
    } finally {
      await this.closeProviderRuntimeToken();
      await this.closeManagedSecretRuntimeToken();
      await this.closeManagedBrowserSession();
    }

    if (killError) {
      throw killError;
    }

    // Session is no longer valid after sandbox termination.
    this.options.sandboxId = undefined;
    this.interruptedOperations.clear();
    this.invalidateActiveOperation();
    this.sandboxState = "stopped";
    this.agentState = "idle";
    this.hasRun = false;
    this.lastCheckpointId = undefined;
    this.emitLifecycle(callbacks, "sandbox_killed");
  }

  /**
   * Get host URL for a port
   */
  async getHost(port: number): Promise<string> {
    const sandbox = await this.getSandbox();
    return sandbox.getHost(port);
  }

  /**
   * Get agent type
   */
  getAgentType(): AgentType {
    return this.agentConfig.type;
  }

  // ===========================================================================
  // OBSERVABILITY
  // ===========================================================================

  /**
   * Get current session tag.
   * Returns null if no active session (before sandbox creation or after kill()).
   * Used for both observability (dashboard traces) and spend tracking (gateway customer-id).
   */
  getSessionTag(): string | null {
    // Only expose the tag when there's an active session (sandbox exists or logger initialized)
    if (!this.sandbox && !this.sessionLogger) return null;
    return this.sessionTag;
  }

  /**
   * Get current session timestamp
   *
   * Returns null if no session has started (run() not called yet).
   */
  getSessionTimestamp(): string | null {
    return this.sessionLogger?.getTimestamp() || null;
  }

  /**
   * Flush pending observability events without closing the session.
   */
  async flushObservability(): Promise<void> {
    await this.sessionLogger?.flush();
  }

  /**
   * Tear down the session logger and rotate the session tag.
   * Preserves `previousSessionTag` only if this session had actual activity,
   * so a double kill() or no-op lifecycle call doesn't clobber the real tag.
   * @internal
   */
  private async rotateSession(): Promise<void> {
    const hadActivity = !!this.sessionLogger;
    if (this.sessionLogger) {
      await this.sessionLogger.close();
      this.sessionLogger = undefined;
    }
    if (hadActivity) {
      this.previousSessionTag = this.sessionTag;
    }
    this.sessionTag = generateSessionTag(
      this.options.sessionTagPrefix || "evolve",
    );
  }

  // ===========================================================================
  // COST
  // ===========================================================================

  /**
   * Fetch spend data from dashboard API.
   * @internal
   */
  private async fetchSpend(params: URLSearchParams): Promise<Response> {
    if (this.agentConfig.isDirectMode) {
      throw new Error(
        "Cost tracking requires gateway mode (set EVOLVE_API_KEY).",
      );
    }
    const apiKey = this.agentConfig.apiKey;
    if (!apiKey) {
      throw new Error("Cost tracking requires an API key.");
    }
    const dashboardUrl =
      process.env.EVOLVE_DASHBOARD_URL || DEFAULT_DASHBOARD_URL;
    const res = await fetch(`${dashboardUrl}/api/sessions/spend?${params}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Spend query failed (${res.status}): ${body}`);
    }
    return res;
  }

  /**
   * Resolve the session tag for cost queries.
   * Uses the active session tag, or falls back to the previous tag after kill()/setSession().
   * @internal
   */
  private resolveSpendTag(): string {
    // Active session takes priority
    if (this.sandbox || this.sessionLogger) return this.sessionTag;
    // After kill()/setSession(), fall back to previous session
    if (this.previousSessionTag) return this.previousSessionTag;
    throw new Error("No session to query. Call run() first.");
  }

  /**
   * Normalize run payloads for compatibility with older dashboard responses.
   * Older responses may omit `asOf`, `isComplete`, or `truncated` inside `runs[]`.
   * @internal
   */
  private normalizeRunCost(
    run: Omit<RunCost, "asOf" | "isComplete" | "truncated"> &
      Partial<Pick<RunCost, "asOf" | "isComplete" | "truncated">>,
    defaults: Pick<RunCost, "asOf" | "isComplete" | "truncated">,
  ): RunCost {
    return {
      ...run,
      asOf: run.asOf ?? defaults.asOf,
      isComplete: run.isComplete ?? defaults.isComplete,
      truncated: run.truncated ?? defaults.truncated,
    };
  }

  /**
   * Normalize session payloads so all `runs[]` conform to `RunCost`.
   * @internal
   */
  private normalizeSessionCost(session: SessionCost): SessionCost {
    const defaults = {
      asOf: session.asOf,
      isComplete: session.isComplete,
      truncated: session.truncated,
    };
    return {
      ...session,
      runs: session.runs.map((run) => this.normalizeRunCost(run, defaults)),
    };
  }

  /**
   * Get cost breakdown for the current session (all runs).
   *
   * Cost data can lag live usage by about a minute.
   * Also works after kill() for the most recent session only.
   *
   * Requires gateway mode (EVOLVE_API_KEY).
   */
  async getSessionCost(): Promise<SessionCost> {
    const tag = this.resolveSpendTag();
    const params = new URLSearchParams({ tag });
    const res = await this.fetchSpend(params);
    const raw = (await res.json()) as SessionCost;
    return this.normalizeSessionCost(raw);
  }

  /**
   * Get cost for a specific run by ID or index.
   *
   * @param run - Either `{ runId: string }` or `{ index: number }` (1-based, negative = from end)
   *
   * Also works after kill() for the most recent session only.
   * Requires gateway mode (EVOLVE_API_KEY).
   */
  async getRunCost(
    run: { runId: string } | { index: number },
  ): Promise<RunCost> {
    const tag = this.resolveSpendTag();

    if ("runId" in run) {
      const params = new URLSearchParams({ tag, runId: run.runId });
      const res = await this.fetchSpend(params);
      const raw = (await res.json()) as Omit<
        RunCost,
        "asOf" | "isComplete" | "truncated"
      > &
        Partial<Pick<RunCost, "asOf" | "isComplete" | "truncated">>;
      return this.normalizeRunCost(raw, {
        asOf: new Date().toISOString(),
        isComplete: false,
        truncated: false,
      });
    }

    // Index-based: fetch full session, resolve index
    const session = await this.getSessionCost();
    const idx = run.index > 0 ? run.index - 1 : session.runs.length + run.index;
    const found = session.runs[idx];
    if (!found) {
      throw new Error(
        `Run index ${run.index} out of range. Session has ${session.runs.length} run(s).`,
      );
    }
    return found;
  }
}
