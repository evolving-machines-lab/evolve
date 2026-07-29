/**
 * Agent Registry
 *
 * Single source of truth for agent-specific behavior.
 * All differences between agents are data, not code.
 */

import type { AgentType, ReasoningEffort, SkillsConfig } from "./types";
import { DEFAULT_HOME_DIR } from "./constants";

// =============================================================================
// REGISTRY TYPES
// =============================================================================

/** Model configuration */
export interface ModelInfo {
  /** Model alias (short name used with --model) */
  alias: string;
  /** Full model ID */
  modelId: string;
  /** What this model is best for */
  description: string;
  /** Per-model context ceiling where it differs from the harness default
   *  (e.g. Kimi K3's 1M window vs the K2-era 262144). Consumers fall back to
   *  the harness-level value when absent. */
  maxContextSize?: number;
}

/** MCP configuration for an agent */
export interface McpConfigInfo {
  /** Settings directory (e.g., "~/.claude") */
  settingsDir: string;
  /** Config filename (e.g., "settings.json" or "config.toml") */
  filename: string;
  /** Config format */
  format: "json" | "toml";
  /** Whether to use workingDir for project-level config (Claude only) */
  projectConfig?: boolean;
}

/** Options for building agent commands */
export interface BuildCommandOptions {
  prompt: string;
  model: string;
  isResume: boolean;
  sessionId?: string;
  reasoningEffort?: string;
  isDirectMode?: boolean;
  /**
   * External gateway mode (caller-minted credential + base URL). Direct-mode
   * env injection applies, but CLIs that route via generated config (OpenCode
   * inline config, Droid settings file) must use their GATEWAY command shape
   * pointed at the caller's gateway — with the model passed VERBATIM (route
   * names belong to the caller's gateway, never to Evolve's alias maps).
   */
  isExternalGateway?: boolean;
  /** Skills enabled for this run */
  skills?: string[];
  /** Sandbox home directory (default: "/home/user") */
  homeDir?: string;
}

export interface AgentRegistryEntry {
  /** Sandbox image/template identifier (provider maps to its own concept) */
  image: string;

  /** Environment variable name for API key */
  apiKeyEnv: string;

  /** Environment variable name for OAuth (file path or token depending on agent) */
  oauthEnv?: string;

  /** OAuth credentials filename (e.g., "auth.json" for Codex, "oauth_creds.json" for Gemini) */
  oauthFileName?: string;

  /** Environment variable to set when OAuth is active (e.g., GOOGLE_GENAI_USE_GCA=true for Gemini) */
  oauthActivationEnv?: { key: string; value: string };

  /** Environment variable name for base URL, if this CLI supports one */
  baseUrlEnv?: string;

  /** Default model alias */
  defaultModel: string;

  /**
   * Reasoning effort Evolve pins when the caller omits `reasoningEffort`.
   *
   * Every run stamps this value explicitly on the wire (flag/env/config file)
   * instead of relying on the vendor's silent default — managed-evals
   * reproducibility requires the effort a run used to be recorded, not implied
   * by whatever the CLI happened to default to that week. Where the vendor
   * documents a default, the pin matches it; where none is documented, the pin
   * is Evolve's choice (noted per entry). Absent only for harnesses with no
   * effort control (Gemini).
   */
  defaultReasoningEffort?: ReasoningEffort;

  /** Available models for this agent */
  models: ModelInfo[];

  /** System prompt filename (e.g., "CLAUDE.md") */
  systemPromptFile: string;

  /** MCP configuration */
  mcpConfig: McpConfigInfo;

  /** Build the CLI command for this agent */
  buildCommand: (opts: BuildCommandOptions) => string;

  /** Extra setup step (e.g., codex login) */
  setupCommand?: string;

  /** Gateway path prefix for CLIs that use a provider-native passthrough endpoint */
  gatewayPath?: string;
  /** Default base URL for direct mode (only needed if provider requires specific endpoint, e.g., Qwen → Dashscope) */
  defaultBaseUrl?: string;
  /** Available beta headers for this agent (for reference) */
  availableBetas?: Record<string, string>;
  /** Skills configuration for this agent */
  skillsConfig: SkillsConfig;
  /** Multi-provider env mapping: model prefix → keyEnv (for CLIs like OpenCode that resolve provider from model string) */
  providerEnvMap?: Record<string, { keyEnv: string }>;
  /** Env var for inline config (e.g., OPENCODE_CONFIG_CONTENT) — used in gateway mode to set provider base URLs */
  gatewayConfigEnv?: string;
  /** Gateway-only model aliases for CLIs whose native model IDs differ from the Evolve gateway's route names */
  gatewayModelAliases?: Record<string, string>;
  /** Direct-mode model aliases for CLIs whose public model names differ from CLI-native model IDs */
  directModelAliases?: Record<string, string>;
  /** Do not set provider API key env in gateway mode (used when routing via generated settings instead) */
  skipApiKeyEnvInGateway?: boolean;
  /** Dedicated Droid settings file for Evolve gateway custom model routing */
  droidGatewaySettings?: {
    settingsPath: string;
    displayName: string;
    provider: "generic-chat-completion-api" | "openai" | "anthropic";
    maxOutputTokens?: number;
  };
  /** Environment variable that CLI reads for custom outbound HTTP headers */
  customHeadersEnv?: string;
  /** Format for custom headers env var: "newline" (Claude) or "comma" (Gemini). Default: "newline" */
  customHeadersFormat?: "newline" | "comma";
  /**
   * Per-env-var spend tracking for CLIs that support env_http_headers in config
   * (e.g., Codex TOML). Maps Evolve gateway header names to env var names that the CLI
   * reads at request time. Alternative to customHeadersEnv for agents without a
   * single custom-headers env var.
   */
  spendTrackingEnvs?: {
    /** Env var name for x-litellm-customer-id value */
    sessionTagEnv: string;
    /** Env var name for x-litellm-tags value */
    runTagEnv: string;
  };
  /**
   * Config-file-based spend tracking for CLIs that read custom headers from a
   * JSON settings file (e.g., Qwen settings.json → model.generationConfig.customHeaders).
   * The SDK writes headers to this file before each run.
   * Source-verified: Qwen reads customHeaders from settings.json, not env vars.
   */
  spendTrackingJsonConfig?: {
    /** JSON path to the customHeaders object (dot-separated) */
    headersPath: string;
  };
  /**
   * TOML provider-based spend tracking for CLIs that read custom_headers from a
   * provider entry in config.toml (e.g., Kimi Code).
   * The SDK writes a provider+model entry with custom_headers before each run.
   * Source-verified: Kimi Code reads custom_headers from
   * providers[name].custom_headers in ~/.kimi-code/config.toml.
   */
  spendTrackingTomlProvider?: {
    /** Config file path (e.g., "~/.kimi-code/config.toml") */
    configPath: string;
    /** Provider name in config (e.g., "evolve-gateway") */
    providerName: string;
    /** Model entry name (e.g., "evolve-default") */
    modelName: string;
    /** Max context size for the model entry */
    maxContextSize: number;
  };
  /** Additional directories to include in checkpoint tar (beyond mcpConfig.settingsDir).
   *  Used for agents like OpenCode that spread state across XDG directories. */
  checkpointDirs?: string[];
  /** Additional relative paths to exclude from checkpoint tar. */
  checkpointExcludes?: string[];
}

/**
 * The effort a run actually stamps: the caller's value when given, else the
 * harness's pinned default. Undefined only for harnesses with no effort
 * control (Gemini). All command/env/config build paths resolve through this
 * so an omitted effort is an explicit stamp of the pin, never the vendor's
 * silent default.
 */
export function resolveReasoningEffort(
  agentType: AgentType,
  reasoningEffort?: string,
): string | undefined {
  return reasoningEffort ?? AGENT_REGISTRY[agentType]?.defaultReasoningEffort;
}

export function isThinkingEnabled(reasoningEffort?: string): boolean {
  return reasoningEffort !== "off"
    && reasoningEffort !== "none"
    && reasoningEffort !== "minimal"
    && reasoningEffort !== "no-thinking";
}

export function getOpenCodeReasoningVariant(reasoningEffort?: string): string | undefined {
  if (reasoningEffort === "off" || reasoningEffort === "none" || reasoningEffort === "no-thinking") return undefined;
  if (!reasoningEffort || reasoningEffort === "thinking" || reasoningEffort === "medium") return "medium";
  if (reasoningEffort === "low" || reasoningEffort === "minimal") return "minimal";
  if (reasoningEffort === "xhigh") return "max";
  return reasoningEffort;
}

function getOpenCodeReasoningFlags(reasoningEffort?: string): string {
  const variant = getOpenCodeReasoningVariant(reasoningEffort);
  return variant ? ` --variant ${variant} --thinking` : "";
}

// =============================================================================
// AGENT REGISTRY
// =============================================================================

/**
 * Registry of all supported agents.
 *
 * Each agent defines a buildCommand function that constructs the CLI command.
 * This is type-safe and handles conditional logic cleanly.
 */
export const AGENT_REGISTRY: Record<AgentType, AgentRegistryEntry> = {
  claude: {
    image: "evolve-all",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    oauthEnv: "CLAUDE_CODE_OAUTH_TOKEN",
    baseUrlEnv: "ANTHROPIC_BASE_URL",
    customHeadersEnv: "ANTHROPIC_CUSTOM_HEADERS",
    defaultModel: "opus",
    // Claude Code's own documented default (code.claude.com/docs/en/model-config,
    // "Adjust effort level", checked 2026-07-29): "The default effort is `high`
    // on every model that supports effort, except Opus 4.7, which defaults to
    // `xhigh`." No model in this lineup is Opus 4.7, so `high` is the vendor
    // default for all of them — stamped explicitly via --effort.
    defaultReasoningEffort: "high",
    models: [
      { alias: "fable", modelId: "claude-fable-5", description: "Highest capability, long-horizon agentic work" },
      { alias: "opus", modelId: "claude-opus-5", description: "Complex reasoning, R&D, architecting" },
      { alias: "sonnet", modelId: "claude-sonnet-5", description: "Daily coding, features, tests" },
      { alias: "haiku", modelId: "claude-haiku-4-5-20251001", description: "Quick tasks, syntax correction" },
      { alias: "opus[1m]", modelId: "opus[1m]", description: "Complex reasoning with 1M context window" },
      { alias: "sonnet[1m]", modelId: "sonnet[1m]", description: "Daily coding with 1M context window" },
    ],
    systemPromptFile: "CLAUDE.md",
    mcpConfig: {
      settingsDir: "~/.claude",
      filename: "settings.json",
      format: "json",
      projectConfig: true,
    },
    skillsConfig: {
      sourceDir: "~/.evolve/skills",
      targetDir: "~/.claude/skills",
    },
    buildCommand: ({ prompt, model, isResume, reasoningEffort }) => {
      const continueFlag = isResume ? "--continue " : "";
      const effortFlag = reasoningEffort ? ` --effort ${reasoningEffort}` : "";
      return `echo "${prompt}" | claude -p ${continueFlag}--model ${model}${effortFlag} --output-format stream-json --verbose --dangerously-skip-permissions`;
    },
  },

  codex: {
    image: "evolve-all",
    apiKeyEnv: "OPENAI_API_KEY",
    oauthEnv: "CODEX_OAUTH_FILE_PATH",
    oauthFileName: "auth.json",
    // NOT A ROUTING KNOB FOR CODEX — kept only because the env var is still
    // read by other OpenAI-shaped tooling that may share this box, and because
    // removing it silently would change what gets exported into the sandbox.
    //
    // codex 0.145 IGNORES OPENAI_BASE_URL outright. Measured 2026-07-26: with
    // OPENAI_BASE_URL=http://127.0.0.1:9/v1 codex still dialled
    // wss://api.openai.com/v1/responses and then https://api.openai.com/v1/responses
    // — with and without auth.json present, and with the variable exported
    // before `codex login`. The ONLY thing that redirects codex is a provider
    // block: `-c model_provider=X -c model_providers.X.base_url=…`, which is
    // exactly what mcp/toml.ts writes into ~/.codex/config.toml as
    // [model_providers.evolve-gateway]. Gateway routing therefore does not
    // depend on this field, and anything that starts depending on it is broken
    // before it ships.
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultModel: "gpt-5.6-sol",
    // OpenAI's documented default for codex (model_reasoning_effort: medium).
    // Stamped explicitly via -c model_reasoning_effort on every run.
    defaultReasoningEffort: "medium",
    models: [
      { alias: "gpt-5.6-sol", modelId: "gpt-5.6-sol", description: "Newest frontier flagship" },
      { alias: "gpt-5.6-terra", modelId: "gpt-5.6-terra", description: "Balances intelligence and cost" },
      { alias: "gpt-5.6-luna", modelId: "gpt-5.6-luna", description: "High-volume, cost-sensitive tier" },
      { alias: "gpt-5.5", modelId: "gpt-5.5", description: "Previous frontier model" },
      { alias: "gpt-5.3-codex", modelId: "gpt-5.3-codex", description: "Industry-leading code-optimized" },
    ],
    systemPromptFile: "AGENTS.md",
    mcpConfig: {
      settingsDir: "~/.codex",
      filename: "config.toml",
      format: "toml",
    },
    skillsConfig: {
      sourceDir: "~/.evolve/skills",
      targetDir: "~/.codex/skills",
    },
    spendTrackingEnvs: {
      sessionTagEnv: "EVOLVE_LITELLM_CUSTOMER_ID",
      runTagEnv: "EVOLVE_LITELLM_TAGS",
    },
    setupCommand: `printf '%s\\n' "$OPENAI_API_KEY" | codex login --with-api-key`,
    buildCommand: ({ prompt, model, isResume, reasoningEffort }) => {
      const effortFlag = reasoningEffort ? ` -c model_reasoning_effort="${reasoningEffort}"` : "";
      const resumeFlag = isResume ? " resume --last" : "";
      return `printf '%s' "${prompt}" | codex exec --model ${model}${effortFlag} --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json${resumeFlag}`;
    },
  },

  gemini: {
    image: "evolve-all",
    apiKeyEnv: "GEMINI_API_KEY",
    oauthEnv: "GEMINI_OAUTH_FILE_PATH",
    oauthFileName: "oauth_creds.json",
    oauthActivationEnv: { key: "GOOGLE_GENAI_USE_GCA", value: "true" },
    baseUrlEnv: "GOOGLE_GEMINI_BASE_URL",
    defaultModel: "gemini-3.6-flash",
    models: [
      { alias: "gemini-3.6-flash", modelId: "gemini-3.6-flash", description: "Newest stable workhorse: coding + agentic planning" },
      { alias: "gemini-3.5-flash-lite", modelId: "gemini-3.5-flash-lite", description: "Most cost-effective 3.5-class model" },
      { alias: "gemini-3.1-pro-preview", modelId: "gemini-3.1-pro-preview", description: "Latest pro, complex agentic + coding" },
    ],
    systemPromptFile: "GEMINI.md",
    mcpConfig: {
      settingsDir: "~/.gemini",
      filename: "settings.json",
      format: "json",
    },
    skillsConfig: {
      sourceDir: "~/.evolve/skills",
      targetDir: "~/.gemini/skills",
    },
    // Source-verified: GEMINI_CLI_CUSTOM_HEADERS is read in contentGenerator.ts and parsed
    // by customHeaderUtils.ts (comma-separated via /,(?=\s*[^,:]+:)/). Not in public docs.
    customHeadersEnv: "GEMINI_CLI_CUSTOM_HEADERS",
    customHeadersFormat: "comma",
    gatewayPath: "/gemini",
    buildCommand: ({ prompt, model, isResume }) => {
      const resumeFlag = isResume ? "--resume latest " : "";
      return `gemini ${resumeFlag}--prompt ${shellSingleQuote(prompt)} --model ${model} --yolo --output-format stream-json`;
    },
  },

  qwen: {
    image: "evolve-all",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultModel: "qwen3.7-max",
    // Qwen models default to thinking on; pinned so the enable_thinking config
    // write is always an explicit choice, never the CLI's silent default.
    defaultReasoningEffort: "thinking",
    models: [
      { alias: "qwen3.7-max", modelId: "qwen3.7-max", description: "Strongest reasoning and coding option" },
      { alias: "qwen3.7-plus", modelId: "qwen3.7-plus", description: "Latest balanced Qwen Cloud recommendation" },
      { alias: "qwen3.6-flash", modelId: "qwen3.6-flash", description: "Fast and cost-effective option" },
    ],
    systemPromptFile: "QWEN.md",
    mcpConfig: {
      settingsDir: "~/.qwen",
      filename: "settings.json",
      format: "json",
    },
    skillsConfig: {
      sourceDir: "~/.evolve/skills",
      targetDir: "~/.qwen/skills",
    },
    // Source-verified: Qwen reads customHeaders from settings.json model.generationConfig,
    // not from env vars. The SDK writes headers to this path before each run.
    spendTrackingJsonConfig: {
      headersPath: "model.generationConfig.customHeaders",
    },
    gatewayModelAliases: {
      "qwen3.7-max": "dashscope/qwen3.7-max",
      "qwen3.7-plus": "dashscope/qwen3.7-plus",
      "qwen3.6-flash": "dashscope/qwen3.6-flash",
    },
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    buildCommand: ({ prompt, model, isResume, isDirectMode }) => {
      const continueFlag = isResume ? "--continue " : "";
      // Gateway model aliases normally add dashscope/ before this point; keep
      // this fallback for callers that invoke the registry directly.
      const prefixedModel = isDirectMode || model.startsWith("dashscope/")
        ? model
        : `dashscope/${model}`;
      // --auth-type openai is required in non-interactive mode when env vars don't include OPENAI_MODEL
      return `qwen "${prompt}" ${continueFlag}--auth-type openai --model ${prefixedModel} --yolo --output-format stream-json`;
    },
  },

  kimi: {
    image: "evolve-all",
    // SDK-facing direct-mode inputs. Kimi Code itself receives KIMI_MODEL_* envs
    // or ~/.kimi-code/config.toml from Agent.buildEnvironmentVariables()/run().
    apiKeyEnv: "KIMI_API_KEY",
    baseUrlEnv: "KIMI_BASE_URL",
    defaultModel: "kimi-k3",
    // Moonshot's K3 API documents reasoning_effort default max (thinking always
    // on). Pinned here so both kimi wiring paths (KIMI_MODEL_* envs and
    // config.toml) stamp it explicitly.
    defaultReasoningEffort: "max",
    models: [
      { alias: "kimi-k3", modelId: "moonshot/kimi-k3", description: "Latest flagship: 1M context, always-on thinking", maxContextSize: 1048576 },
      { alias: "kimi-k2.7-code", modelId: "moonshot/kimi-k2.7-code", description: "Latest coding-specialized standard model" },
      { alias: "kimi-k3-raptor", modelId: "kimi-k3-raptor", description: "Evolve-managed Kimi K3 Raptor route for latency-sensitive agent runs", maxContextSize: 1048576 },
      { alias: "kimi-k2p7-code-raptor", modelId: "kimi-k2p7-code-raptor", description: "Evolve-managed Kimi K2.7 Code Raptor route for latency-sensitive agent runs" },
    ],
    systemPromptFile: "AGENTS.md",
    mcpConfig: {
      settingsDir: "~/.kimi-code",
      filename: "mcp.json",
      format: "json",
    },
    skillsConfig: {
      sourceDir: "~/.evolve/skills",
      targetDir: "~/.kimi-code/skills",
    },
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    // Source-verified: Kimi Code reads custom_headers from
    // providers[name].custom_headers in ~/.kimi-code/config.toml. Prompt mode
    // has auto approval by default, so no --yolo flag is valid or needed.
    spendTrackingTomlProvider: {
      configPath: "~/.kimi-code/config.toml",
      providerName: "evolve-gateway",
      modelName: "evolve-default",
      maxContextSize: 262144,
    },
    checkpointExcludes: [
      ".kimi-code/config.toml",
    ],
    gatewayModelAliases: {
      "kimi-k3": "moonshot/kimi-k3",
      "kimi-k2.7-code": "moonshot/kimi-k2.7-code",
      "kimi-k3-raptor": "kimi-k3-raptor",
      "kimi-k2p7-code-raptor": "kimi-k2p7-code-raptor",
    },
    buildCommand: ({ prompt, isResume, reasoningEffort, homeDir = DEFAULT_HOME_DIR }) => {
      const continueFlag = isResume ? "--continue " : "";
      const promptArg = shellSingleQuote(prompt);
      const legacyConfigFlag = `--config-file ${homeDir}/.kimi-code/config.toml`;
      const legacyMcpFlag = `$(if [ -f ${homeDir}/.kimi-code/mcp.json ]; then printf ' --mcp-config-file ${homeDir}/.kimi-code/mcp.json'; fi)`;
      const legacyThinkingFlag = isThinkingEnabled(reasoningEffort) ? "" : " --no-thinking";
      // Managed images may briefly carry the Python kimi-cli surface, where
      // --output-format only works with --print and config lives behind flags.
      return `if kimi --help 2>&1 | grep -q -- '--print'; then kimi --print ${continueFlag}${legacyConfigFlag}${legacyMcpFlag}${legacyThinkingFlag} -p ${promptArg} --output-format stream-json; else kimi ${continueFlag}-p ${promptArg} --output-format stream-json; fi`;
    },
  },

  opencode: {
    image: "evolve-all",
    apiKeyEnv: "OPENROUTER_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultModel: "openrouter/anthropic/claude-opus-5",
    // OpenCode runs thinking at the "medium" variant when effort is omitted
    // (see getOpenCodeReasoningVariant); pinned so that choice is registry
    // data, stamped via --variant/--thinking and the litellm variants config.
    defaultReasoningEffort: "medium",
    // OpenRouter-only: all models route through OpenRouter (direct or via the Evolve gateway)
    providerEnvMap: {
      openrouter: { keyEnv: "OPENROUTER_API_KEY" },
    },
    gatewayConfigEnv: "OPENCODE_CONFIG_CONTENT",
    models: [
      { alias: "openrouter/anthropic/claude-fable-5", modelId: "openrouter/anthropic/claude-fable-5", description: "Anthropic Fable via OpenRouter" },
      { alias: "openrouter/anthropic/claude-opus-5", modelId: "openrouter/anthropic/claude-opus-5", description: "Anthropic Opus 5 via OpenRouter" },
      { alias: "openrouter/anthropic/claude-sonnet-5", modelId: "openrouter/anthropic/claude-sonnet-5", description: "Anthropic Sonnet 5 via OpenRouter" },
      { alias: "openrouter/anthropic/claude-haiku-4.5", modelId: "openrouter/anthropic/claude-haiku-4.5", description: "Anthropic Haiku via OpenRouter" },
      { alias: "openrouter/openai/gpt-5.6-sol", modelId: "openrouter/openai/gpt-5.6-sol", description: "OpenAI GPT-5.6 Sol via OpenRouter" },
      { alias: "openrouter/openai/gpt-5.6-terra", modelId: "openrouter/openai/gpt-5.6-terra", description: "OpenAI GPT-5.6 Terra via OpenRouter" },
      { alias: "openrouter/openai/gpt-5.6-luna", modelId: "openrouter/openai/gpt-5.6-luna", description: "OpenAI GPT-5.6 Luna via OpenRouter" },
      { alias: "openrouter/google/gemini-3.6-flash", modelId: "openrouter/google/gemini-3.6-flash", description: "Gemini 3.6 Flash via OpenRouter" },
      { alias: "openrouter/qwen/qwen3.7-max", modelId: "openrouter/qwen/qwen3.7-max", description: "Qwen 3.7 Max via OpenRouter" },
      { alias: "openrouter/moonshotai/kimi-k3", modelId: "openrouter/moonshotai/kimi-k3", description: "Kimi K3 via OpenRouter" },
      { alias: "openrouter/z-ai/glm-5.2", modelId: "openrouter/z-ai/glm-5.2", description: "Zhipu GLM-5.2 via OpenRouter" },
    ],
    systemPromptFile: "AGENTS.md",
    mcpConfig: {
      settingsDir: ".",
      filename: "opencode.json",
      format: "json",
    },
    skillsConfig: {
      sourceDir: "~/.evolve/skills",
      targetDir: "~/.agents/skills",
    },
    // OpenCode uses XDG Base Directory spec — state is split across multiple dirs
    checkpointDirs: [
      "~/.local/share/opencode",  // sessions, auth, snapshots, worktrees, logs
      "~/.config/opencode",       // config.json, AGENTS.md, theme
      "~/.local/state/opencode",  // prompt history, model prefs, TUI state
    ],
    buildCommand: ({ prompt, model, isResume, isDirectMode, isExternalGateway, reasoningEffort }) => {
      const continueFlag = isResume ? "--continue " : "";
      const reasoningFlags = getOpenCodeReasoningFlags(reasoningEffort);
      if (isExternalGateway) {
        // External gateway: OPENCODE_CONFIG_CONTENT defines the litellm
        // provider at the caller's gateway; route the VERBATIM model under it
        // (no openrouter/ rewrite — route names are the caller's).
        return `OPENCODE_PERMISSION='{"*":"allow"}' opencode run ${continueFlag}--model litellm/${model} --format json${reasoningFlags} "${prompt}" < /dev/null`;
      }
      const routedModel = model.startsWith("openrouter/") ? model : `openrouter/${model}`;
      if (!isDirectMode) {
        return `OPENCODE_PERMISSION='{"*":"allow"}' opencode run ${continueFlag}--model litellm/${routedModel} --format json${reasoningFlags} "${prompt}" < /dev/null`;
      }
      return `OPENCODE_PERMISSION='{"*":"allow"}' opencode run ${continueFlag}--model ${routedModel} --format json${reasoningFlags} "${prompt}" < /dev/null`;
    },
  },

  droid: {
    image: "evolve-all",
    apiKeyEnv: "FACTORY_API_KEY",
    defaultModel: "claude-opus-5",
    // Factory documents no default reasoning effort for droid; Evolve pins
    // medium and stamps it via --reasoning-effort on every run.
    defaultReasoningEffort: "medium",
    models: [
      { alias: "claude-fable-5", modelId: "claude-fable-5", description: "Factory-managed Claude Fable 5" },
      { alias: "claude-opus-5", modelId: "claude-opus-5", description: "Factory-managed Claude Opus 5" },
      { alias: "claude-sonnet-5", modelId: "claude-sonnet-5", description: "Factory-managed Claude Sonnet 5" },
      { alias: "claude-haiku-4-5", modelId: "claude-haiku-4-5-20251001", description: "Factory-managed Claude Haiku 4.5" },
      { alias: "gpt-5.6-sol", modelId: "gpt-5.6-sol", description: "Factory-managed GPT-5.6 Sol" },
      { alias: "gpt-5.6-terra", modelId: "gpt-5.6-terra", description: "Factory-managed GPT-5.6 Terra" },
      { alias: "gpt-5.6-luna", modelId: "gpt-5.6-luna", description: "Factory-managed GPT-5.6 Luna" },
      { alias: "gemini-3.6-flash", modelId: "gemini-3.6-flash", description: "Factory-managed Gemini 3.6 Flash" },
      { alias: "qwen3.7-max", modelId: "qwen3.7-max", description: "Qwen 3.7 Max via the Evolve gateway" },
      { alias: "kimi-k3", modelId: "kimi-k3", description: "Factory-managed Droid Core Kimi K3" },
      { alias: "glm-5.2", modelId: "glm-5.2", description: "Factory-managed Droid Core GLM-5.2" },
    ],
    systemPromptFile: "AGENTS.md",
    mcpConfig: {
      settingsDir: "~/.factory",
      filename: "mcp.json",
      format: "json",
    },
    skillsConfig: {
      sourceDir: "~/.evolve/skills",
      targetDir: "~/.factory/skills",
    },
    skipApiKeyEnvInGateway: true,
    gatewayModelAliases: {
      "kimi-k3": "moonshot/kimi-k3",
      "glm-5.2": "openrouter/z-ai/glm-5.2",
      "qwen3.7-max": "dashscope/qwen3.7-max",
    },
    droidGatewaySettings: {
      settingsPath: "~/.factory/evolve-settings.json",
      displayName: "Evolve Gateway",
      // Droid's provider field selects the API protocol. The Evolve gateway
      // exposes a multi-provider OpenAI Chat Completions-compatible API.
      provider: "generic-chat-completion-api",
      maxOutputTokens: 32768,
    },
    checkpointDirs: [
      "~/.factory",
    ],
    buildCommand: ({ prompt, model, isResume, sessionId, reasoningEffort, isDirectMode, isExternalGateway, homeDir = DEFAULT_HOME_DIR }) => {
      // Gateway AND external-gateway modes route through the Evolve-owned
      // settings file (custom model at the gateway); only plain direct mode
      // talks to Factory with a native model id.
      const useGatewaySettings = !isDirectMode || isExternalGateway;
      const settingsFlag = useGatewaySettings ? `--settings ${homeDir}/.factory/evolve-settings.json ` : "";
      const commandModel = useGatewaySettings ? "custom:Evolve-Gateway-0" : model;
      const reasoningFlag = reasoningEffort ? ` --reasoning-effort ${reasoningEffort}` : "";
      const resumeFlag = isResume && sessionId ? `--session-id ${shellSingleQuote(sessionId)} ` : "";
      return `printf '%s' ${shellSingleQuote(prompt)} | droid ${settingsFlag}exec ${resumeFlag}--skip-permissions-unsafe --cwd ${homeDir}/workspace --output-format stream-json --model ${shellSingleQuote(commandModel)}${reasoningFlag}`;
    },
  },
};

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Get registry entry for an agent type
 */
export function getAgentConfig(agentType: AgentType): AgentRegistryEntry {
  const config = AGENT_REGISTRY[agentType];
  if (!config) {
    throw new Error(`Unknown agent type: ${agentType}`);
  }
  return config;
}

/**
 * Check if an agent type is valid
 */
export function isValidAgentType(type: string): type is AgentType {
  return type in AGENT_REGISTRY;
}

/**
 * Expand path with ~ to the sandbox home directory (default: /home/user)
 */
export function expandPath(path: string, homeDir: string = DEFAULT_HOME_DIR): string {
  return path.replace(/^~/, homeDir);
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Get MCP settings path for an agent
 */
export function getMcpSettingsPath(agentType: AgentType, homeDir: string = DEFAULT_HOME_DIR): string {
  const config = getAgentConfig(agentType);
  return `${expandPath(config.mcpConfig.settingsDir, homeDir)}/${config.mcpConfig.filename}`;
}

/**
 * Get MCP settings directory for an agent
 */
export function getMcpSettingsDir(agentType: AgentType, homeDir: string = DEFAULT_HOME_DIR): string {
  const config = getAgentConfig(agentType);
  return expandPath(config.mcpConfig.settingsDir, homeDir);
}
