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
  reasoningEffort?: string;
  betas?: string[];
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

  /** Environment variable name for base URL */
  baseUrlEnv: string;

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

  /** Whether this agent uses passthrough gateway (Gemini) */
  usePassthroughGateway?: boolean;
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
  /** Additional directories to include in checkpoint tar (beyond mcpConfig.settingsDir).
   *  Used for agents like OpenCode that spread state across XDG directories. */
  checkpointDirs?: string[];
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
    defaultModel: "opus",
    models: [
      { alias: "opus", modelId: "claude-opus-4-6", description: "Complex reasoning, R&D, architecting" },
      { alias: "sonnet", modelId: "claude-sonnet-4-5-20250929", description: "Daily coding, features, tests" },
      { alias: "haiku", modelId: "claude-haiku-4-5-20251001", description: "Quick tasks, syntax correction" },
    ],
    systemPromptFile: "CLAUDE.md",
    mcpConfig: {
      settingsDir: "~/.claude",
      filename: "settings.json",
      format: "json",
      projectConfig: true,
    },
    availableBetas: {
      /** 1M token context window for Sonnet 4.5 (long context pricing applies >200K tokens) */
      CONTEXT_1M: "context-1m-2025-08-07",
    },
    skillsConfig: {
      sourceDir: "/home/user/.evolve/skills",
      targetDir: "/home/user/.claude/skills",
    },
    buildCommand: ({ prompt, model, isResume, betas }) => {
      const continueFlag = isResume ? "--continue " : "";
      const betasFlag = betas?.length ? `--betas ${betas.join(",")} ` : "";
      return `echo "${prompt}" | claude -p ${continueFlag}${betasFlag}--model ${model} --output-format stream-json --verbose --dangerously-skip-permissions`;
    },
  },

  codex: {
    image: "evolve-all",
    apiKeyEnv: "OPENAI_API_KEY",
    oauthEnv: "CODEX_OAUTH_FILE_PATH",
    oauthFileName: "auth.json",
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultModel: "gpt-5.2",
    models: [
      { alias: "gpt-5.2", modelId: "gpt-5.2", description: "Base model" },
      { alias: "gpt-5.2-codex", modelId: "gpt-5.2-codex", description: "Code-optimized" },
      { alias: "gpt-5.1-codex-max", modelId: "gpt-5.1-codex-max", description: "Best reasoning (xhigh effort)" },
      { alias: "gpt-5.1-mini", modelId: "gpt-5.1-mini", description: "Smaller/faster" },
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
    defaultModel: "gemini-3-flash-preview",
    models: [
      { alias: "gemini-3.1-pro-preview", modelId: "gemini-3.1-pro-preview", description: "Latest pro preview" },
      { alias: "gemini-3-pro-preview", modelId: "gemini-3-pro-preview", description: "Pro preview" },
      { alias: "gemini-3-flash-preview", modelId: "gemini-3-flash-preview", description: "Latest flash preview" },
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
    usePassthroughGateway: true,
    buildCommand: ({ prompt, model, isResume }) => {
      const resumeFlag = isResume ? "--resume latest " : "";
      return `gemini "${prompt}" ${resumeFlag}--model ${model} --yolo --output-format stream-json`;
    },
  },

  qwen: {
    image: "evolve-all",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultModel: "qwen3.5-plus",
    models: [
      { alias: "qwen3.5-plus", modelId: "qwen3.5-plus", description: "Latest flagship, code + reasoning" },
      { alias: "qwen3-coder-plus", modelId: "qwen3-coder-plus", description: "Code generation, debugging" },
      { alias: "qwen3-vl-plus", modelId: "qwen3-vl-plus", description: "Vision + language, multimodal" },
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
      enableFlag: "--experimental-skills",
    },
    defaultBaseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    buildCommand: ({ prompt, model, isResume, isDirectMode, skills }) => {
      const continueFlag = isResume ? "--continue " : "";
      const skillsFlag = skills?.length ? "--experimental-skills " : "";
      // Only add dashscope/ prefix for gateway mode (LiteLLM routing)
      const prefixedModel = isDirectMode || model.startsWith("dashscope/")
        ? model
        : `dashscope/${model}`;
      // --auth-type openai is required in non-interactive mode when env vars don't include OPENAI_MODEL
      return `qwen "${prompt}" ${continueFlag}${skillsFlag}--auth-type openai --model ${prefixedModel} --yolo --output-format stream-json`;
    },
  },

  kimi: {
    image: "evolve-all",
    apiKeyEnv: "KIMI_API_KEY",
    baseUrlEnv: "KIMI_BASE_URL",
    defaultModel: "moonshot/kimi-k2.5",
    models: [
      { alias: "moonshot/kimi-k2.5", modelId: "moonshot/kimi-k2.5", description: "Latest multimodal, Agent Swarm capable" },
      { alias: "moonshot/kimi-k2-turbo-preview", modelId: "moonshot/kimi-k2-turbo-preview", description: "Fast turbo model" },
    ],
    systemPromptFile: "AGENTS.md",
    mcpConfig: {
      settingsDir: "~/.kimi",
      filename: "mcp.json",
      format: "json",
    },
    skillsConfig: {
      sourceDir: "/home/user/.evolve/skills",
      targetDir: "/home/user/.kimi/skills",
    },
    defaultBaseUrl: "https://api.moonshot.ai/v1",
    buildCommand: ({ prompt, model, isResume }) => {
      const continueFlag = isResume ? "--continue " : "";
      return `printf '%s' "${prompt}" | KIMI_MODEL_NAME=${model} kimi --print --output-format stream-json --yolo ${continueFlag}`;
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
      { alias: "openrouter/anthropic/claude-sonnet-4.6", modelId: "openrouter/anthropic/claude-sonnet-4.6", description: "Anthropic Sonnet via OpenRouter" },
      { alias: "openrouter/anthropic/claude-opus-4.6", modelId: "openrouter/anthropic/claude-opus-4.6", description: "Anthropic Opus via OpenRouter" },
      { alias: "openrouter/anthropic/claude-haiku-4.5", modelId: "openrouter/anthropic/claude-haiku-4.5", description: "Anthropic Haiku via OpenRouter" },
      { alias: "openrouter/openai/gpt-5.2", modelId: "openrouter/openai/gpt-5.2", description: "OpenAI GPT-5.2 via OpenRouter" },
      { alias: "openrouter/openai/gpt-5.2-codex", modelId: "openrouter/openai/gpt-5.2-codex", description: "OpenAI Codex via OpenRouter" },
      { alias: "openrouter/openai/gpt-5.1-codex-max", modelId: "openrouter/openai/gpt-5.1-codex-max", description: "OpenAI Codex Max via OpenRouter" },
      { alias: "openrouter/google/gemini-3.1-pro-preview", modelId: "openrouter/google/gemini-3.1-pro-preview", description: "Gemini 3.1 Pro via OpenRouter" },
      { alias: "openrouter/google/gemini-3-pro-preview", modelId: "openrouter/google/gemini-3-pro-preview", description: "Gemini 3 Pro via OpenRouter" },
      { alias: "openrouter/google/gemini-3-flash-preview", modelId: "openrouter/google/gemini-3-flash-preview", description: "Gemini 3 Flash via OpenRouter" },
      { alias: "openrouter/qwen/qwen3-coder-plus", modelId: "openrouter/qwen/qwen3-coder-plus", description: "Qwen Coder via OpenRouter" },
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
    buildCommand: ({ prompt, model, isResume, isDirectMode }) => {
      const continueFlag = isResume ? "--continue " : "";
      const routedModel = model.startsWith("openrouter/") ? model : `openrouter/${model}`;
      if (!isDirectMode) {
        return `OPENCODE_PERMISSION='{"*":"allow"}' opencode run ${continueFlag}--model litellm/${routedModel} --format json "${prompt}" < /dev/null`;
      }
      return `OPENCODE_PERMISSION='{"*":"allow"}' opencode run ${continueFlag}--model ${routedModel} --format json "${prompt}" < /dev/null`;
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
