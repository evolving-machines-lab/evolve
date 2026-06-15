/**
 * Agent Registry
 *
 * Single source of truth for agent-specific behavior.
 * All differences between agents are data, not code.
 *
 * Evidence: sdk-rewrite-v3.md Agent Registry section
 */

import type { AgentType, SkillsConfig } from "./types";

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
  /** Skills enabled for this run */
  skills?: string[];
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
  /** Gateway-only model aliases for CLIs whose native model IDs differ from LiteLLM route names */
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
   * (e.g., Codex TOML). Maps LiteLLM header names to env var names that the CLI
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
    models: [
      { alias: "fable", modelId: "claude-fable-5", description: "Highest capability, long-horizon agentic work" },
      { alias: "opus", modelId: "claude-opus-4-8", description: "Complex reasoning, R&D, architecting" },
      { alias: "sonnet", modelId: "claude-sonnet-4-6", description: "Daily coding, features, tests" },
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
      sourceDir: "/home/user/.evolve/skills",
      targetDir: "/home/user/.claude/skills",
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
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultModel: "gpt-5.4",
    models: [
      { alias: "gpt-5.5", modelId: "gpt-5.5", description: "Newest frontier model" },
      { alias: "gpt-5.4", modelId: "gpt-5.4", description: "Flagship for professional work" },
      { alias: "gpt-5.4-mini", modelId: "gpt-5.4-mini", description: "Fast, efficient mini model" },
      { alias: "gpt-5.3-codex", modelId: "gpt-5.3-codex", description: "Industry-leading code-optimized" },
      { alias: "gpt-5.2", modelId: "gpt-5.2", description: "Previous general-purpose model" },
    ],
    systemPromptFile: "AGENTS.md",
    mcpConfig: {
      settingsDir: "~/.codex",
      filename: "config.toml",
      format: "toml",
    },
    skillsConfig: {
      sourceDir: "/home/user/.evolve/skills",
      targetDir: "/home/user/.codex/skills",
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
    defaultModel: "gemini-3.1-pro-preview",
    models: [
      { alias: "gemini-3.1-pro-preview", modelId: "gemini-3.1-pro-preview", description: "Latest pro, complex agentic + coding" },
      { alias: "gemini-3.1-flash-lite-preview", modelId: "gemini-3.1-flash-lite-preview", description: "Cost-efficient, low latency" },
      { alias: "gemini-3.5-flash", modelId: "gemini-3.5-flash", description: "Latest Flash model" },
      { alias: "gemini-3-flash-preview", modelId: "gemini-3-flash-preview", description: "Frontier flash performance" },
      { alias: "gemini-2.5-pro", modelId: "gemini-2.5-pro", description: "Complex tasks, deep reasoning" },
      { alias: "gemini-2.5-flash", modelId: "gemini-2.5-flash", description: "Balance speed/reasoning" },
      { alias: "gemini-2.5-flash-lite", modelId: "gemini-2.5-flash-lite", description: "Simple tasks, fastest" },
    ],
    systemPromptFile: "GEMINI.md",
    mcpConfig: {
      settingsDir: "~/.gemini",
      filename: "settings.json",
      format: "json",
    },
    skillsConfig: {
      sourceDir: "/home/user/.evolve/skills",
      targetDir: "/home/user/.gemini/skills",
    },
    // Source-verified: GEMINI_CLI_CUSTOM_HEADERS is read in contentGenerator.ts and parsed
    // by customHeaderUtils.ts (comma-separated via /,(?=\s*[^,:]+:)/). Not in public docs.
    customHeadersEnv: "GEMINI_CLI_CUSTOM_HEADERS",
    customHeadersFormat: "comma",
    gatewayPath: "/gemini",
    buildCommand: ({ prompt, model, isResume }) => {
      const resumeFlag = isResume ? "--resume latest " : "";
      return `gemini "${prompt}" ${resumeFlag}--model ${model} --yolo --output-format stream-json`;
    },
  },

  qwen: {
    image: "evolve-all",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultModel: "qwen3.7-max",
    models: [
      { alias: "qwen3.7-max", modelId: "qwen3.7-max", description: "Strongest reasoning and coding option" },
      { alias: "qwen3.7-plus", modelId: "qwen3.7-plus", description: "Latest balanced Qwen Cloud recommendation" },
      { alias: "qwen3.6-flash", modelId: "qwen3.6-flash", description: "Fast and cost-effective option" },
      { alias: "qwen3.6-plus", modelId: "qwen3.6-plus", description: "Compatibility model used in Qwen Code examples" },
    ],
    systemPromptFile: "QWEN.md",
    mcpConfig: {
      settingsDir: "~/.qwen",
      filename: "settings.json",
      format: "json",
    },
    skillsConfig: {
      sourceDir: "/home/user/.evolve/skills",
      targetDir: "/home/user/.qwen/skills",
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
      "qwen3.6-plus": "dashscope/qwen3.6-plus",
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
    defaultModel: "kimi-k2.6",
    models: [
      { alias: "kimi-k2.6", modelId: "moonshot/kimi-k2.6", description: "Latest: long-horizon coding, swarm orchestration" },
      { alias: "kimi-k2.6-turbo", modelId: "kimi-k2.6-turbo", description: "Evolve-managed Kimi K2.6 turbo route for latency-sensitive agent runs" },
      { alias: "kimi-k2.5", modelId: "moonshot/kimi-k2.5", description: "Previous multimodal flagship" },
    ],
    systemPromptFile: "AGENTS.md",
    mcpConfig: {
      settingsDir: "~/.kimi-code",
      filename: "mcp.json",
      format: "json",
    },
    skillsConfig: {
      sourceDir: "/home/user/.evolve/skills",
      targetDir: "/home/user/.kimi-code/skills",
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
      "kimi-k2.6": "moonshot/kimi-k2.6",
      "kimi-k2.6-turbo": "kimi-k2.6-turbo",
      "kimi-k2.5": "moonshot/kimi-k2.5",
    },
    buildCommand: ({ prompt, isResume, reasoningEffort }) => {
      const continueFlag = isResume ? "--continue " : "";
      const promptArg = shellSingleQuote(prompt);
      const legacyConfigFlag = "--config-file /home/user/.kimi-code/config.toml";
      const legacyMcpFlag = "$(if [ -f /home/user/.kimi-code/mcp.json ]; then printf ' --mcp-config-file /home/user/.kimi-code/mcp.json'; fi)";
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
    defaultModel: "openrouter/anthropic/claude-sonnet-4.6",
    // OpenRouter-only: all models route through OpenRouter (direct or via LiteLLM gateway)
    providerEnvMap: {
      openrouter: { keyEnv: "OPENROUTER_API_KEY" },
    },
    gatewayConfigEnv: "OPENCODE_CONFIG_CONTENT",
    models: [
      { alias: "openrouter/anthropic/claude-fable-5", modelId: "openrouter/anthropic/claude-fable-5", description: "Anthropic Fable via OpenRouter" },
      { alias: "openrouter/anthropic/claude-sonnet-4.6", modelId: "openrouter/anthropic/claude-sonnet-4.6", description: "Anthropic Sonnet via OpenRouter" },
      { alias: "openrouter/anthropic/claude-opus-4.8", modelId: "openrouter/anthropic/claude-opus-4.8", description: "Anthropic Opus via OpenRouter" },
      { alias: "openrouter/anthropic/claude-haiku-4.5", modelId: "openrouter/anthropic/claude-haiku-4.5", description: "Anthropic Haiku via OpenRouter" },
      { alias: "openrouter/openai/gpt-5.5", modelId: "openrouter/openai/gpt-5.5", description: "OpenAI GPT-5.5 via OpenRouter" },
      { alias: "openrouter/openai/gpt-5.4", modelId: "openrouter/openai/gpt-5.4", description: "OpenAI GPT-5.4 via OpenRouter" },
      { alias: "openrouter/openai/gpt-5.4-mini", modelId: "openrouter/openai/gpt-5.4-mini", description: "OpenAI GPT-5.4 Mini via OpenRouter" },
      { alias: "openrouter/openai/gpt-5.3-codex", modelId: "openrouter/openai/gpt-5.3-codex", description: "OpenAI Codex via OpenRouter" },
      { alias: "openrouter/openai/gpt-5.2", modelId: "openrouter/openai/gpt-5.2", description: "OpenAI GPT-5.2 via OpenRouter" },
      { alias: "openrouter/google/gemini-3.1-pro-preview", modelId: "openrouter/google/gemini-3.1-pro-preview", description: "Gemini 3.1 Pro via OpenRouter" },
      { alias: "openrouter/google/gemini-3.5-flash", modelId: "openrouter/google/gemini-3.5-flash", description: "Gemini 3.5 Flash via OpenRouter" },
      { alias: "openrouter/google/gemini-3-flash-preview", modelId: "openrouter/google/gemini-3-flash-preview", description: "Gemini 3 Flash via OpenRouter" },
      { alias: "openrouter/qwen/qwen3-coder-next", modelId: "openrouter/qwen/qwen3-coder-next", description: "Qwen Coder Next via OpenRouter" },
      { alias: "openrouter/qwen/qwen3-coder-plus", modelId: "openrouter/qwen/qwen3-coder-plus", description: "Qwen Coder via OpenRouter" },
      { alias: "openrouter/moonshotai/kimi-k2.6", modelId: "openrouter/moonshotai/kimi-k2.6", description: "Kimi K2.6 via OpenRouter" },
      { alias: "openrouter/moonshotai/kimi-k2.5", modelId: "openrouter/moonshotai/kimi-k2.5", description: "Kimi K2.5 via OpenRouter" },
      { alias: "openrouter/z-ai/glm-5", modelId: "openrouter/z-ai/glm-5", description: "Zhipu GLM-5 via OpenRouter" },
    ],
    systemPromptFile: "AGENTS.md",
    mcpConfig: {
      settingsDir: ".",
      filename: "opencode.json",
      format: "json",
    },
    skillsConfig: {
      sourceDir: "/home/user/.evolve/skills",
      targetDir: "/home/user/.agents/skills",
    },
    // OpenCode uses XDG Base Directory spec — state is split across multiple dirs
    checkpointDirs: [
      "~/.local/share/opencode",  // sessions, auth, snapshots, worktrees, logs
      "~/.config/opencode",       // config.json, AGENTS.md, theme
      "~/.local/state/opencode",  // prompt history, model prefs, TUI state
    ],
    buildCommand: ({ prompt, model, isResume, isDirectMode, reasoningEffort }) => {
      const continueFlag = isResume ? "--continue " : "";
      const routedModel = model.startsWith("openrouter/") ? model : `openrouter/${model}`;
      const reasoningFlags = getOpenCodeReasoningFlags(reasoningEffort);
      if (!isDirectMode) {
        return `OPENCODE_PERMISSION='{"*":"allow"}' opencode run ${continueFlag}--model litellm/${routedModel} --format json${reasoningFlags} "${prompt}" < /dev/null`;
      }
      return `OPENCODE_PERMISSION='{"*":"allow"}' opencode run ${continueFlag}--model ${routedModel} --format json${reasoningFlags} "${prompt}" < /dev/null`;
    },
  },

  droid: {
    image: "evolve-all",
    apiKeyEnv: "FACTORY_API_KEY",
    defaultModel: "gpt-5.5",
    models: [
      { alias: "claude-opus-4-8", modelId: "claude-opus-4-8", description: "Factory-managed Claude Opus 4.8" },
      { alias: "claude-opus-4-8-fast", modelId: "claude-opus-4-8-fast", description: "Factory-managed Claude Opus 4.8 Fast Mode" },
      { alias: "claude-sonnet-4-6", modelId: "claude-sonnet-4-6", description: "Factory-managed Claude Sonnet 4.6" },
      { alias: "claude-opus-4-6", modelId: "claude-opus-4-6", description: "Factory-managed Claude Opus 4.6" },
      { alias: "claude-opus-4-6-fast", modelId: "claude-opus-4-6-fast", description: "Factory-managed Claude Opus 4.6 Fast Mode" },
      { alias: "claude-opus-4-5", modelId: "claude-opus-4-5-20251101", description: "Factory-managed Claude Opus 4.5" },
      { alias: "claude-sonnet-4-5", modelId: "claude-sonnet-4-5-20250929", description: "Factory-managed Claude Sonnet 4.5" },
      { alias: "claude-haiku-4-5", modelId: "claude-haiku-4-5-20251001", description: "Factory-managed Claude Haiku 4.5" },
      { alias: "gpt-5.5", modelId: "gpt-5.5", description: "Factory-managed GPT-5.5" },
      { alias: "gpt-5.5-fast", modelId: "gpt-5.5-fast", description: "Factory-managed GPT-5.5 Fast Mode" },
      { alias: "gpt-5.5-pro", modelId: "gpt-5.5-pro", description: "Factory-managed GPT-5.5 Pro" },
      { alias: "gpt-5.4", modelId: "gpt-5.4", description: "Factory-managed GPT-5.4" },
      { alias: "gpt-5.4-fast", modelId: "gpt-5.4-fast", description: "Factory-managed GPT-5.4 Fast Mode" },
      { alias: "gpt-5.4-mini", modelId: "gpt-5.4-mini", description: "Factory-managed GPT-5.4 Mini" },
      { alias: "gpt-5.3-codex", modelId: "gpt-5.3-codex", description: "Factory-managed GPT-5.3-Codex" },
      { alias: "gpt-5.3-codex-fast", modelId: "gpt-5.3-codex-fast", description: "Factory-managed GPT-5.3-Codex Fast" },
      { alias: "gpt-5.2", modelId: "gpt-5.2", description: "Factory-managed GPT-5.2" },
      { alias: "gpt-5.2-codex", modelId: "gpt-5.2-codex", description: "Factory-managed GPT-5.2-Codex" },
      { alias: "gemini-3.1-pro-preview", modelId: "gemini-3.1-pro-preview", description: "Factory-managed Gemini 3.1 Pro" },
      { alias: "gemini-3-pro-preview", modelId: "gemini-3-pro-preview", description: "Factory-managed Gemini 3 Pro" },
      { alias: "gemini-3-flash-preview", modelId: "gemini-3-flash-preview", description: "Factory-managed Gemini 3 Flash" },
      { alias: "kimi-k2.6", modelId: "kimi-k2.6", description: "Factory-managed Droid Core Kimi K2.6" },
      { alias: "kimi-k2.5", modelId: "kimi-k2.5", description: "Factory-managed Droid Core Kimi K2.5" },
      { alias: "deepseek-v4-pro", modelId: "deepseek-v4-pro", description: "Factory-managed Droid Core DeepSeek V4 Pro" },
      { alias: "minimax-m2.7", modelId: "minimax-m2.7", description: "Factory-managed Droid Core MiniMax M2.7" },
      { alias: "minimax-m2.5", modelId: "minimax-m2.5", description: "Factory-managed Droid Core MiniMax M2.5" },
      { alias: "glm-5.1", modelId: "glm-5.1", description: "Factory-managed Droid Core GLM-5.1" },
    ],
    systemPromptFile: "AGENTS.md",
    mcpConfig: {
      settingsDir: "~/.factory",
      filename: "mcp.json",
      format: "json",
    },
    skillsConfig: {
      sourceDir: "/home/user/.evolve/skills",
      targetDir: "/home/user/.factory/skills",
    },
    skipApiKeyEnvInGateway: true,
    gatewayModelAliases: {
      "kimi-k2.6": "moonshot/kimi-k2.6",
      "kimi-k2.5": "moonshot/kimi-k2.5",
      "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
      "minimax-m2.7": "minimax/minimax-m2.7",
      "minimax-m2.5": "minimax/minimax-m2.5",
      "glm-5.1": "openrouter/z-ai/glm-5.1",
    },
    droidGatewaySettings: {
      settingsPath: "~/.factory/evolve-settings.json",
      displayName: "Evolve Gateway",
      // Droid's provider field selects the API protocol. Evolve's LiteLLM
      // gateway exposes a multi-provider OpenAI Chat Completions-compatible API.
      provider: "generic-chat-completion-api",
      maxOutputTokens: 32768,
    },
    checkpointDirs: [
      "~/.factory",
    ],
    buildCommand: ({ prompt, model, isResume, sessionId, reasoningEffort, isDirectMode }) => {
      const settingsFlag = isDirectMode ? "" : "--settings /home/user/.factory/evolve-settings.json ";
      const commandModel = isDirectMode ? model : "custom:Evolve-Gateway-0";
      const reasoningFlag = reasoningEffort ? ` --reasoning-effort ${reasoningEffort}` : "";
      const resumeFlag = isResume && sessionId ? `--session-id ${shellSingleQuote(sessionId)} ` : "";
      return `printf '%s' ${shellSingleQuote(prompt)} | droid ${settingsFlag}exec ${resumeFlag}--skip-permissions-unsafe --cwd /home/user/workspace --output-format stream-json --model ${shellSingleQuote(commandModel)}${reasoningFlag}`;
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
 * Expand path with ~ to /home/user
 */
export function expandPath(path: string): string {
  return path.replace(/^~/, "/home/user");
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Get MCP settings path for an agent
 */
export function getMcpSettingsPath(agentType: AgentType): string {
  const config = getAgentConfig(agentType);
  return `${expandPath(config.mcpConfig.settingsDir)}/${config.mcpConfig.filename}`;
}

/**
 * Get MCP settings directory for an agent
 */
export function getMcpSettingsDir(agentType: AgentType): string {
  const config = getAgentConfig(agentType);
  return expandPath(config.mcpConfig.settingsDir);
}
