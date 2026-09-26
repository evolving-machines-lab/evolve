/**
 * Agent Registry
 *
 * Single source of truth for agent-specific behavior.
 * All differences between agents are data, not code.
 */

import type { AgentPreset, AgentType, ReasoningEffort, SkillsConfig } from "./types";
import { shellSingleQuote } from "./utils/shell";
import { DEFAULT_HOME_DIR } from "./constants";

// =============================================================================
// REASONING-EFFORT VOCABULARY
// =============================================================================

/**
 * What a CLI does with a reasoning-effort input:
 *   'level'   the value reaches the CLI as a graded level
 *   'binary'  thinking on/off only — only BINARY_EFFORT_VALUES are honest inputs
 *   'none'    the CLI takes no effort input at all
 */
export type EffortSupport = "level" | "binary" | "none";

/**
 * The effort vocabulary a graded ('level') harness accepts, in ascending order
 * of thinking. This is the ADVERTISED list: the ReasoningEffort union in
 * types.ts additionally accepts the legacy spelling "no-thinking" (same
 * behaviour as "off"), which is deliberately not advertised anywhere.
 */
export const REASONING_EFFORTS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "thinking",
] as const satisfies readonly ReasoningEffort[];

/**
 * The subset a 'binary' harness can honestly represent. Four SPELLINGS, two
 * BEHAVIOURS: 'off' and 'minimal' disable thinking, 'medium' and 'thinking'
 * enable it (isThinkingEnabled draws the same line). The graded levels are
 * excluded because a binary CLI cannot express a gradation — accepting 'high'
 * would record a claim the CLI never received.
 */
/**
 * The context window every `pinned-context` arm is pinned to, in tokens. One
 * platform number on purpose: the preset exists so arms are COMPARABLE, and
 * two harnesses pinned to two sizes would not be. 200000 tokens = the
 * standard Claude window, inside Claude's documented `autoCompactWindow`
 * range (100000..1000000) and below every supported model's real ceiling, so
 * the pin always binds by early compaction instead of overpromising tokens a
 * model cannot hold.
 */
export const PINNED_CONTEXT_WINDOW_TOKENS = 200000;

export const BINARY_EFFORT_VALUES = [
  "off",
  "minimal",
  "medium",
  "thinking",
] as const satisfies readonly ReasoningEffort[];

/**
 * The effort a run takes when it names none, for harnesses that take one at
 * all. Owned HERE because managed evals and managed agents must advertise the
 * same defaults: the hosted-evals lane resolves an omitted effort to this value
 * at job creation and publishes it on GET /api/meta via the generated
 * harness-capabilities.json artifact.
 */
export const DEFAULT_REASONING_EFFORT: ReasoningEffort = "medium";

/**
 * The effort vocabulary one harness accepts and the value an unnamed effort
 * takes there — pure data derivation from its effortSupport. The
 * harness-capabilities artifact generator and picker UIs share this.
 */
export function harnessEffortVocabulary(
  support: EffortSupport,
  efforts?: readonly ReasoningEffort[],
): {
  efforts: readonly ReasoningEffort[];
  defaultEffort: ReasoningEffort | null;
} {
  if (support === "none") return { efforts: [], defaultEffort: null };
  return {
    efforts: efforts ?? (support === "binary" ? BINARY_EFFORT_VALUES : REASONING_EFFORTS),
    defaultEffort: DEFAULT_REASONING_EFFORT,
  };
}

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
  format: "json" | "toml" | "yaml";
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
  /**
   * Sandbox path of the user-supplied native config document, for harnesses
   * whose nativeConfig.delivery is 'settings-flag' (Claude's `--settings`).
   * 'base-file' harnesses read their config path natively and ignore this.
   */
  nativeConfigPath?: string;
  /**
   * The active preset's extra command flags (registry presets[..].commandFlags),
   * already leading-space formatted. Only harnesses whose preset delivery
   * rides the command line (Codex `-c`) receive a non-empty value; they must
   * splice it into their command so it ranks ABOVE the config file, which is
   * what makes the preset a guarantee rather than a default.
   */
  presetFlags?: string;
  isDirectMode?: boolean;
  /**
   * External gateway mode (caller-minted credential + base URL). Direct-mode
   * env injection applies, but CLIs that route via generated config (OpenCode
   * inline config, Droid settings file) must use their GATEWAY command shape
   * pointed at the caller's gateway — with the model passed VERBATIM (route
   * names belong to the caller's gateway, never to Evolve's alias maps).
   */
  isExternalGateway?: boolean;
  /** Whether the run configured MCP servers (pi loads its adapter extension only then). */
  mcpConfigured?: boolean;
  /** Skills enabled for this run */
  skills?: string[];
  /** Sandbox home directory (default: "/home/user") */
  homeDir?: string;
}

export interface AgentRegistryEntry {
  /** Sandbox image/template identifier (provider maps to its own concept) */
  image: string;

  /**
   * What this CLI does with a reasoning-effort input (see EffortSupport).
   * Advertised DATA beside the buildCommand BEHAVIOUR: the generated
   * harness-capabilities.json artifact reads this so the hosted-evals lane
   * advertises exactly the vocabulary the local SDK drives.
   */
  effortSupport: EffortSupport;

  /** The subset of the level vocabulary this CLI can honor; absent = the whole vocabulary for its effortSupport. */
  efforts?: readonly ReasoningEffort[];

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

  /**
   * Native agent-settings knowledge — the `--ak config=...` channel (Harbor's
   * SUPPORTS_CONFIG, agents/installed/base.py:517-559). Present only for
   * harnesses whose native settings document the SDK knows how to deliver;
   * absent = the harness does not support a user config and naming one is a
   * typed refusal, never a silent drop (Harbor base.py:528-531).
   *
   * Precedence law (Harbor's codex.py:1022-1062): the user document is the
   * BASE; platform inputs — gateway routing, MCP servers, model/effort flags —
   * are stamped ON TOP of it, never underneath.
   */
  nativeConfig?: {
    /** Document format the harness reads: JSON (Claude settings) or TOML (Codex config). */
    format: "json" | "toml";
    /** Sandbox path the user base document is written to. */
    path: string;
    /**
     * How the harness is pointed at the document: 'settings-flag' passes it
     * per-run (Claude `--settings`, mirroring Harbor claude_code.py:1531-1532);
     * 'base-file' relies on the harness reading `path` natively (Codex
     * `$CODEX_HOME/config.toml`, Harbor codex.py:1178-1181).
     */
    delivery: "settings-flag" | "base-file";
  };

  /**
   * The named presets this harness can GUARANTEE, with their delivery. A
   * preset is a platform-authored settings bundle: `configStamp` keys are
   * deep-merged ON TOP of the user's native config document (arrays union,
   * scalars overwrite — a user config can never undo a preset), and
   * `commandFlags` ride the command line, which the harness ranks above its
   * config file. Absent preset name = the combination cannot be guaranteed
   * and is a typed refusal at the door, never a partial application.
   *
   *   no-internet    — vendor server-side web tools off. Claude: settings
   *                    `permissions.deny` for WebSearch/WebFetch (deny rules
   *                    outrank every allow, from any settings source). Codex:
   *                    `-c web_search=disabled` — the exact flag Harbor's
   *                    codex agent exposes (codex.py:70-76; enum
   *                    disabled/cached/live, and note codex's DEFAULT is
   *                    "cached", an OpenAI-maintained web index, so only the
   *                    explicit `disabled` removes the tool).
   *   pinned-context — one fixed effective context window
   *                    (PINNED_CONTEXT_WINDOW_TOKENS) so vendor-side window
   *                    tuning never confounds an arm comparison. Claude:
   *                    `autoCompactWindow` (+ `autoCompactEnabled`, so a user
   *                    config cannot turn the boundary off) — unset, "Claude
   *                    Code uses a window tuned for your model" (settings
   *                    docs). Codex: `-c model_context_window`.
   */
  presets?: Partial<
    Record<
      AgentPreset,
      {
        /** Settings keys stamped ON TOP of the user's native config document. */
        configStamp?: Record<string, unknown>;
        /** Extra command flags, leading-space formatted, ranked above the config file. */
        commandFlags?: string;
      }
    >
  >;

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
  /**
   * The pi family's only route: a models.json provider entry written per run
   * with the LITERAL base URL (pi never expands $VAR there), selected by --provider.
   */
  modelsJsonRoute?: {
    /** The agent dir (~ expanded) that holds models.json. */
    agentDir: string;
    /** The provider name the command's --provider selects. */
    providerName: string;
    /** How the file names the key env: pi wants "$VAR" (docs/models.md), Prime Agent the bare "VAR". */
    apiKeyRef: "dollar" | "bare";
  };
  /** Vendor defaults wrong for a metered run, deep-merged into the settings file at setup. */
  settingsStamp?: { path: string; document: Record<string, unknown> };
  /**
   * Z Code's per-run provider file: the CLI's only source of model, level, base
   * URL and key (no `--model` flag, no credential env; ZCode cli/src at v3.14.3).
   */
  zcodeProviderConfig?: {
    path: string;
    providerId: string;
    providerName: string;
    /** The window Z Code compacts at — the platform's one number, below every roster route's real ceiling. */
    contextWindow: number;
    /** Cap on `max_tokens` per request. */
    maxOutputTokens: number;
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
  /** The CLI exits 0 whatever happened: at exit 0 the last assistant message_end is the verdict (agent.ts). */
  verdictFromStream?: true;
  /** Where the SDK keeps the stream-captured session id for CLIs that resume by `--session-id` (droid, dsh). */
  sessionIdStateFile?: string;
  /** dsh only: the Evolve-owned `--patch` that routes the CLI (mcp/yaml.ts); it names env variables, never values. */
  dshRoutePatch?: {
    path: string;
    /** The pi-ai provider route name the patch declares and the default model selects. */
    providerName: string;
    contextWindow: number;
    /** The request's `max_tokens`. */
    maxTokens: number;
  };
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

/** The pi-ai levels dsh's patch declares and the SDK accepts — the three proven on the wire (owner ruling 2026-09-25). */
export const DSH_REASONING_EFFORTS = ["low", "medium", "high"] as const satisfies readonly ReasoningEffort[];

/** Typed refusal outside the roster: dsh sends the effort on every request, so an unlisted value would be recorded but never applied. */
export function getDshReasoningEffort(reasoningEffort?: string): string | undefined {
  if (!reasoningEffort) return undefined;
  if ((DSH_REASONING_EFFORTS as readonly string[]).includes(reasoningEffort)) return reasoningEffort;
  throw new Error(
    `Evolve agent config: agent "dsh" honors reasoning effort ${DSH_REASONING_EFFORTS.map((e) => `"${e}"`).join(", ")} only; ` +
      `"${reasoningEffort}" is not one of them and would be recorded but never applied.`,
  );
}

// =============================================================================
// THE PI FAMILY (pi, Prime Agent): one models.json route, one thinking scale
// =============================================================================

/** The models.json provider name both CLIs' commands select (`--provider evolve`). */
export const PI_FAMILY_PROVIDER = "evolve";

/** Where pi-mcp-adapter's entry point is; a fleet default (the image's path below), never a user option. */
export const PI_MCP_ADAPTER_EXTENSION_ENV = "PI_MCP_ADAPTER_EXTENSION";

/** Where the evolve-all image installs pi-mcp-adapter (assets/docker/Dockerfile). */
export const PI_MCP_ADAPTER_EXTENSION = "/opt/evolve/pi-mcp-adapter/node_modules/pi-mcp-adapter/index.ts";

/** --thinking takes the SDK's graded words as they are; the binary spellings map onto the vendors' scale. */
export function piThinkingLevel(reasoningEffort?: string): string | undefined {
  if (!reasoningEffort) return undefined;
  if (reasoningEffort === "none" || reasoningEffort === "no-thinking") return "off";
  if (reasoningEffort === "thinking") return "medium";
  return reasoningEffort;
}

/**
 * The wire model: the roster's `openrouter/<vendor>/<model>` rides verbatim to
 * either gateway; OpenRouter itself (direct mode) wants the id without the prefix.
 */
export function piFamilyWireModel(
  model: string,
  mode: { isDirectMode?: boolean; isExternalGateway?: boolean },
): string {
  if (mode.isDirectMode && !mode.isExternalGateway && model.startsWith("openrouter/")) {
    return model.slice("openrouter/".length);
  }
  return model;
}

/**
 * The OpenRouter roster the OpenRouter-only harnesses share (opencode, pi,
 * Prime Agent); alias == wire id, the gateway's `openrouter/*` wildcard serves each.
 */
const OPENROUTER_ROSTER: readonly ModelInfo[] = [
  // OpenRouter spells Fable 5.1 with a dot (openrouter.ai/api/v1/models, read 2026-09-15).
  { alias: "openrouter/anthropic/claude-fable-5.1", modelId: "openrouter/anthropic/claude-fable-5.1", description: "Anthropic Fable 5.1 via OpenRouter" },
  { alias: "openrouter/anthropic/claude-opus-5", modelId: "openrouter/anthropic/claude-opus-5", description: "Anthropic Opus 5 via OpenRouter" },
  { alias: "openrouter/anthropic/claude-sonnet-5", modelId: "openrouter/anthropic/claude-sonnet-5", description: "Anthropic Sonnet 5 via OpenRouter" },
  { alias: "openrouter/anthropic/claude-haiku-4.5", modelId: "openrouter/anthropic/claude-haiku-4.5", description: "Anthropic Haiku via OpenRouter" },
  // GPT-6 Astra under OpenRouter's id (read 2026-09-15, listed at OpenAI's own rate).
  { alias: "openrouter/openai/gpt-6-astra", modelId: "openrouter/openai/gpt-6-astra", description: "OpenAI GPT-6 Astra via OpenRouter" },
  { alias: "openrouter/openai/gpt-5.6-sol", modelId: "openrouter/openai/gpt-5.6-sol", description: "OpenAI GPT-5.6 Sol via OpenRouter" },
  { alias: "openrouter/openai/gpt-5.6-terra", modelId: "openrouter/openai/gpt-5.6-terra", description: "OpenAI GPT-5.6 Terra via OpenRouter" },
  { alias: "openrouter/openai/gpt-5.6-luna", modelId: "openrouter/openai/gpt-5.6-luna", description: "OpenAI GPT-5.6 Luna via OpenRouter" },
  { alias: "openrouter/google/gemini-3.6-flash", modelId: "openrouter/google/gemini-3.6-flash", description: "Gemini 3.6 Flash via OpenRouter" },
  { alias: "openrouter/qwen/qwen3.7-max", modelId: "openrouter/qwen/qwen3.7-max", description: "Qwen 3.7 Max via OpenRouter" },
  { alias: "openrouter/moonshotai/kimi-k3", modelId: "openrouter/moonshotai/kimi-k3", description: "Kimi K3 via OpenRouter" },
  { alias: "openrouter/z-ai/glm-5.3", modelId: "openrouter/z-ai/glm-5.3", description: "Zhipu GLM-5.3 via OpenRouter" },
  // Through the Evolve gateway this id reaches the platform's one GLM-5.3-Flash, served from Fireworks (ruling 2026-09-08).
  { alias: "openrouter/z-ai/glm-5.3-flash", modelId: "openrouter/z-ai/glm-5.3-flash", description: "Zhipu GLM-5.3 Flash (OpenRouter id; the Evolve gateway serves it from Fireworks)" },
  // The analyzer's default (owner 2026-09-10), priced from OpenRouter's own bill.
  { alias: "openrouter/deepseek/deepseek-v4.1-flash", modelId: "openrouter/deepseek/deepseek-v4.1-flash", description: "DeepSeek V4.1 Flash via OpenRouter" },
];

/** The levels the provider file declares for the Evolve model entry; `disabled` sends no reasoning field. */
export const ZCODE_REASONING_LEVELS = ["disabled", "low", "medium", "high"] as const;
export type ZcodeReasoningLevel = (typeof ZCODE_REASONING_LEVELS)[number];

/** The platform effort collapsed onto Z Code's four levels (the opencode precedent); an omitted effort is the roster pin. */
export function zcodeReasoningLevel(reasoningEffort?: string): ZcodeReasoningLevel {
  const effort = reasoningEffort ?? AGENT_REGISTRY.zcode.defaultReasoningEffort;
  if (!isThinkingEnabled(effort)) return "disabled";
  if (effort === "low") return "low";
  if (effort === "medium" || effort === "thinking") return "medium";
  return "high";
}

/**
 * The ZCODE_* variables a task's `.env` could move or re-route (the CLI auto-loads one from the
 * cwd upward, override:false): a value on the command wins, an empty one leaves the setting unset.
 * The built-in catalog path is pinned by the image and the bundle instead (empty aborts the CLI).
 */
export function zcodeEnvPins(homeDir: string): Record<string, string> {
  return {
    ZCODE_STORAGE_DIR: `${homeDir}/.zcode`,
    ZCODE_DATA_BASE_DIR: homeDir,
    ZCODE_SESSION_DB_PATH: `${homeDir}/.zcode/cli/db/db.sqlite`,
    // The CLI's alias of SESSION_DB_PATH; unpinned, a later-enumerated .env key would win.
    ZCODE_SESSION_DB: `${homeDir}/.zcode/cli/db/db.sqlite`,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: `${homeDir}/.zcode/v2/provider_config.json`,
    ZCODE_HTTP_PROXY: "",
    ZCODE_NO_PROXY: "",
    ZCODE_AGENT_CA_CERT: "",
    ZCODE_MODEL_TELEMETRY_ENABLED: "0",
  };
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
    effortSupport: "level",
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
      // The alias rides to Claude Code verbatim (resolveCommandModel applies
      // only gatewayModelAliases, never this modelId), so Claude Code's own
      // version resolves it. This modelId records that resolution — the wire
      // name the platform's per-arm gateway key must admit (swarm_dashboard
      // resolveGatewayModelScope reads it from harness-capabilities.json).
      // Vendor doc (code.claude.com/docs/en/model-config, read 2026-09-15):
      // "Unless you set ANTHROPIC_DEFAULT_FABLE_MODEL, the `fable` alias
      // resolves to Fable 5.1, except in Claude apps gateway sessions, where
      // `fable` and `best` resolve to Fable 5", and "Fable 5.1 requires
      // Claude Code v2.1.257 or later" — an older Claude Code still answers
      // the alias with claude-fable-5 (the evolve-all image carried 2.1.233
      // on 2026-09-15 and served claude-fable-5 for `fable`; the measurement
      // is in team/dev-items/fable-astra-lane-report-2026-09-15.md).
      { alias: "fable", modelId: "claude-fable-5-1", description: "Highest capability, long-horizon agentic work" },
      { alias: "opus", modelId: "claude-opus-5", description: "Complex reasoning, R&D, architecting" },
      { alias: "sonnet", modelId: "claude-sonnet-5", description: "Daily coding, features, tests" },
      { alias: "haiku", modelId: "claude-haiku-4-5-20251001", description: "Quick tasks, syntax correction" },
      { alias: "opus[1m]", modelId: "opus[1m]", description: "Complex reasoning with 1M context window" },
      { alias: "sonnet[1m]", modelId: "sonnet[1m]", description: "Daily coding with 1M context window" },
      { alias: "glm-5.3", modelId: "glm-5.3", description: "Zhipu GLM-5.3 via the Evolve gateway" },
      { alias: "glm-5.3-flash", modelId: "glm-5.3-flash", description: "Zhipu GLM-5.3 Flash via the Evolve gateway" },
      // DeepSeek V4.1 Flash (released 2026-09-10: native image input, 1M
      // context), served through OpenRouter behind the gateway's exact entry
      // for this id (the entry carries the flag that forwards the effort;
      // the call is priced from OpenRouter's own bill — the owner's ruling
      // 2026-09-10: one name per route, this OpenRouter spelling on the
      // claude, droid and opencode rosters). Alias == wire id, like the GLM
      // rows above, so either spelling reaches the same gateway entry.
      // Default effort `high` (DeepSeek's documented default). THE trace
      // analyzer's and check agent's default model (swarm_dashboard
      // lib/evaluations/analysis.ts DEFAULT_ANALYZE_MODEL).
      { alias: "openrouter/deepseek/deepseek-v4.1-flash", modelId: "openrouter/deepseek/deepseek-v4.1-flash", description: "DeepSeek V4.1 Flash via OpenRouter" },
      // The same model on a second route, Fireworks, behind the gateway's
      // exact entry for this name (owner 2026-09-11: "a further option" —
      // the Fireworks route is back under a name that shows its route, the
      // way the OpenRouter id shows its own; the retired bare names
      // `deepseek-flash` and `deepseek-v4-flash-vision` stay gone). The same
      // three rosters, the same default effort; never the analyzer's default.
      { alias: "fireworks/deepseek-v4.1-flash", modelId: "fireworks/deepseek-v4.1-flash", description: "DeepSeek V4.1 Flash via Fireworks" },
    ],
    systemPromptFile: "CLAUDE.md",
    mcpConfig: {
      settingsDir: "~/.claude",
      filename: "settings.json",
      format: "json",
      projectConfig: true,
    },
    // A dedicated file (never ~/.claude/settings.json, which the platform's
    // MCP writer owns) passed per run via --settings — the same per-run
    // settings layer Harbor uses (claude_code.py:37-38, 1531-1532). Model and
    // effort still ride CLI flags, which Claude ranks above any settings file,
    // so platform stamps stay on top of the user document.
    nativeConfig: {
      format: "json",
      path: "~/.claude/evolve-user-settings.json",
      delivery: "settings-flag",
    },
    // Preset delivery rides the SAME settings document: the stamp is merged
    // on top of the user's config (or becomes the whole document when there
    // is none) and delivered via --settings. Deny rules outrank every allow
    // from any settings source, so the no-internet deny is a guarantee, not
    // a default; the pinned window carries autoCompactEnabled too, so a user
    // config cannot switch the boundary off.
    presets: {
      "no-internet": {
        configStamp: { permissions: { deny: ["WebSearch", "WebFetch"] } },
      },
      "pinned-context": {
        configStamp: {
          autoCompactEnabled: true,
          autoCompactWindow: PINNED_CONTEXT_WINDOW_TOKENS,
        },
      },
    },
    skillsConfig: {
      targetDir: "~/.claude/skills",
    },
    buildCommand: ({ prompt, model, isResume, reasoningEffort, nativeConfigPath }) => {
      const continueFlag = isResume ? "--continue " : "";
      const effortFlag = reasoningEffort ? ` --effort ${reasoningEffort}` : "";
      const settingsFlag = nativeConfigPath ? ` --settings ${nativeConfigPath}` : "";
      return `echo "${prompt}" | claude -p ${continueFlag}--model ${model}${effortFlag}${settingsFlag} --output-format stream-json --verbose --dangerously-skip-permissions`;
    },
  },

  codex: {
    image: "evolve-all",
    apiKeyEnv: "OPENAI_API_KEY",
    oauthEnv: "CODEX_OAUTH_FILE_PATH",
    effortSupport: "level",
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
    // Owner policy: graded-effort harnesses pin "high" (kimi alone pins max).
    // Stamped explicitly via -c model_reasoning_effort on every run, so a
    // vendor-side default change cannot move results.
    defaultReasoningEffort: "high",
    models: [
      // GPT-6 Astra (released 2026-09-03). Vendor doc, read 2026-09-15
      // (platform.openai.com/docs/models/gpt-6-astra): "Model ID: gpt-6-astra
      // ... our most capable model, built for the hardest end-to-end work";
      // reasoning.effort low/medium/high/xhigh/max; 1,050,000 context. Codex
      // CLI: configurable from 0.153.1 (2026-09-03, "Added support for
      // configuring GPT-6-Astra through the API without changing the default
      // model or showing it in the model picker"), Codex's own bundled default
      // from 0.153.4 (2026-09-04), in its model picker from 0.154.0 —
      // learn.chatgpt.com/docs/changelog (developers.openai.com/codex/changelog
      // redirects there), read 2026-09-15. The Evolve default stays gpt-5.6-sol
      // (owner's word 2026-09-15).
      { alias: "gpt-6-astra", modelId: "gpt-6-astra", description: "Newest frontier flagship" },
      { alias: "gpt-5.6-sol", modelId: "gpt-5.6-sol", description: "GPT-5.6 flagship (previous generation)" },
      { alias: "gpt-5.6-terra", modelId: "gpt-5.6-terra", description: "Balances intelligence and cost" },
      { alias: "gpt-5.6-luna", modelId: "gpt-5.6-luna", description: "High-volume, cost-sensitive tier" },
      { alias: "gpt-5.5", modelId: "gpt-5.5", description: "GPT-5.5 frontier model (two generations back)" },
      { alias: "gpt-5.3-codex", modelId: "gpt-5.3-codex", description: "Industry-leading code-optimized" },
    ],
    systemPromptFile: "AGENTS.md",
    mcpConfig: {
      settingsDir: "~/.codex",
      filename: "config.toml",
      format: "toml",
    },
    // The user document IS the base ~/.codex/config.toml, written before the
    // platform's writers (MCP merge, gateway provider block) parse-and-rewrite
    // it — so platform routing lands ON TOP of the user's keys, exactly
    // Harbor's merge order (codex.py:1022-1062, 1178-1181). Effort and model
    // still ride -c/--model flags, which Codex ranks above config.toml.
    nativeConfig: {
      format: "toml",
      path: "~/.codex/config.toml",
      delivery: "base-file",
    },
    // Preset delivery rides -c command flags, which codex ranks above the
    // config.toml the user document becomes — so even a user config declaring
    // web_search="live" runs sealed. web_search takes Harbor's exact enum
    // (their codex.py:70-76: disabled/cached/live); codex's DEFAULT is
    // "cached" (an OpenAI-maintained web index), which is why no-internet
    // must stamp the explicit `disabled` rather than merely omit the flag.
    presets: {
      "no-internet": { commandFlags: " -c web_search=disabled" },
      "pinned-context": {
        commandFlags: ` -c model_context_window=${PINNED_CONTEXT_WINDOW_TOKENS}`,
      },
    },
    skillsConfig: {
      targetDir: "~/.codex/skills",
    },
    spendTrackingEnvs: {
      sessionTagEnv: "EVOLVE_LITELLM_CUSTOMER_ID",
      runTagEnv: "EVOLVE_LITELLM_TAGS",
    },
    setupCommand: `printf '%s\\n' "$OPENAI_API_KEY" | codex login --with-api-key`,
    buildCommand: ({ prompt, model, isResume, reasoningEffort, presetFlags }) => {
      const effortFlag = reasoningEffort ? ` -c model_reasoning_effort="${reasoningEffort}"` : "";
      const resumeFlag = isResume ? " resume --last" : "";
      // Preset -c flags sit beside the effort's: the command line is what
      // codex ranks above config.toml, making the preset a guarantee.
      return `printf '%s' "${prompt}" | codex exec --model ${model}${effortFlag}${presetFlags ?? ""} --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --json${resumeFlag}`;
    },
  },

  gemini: {
    image: "evolve-all",
    apiKeyEnv: "GEMINI_API_KEY",
    effortSupport: "none",
    oauthEnv: "GEMINI_OAUTH_FILE_PATH",
    oauthFileName: "oauth_creds.json",
    oauthActivationEnv: { key: "GOOGLE_GENAI_USE_GCA", value: "true" },
    baseUrlEnv: "GOOGLE_GEMINI_BASE_URL",
    // Roster policy (owner, 2026-08-15): only the latest flash, latest
    // flash-lite, and latest pro — never the whole version sequence.
    // "Latest" means the latest the STABLE gemini CLI actually serves, not
    // the latest model Google has launched.
    //
    // WHY A NEWER FLASH CANNOT SIMPLY BE ADDED. The CLI rewrites the model
    // CLIENT-SIDE before any request leaves the box. Source-verified in the
    // published @google/gemini-cli 0.55.1 bundle: resolveModel() ends with
    // `if (useGemini3_5Flash && isFlashModel(resolved) && normalizedModel !==
    // PREVIEW_GEMINI_FLASH_MODEL) return DEFAULT_GEMINI_FLASH_MODEL`, and
    // isFlashModel() matches by `model.endsWith("flash")`. So EVERY name
    // ending in "flash" collapses onto the CLI's own current flash model —
    // gemini-3.5-flash on our path, because hasGemini35FlashGAAccess() calls
    // setFlashModels() under API-key auth. A name that does not end in
    // "flash" skips the branch untouched, which is exactly why
    // gemini-3.5-flash-lite and gemini-3.1-pro-preview serve under their own
    // names while gemini-3.6-flash and gemini-3.7-flash do not.
    //
    // Two explanations recorded here before were WRONG (probe 2026-08-16).
    // It is NOT that the CLI predates the model: gemini-3.6-flash launched
    // 2026-07-21, three weeks BEFORE 0.55.1 shipped on 08-11, and is still
    // swapped. It is NOT that the CLI only serves names it knows: the 0.55.1
    // bundle never mentions gemini-3.5-flash-lite either, yet serves it
    // correctly. And nothing upstream rejects the model — from inside one
    // sandbox, on the same door with the same bound runtime token, a raw call
    // for gemini-3.6-flash returned HTTP 200 with "modelVersion":
    // "gemini-3.6-flash" while the CLI in that very sandbox (run a6802b8f)
    // reported every token served by gemini-3.5-flash. The gateway carries
    // correct priced entries for 3.6 and 3.7; the CLI is the only layer
    // refusing to ask.
    //
    // Consequence: a new gemini "-flash" model becomes selectable only once
    // the CLI's own default flash advances to it — a newer CLI release alone
    // is not enough, so verify with a live probe before adding one.
    // gemini-3.5-flash is therefore the default, and the hosted wrong-model
    // integrity guard is what stops a silent swap from ever being scored.
    // gemini-3.5-flash-lite remains live-proven end to end under its own name
    // (trial e303b985: SCORED, metered, ATIF agent block records the served
    // model).
    defaultModel: "gemini-3.5-flash",
    models: [
      { alias: "gemini-3.5-flash", modelId: "gemini-3.5-flash", description: "Latest flash the stable gemini CLI serves: coding + agentic planning" },
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
    effortSupport: "binary",
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
    effortSupport: "level",
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
    effortSupport: "level",
    baseUrlEnv: "OPENAI_BASE_URL",
    defaultModel: "openrouter/anthropic/claude-opus-5",
    // OpenCode runs thinking at the "medium" variant when effort is omitted
    // (see getOpenCodeReasoningVariant); pinned so that choice is registry
    // data, stamped via --variant/--thinking and the litellm variants config.
    defaultReasoningEffort: "high",
    // OpenRouter-only: all models route through OpenRouter (direct or via the Evolve gateway)
    providerEnvMap: {
      openrouter: { keyEnv: "OPENROUTER_API_KEY" },
    },
    gatewayConfigEnv: "OPENCODE_CONFIG_CONTENT",
    models: [
      ...OPENROUTER_ROSTER,
      // The same model on its second route, Fireworks (owner 2026-09-11: a
      // further option). Gateway-only: a roster id rides the command line
      // verbatim (opencodeRoutedModel below), so buildCommand sends
      // `litellm/fireworks/...` onto the gateway's exact entry for it; there
      // is no direct-mode home for it — OpenRouter has no such id and this
      // harness holds no Fireworks key (providerEnvMap above), so direct mode
      // refuses the name typed at config resolution (utils/config.ts).
      { alias: "fireworks/deepseek-v4.1-flash", modelId: "fireworks/deepseek-v4.1-flash", description: "DeepSeek V4.1 Flash via Fireworks" },
    ],
    systemPromptFile: "AGENTS.md",
    mcpConfig: {
      settingsDir: ".",
      filename: "opencode.json",
      format: "json",
    },
    skillsConfig: {
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
      // A roster id or an OpenRouter-form name rides verbatim; only a bare
      // name gets OpenRouter's prefix (opencodeRoutedModel, below the table).
      const routedModel = opencodeRoutedModel(model);
      if (!isDirectMode) {
        return `OPENCODE_PERMISSION='{"*":"allow"}' opencode run ${continueFlag}--model litellm/${routedModel} --format json${reasoningFlags} "${prompt}" < /dev/null`;
      }
      return `OPENCODE_PERMISSION='{"*":"allow"}' opencode run ${continueFlag}--model ${routedModel} --format json${reasoningFlags} "${prompt}" < /dev/null`;
    },
  },

  droid: {
    image: "evolve-all",
    apiKeyEnv: "FACTORY_API_KEY",
    effortSupport: "level",
    defaultModel: "claude-opus-5",
    // Droid 0.182.0 documents per-model defaults (Opus 5, Fable 5 and Kimi K3
    // default to high). Evolve pins "high" — the default model's own
    // ceiling-of-record — and stamps it via --reasoning-effort on every run,
    // so results cannot drift on a vendor-side change.
    defaultReasoningEffort: "high",
    models: [
      // Droid's version is not pinned anywhere in the platform: hosted
      // bundles resolve @factory/cli@latest at job creation (swarm_dashboard
      // lib/evaluations/worker/harness-bundles.ts resolveLatestSourceVersion)
      // and the evolve-all image installs Droid at image build. Measured
      // 2026-09-15 on npm latest 0.219.0: `npx @factory/cli@0.219.0 exec -m
      // claude-fable-5.1 --list-tools` answers "Available tools for Fable
      // 5.1", `-m gpt-6-astra` "Available tools for GPT-6 Astra", and the
      // dashed `claude-fable-5-1` "Invalid model" (docs.factory.ai/models.md
      // lists both accepted ids). Factory spells Fable 5.1 with a dot, so the
      // alias is Factory's id (direct mode passes it to Droid verbatim) and
      // gatewayModelAliases below rewrites it to the gateway's dashed entry
      // for the settings-file route — the kimi-k3 pattern. Full record:
      // team/dev-items/fable-astra-lane-report-2026-09-15.md.
      { alias: "claude-fable-5.1", modelId: "claude-fable-5-1", description: "Factory-managed Claude Fable 5.1" },
      { alias: "claude-opus-5", modelId: "claude-opus-5", description: "Factory-managed Claude Opus 5" },
      { alias: "claude-sonnet-5", modelId: "claude-sonnet-5", description: "Factory-managed Claude Sonnet 5" },
      { alias: "claude-haiku-4-5", modelId: "claude-haiku-4-5-20251001", description: "Factory-managed Claude Haiku 4.5" },
      { alias: "gpt-6-astra", modelId: "gpt-6-astra", description: "Factory-managed GPT-6 Astra" },
      { alias: "gpt-5.6-sol", modelId: "gpt-5.6-sol", description: "Factory-managed GPT-5.6 Sol" },
      { alias: "gpt-5.6-terra", modelId: "gpt-5.6-terra", description: "Factory-managed GPT-5.6 Terra" },
      { alias: "gpt-5.6-luna", modelId: "gpt-5.6-luna", description: "Factory-managed GPT-5.6 Luna" },
      { alias: "gemini-3.6-flash", modelId: "gemini-3.6-flash", description: "Factory-managed Gemini 3.6 Flash" },
      { alias: "qwen3.7-max", modelId: "qwen3.7-max", description: "Qwen 3.7 Max via the Evolve gateway" },
      { alias: "kimi-k3", modelId: "kimi-k3", description: "Factory-managed Droid Core Kimi K3" },
      { alias: "glm-5.3", modelId: "glm-5.3", description: "Zhipu GLM-5.3 via the Evolve gateway" },
      { alias: "glm-5.3-flash", modelId: "glm-5.3-flash", description: "Zhipu GLM-5.3 Flash via the Evolve gateway" },
      // DeepSeek V4.1 Flash under its OpenRouter id (the owner's ruling
      // 2026-09-10; the analyzer's default). Unlike glm-5.3, which rides a
      // bare alias rewritten by gatewayModelAliases below, this id needs no
      // rewrite: resolveCommandModel passes it through verbatim into the
      // Evolve-owned settings file, and the gateway's exact entry for it
      // serves it, priced from OpenRouter's own bill.
      { alias: "openrouter/deepseek/deepseek-v4.1-flash", modelId: "openrouter/deepseek/deepseek-v4.1-flash", description: "DeepSeek V4.1 Flash via OpenRouter" },
      // The same model on its second route, Fireworks (owner 2026-09-11: a
      // further option) — the same verbatim path, onto the gateway's exact
      // entry for this name.
      { alias: "fireworks/deepseek-v4.1-flash", modelId: "fireworks/deepseek-v4.1-flash", description: "DeepSeek V4.1 Flash via Fireworks" },
    ],
    systemPromptFile: "AGENTS.md",
    mcpConfig: {
      settingsDir: "~/.factory",
      filename: "mcp.json",
      format: "json",
    },
    skillsConfig: {
      targetDir: "~/.factory/skills",
    },
    skipApiKeyEnvInGateway: true,
    gatewayModelAliases: {
      // Factory's dot-form Fable 5.1 id becomes the gateway's dashed
      // Anthropic entry inside the Evolve-owned settings file.
      "claude-fable-5.1": "claude-fable-5-1",
      "kimi-k3": "moonshot/kimi-k3",
      "glm-5.3": "openrouter/z-ai/glm-5.3",
      // glm-5.3-flash rides bare: the gateway's plain name is the platform's
      // one GLM-5.3-Flash (served from Fireworks; the ruling 2026-09-08).
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
    // Droid resumes by the id its stream announced; the SDK keeps it here
    // between runs (agent.ts captureHarnessSessionId).
    sessionIdStateFile: "~/.factory/evolve-session.json",
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

  pi: {
    image: "evolve-all",
    // OpenRouter-only, like opencode (owner 2026-09-25); models.json names this var.
    apiKeyEnv: "OPENROUTER_API_KEY",
    effortSupport: "level",
    defaultModel: "openrouter/anthropic/claude-opus-5",
    // pi's own default is medium; owner policy pins graded harnesses at high.
    defaultReasoningEffort: "high",
    providerEnvMap: {
      openrouter: { keyEnv: "OPENROUTER_API_KEY" },
    },
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    models: [...OPENROUTER_ROSTER],
    // pi reads AGENTS.md (and CLAUDE.md) from the cwd (core/resource-loader.ts).
    systemPromptFile: "AGENTS.md",
    // pi's core has no MCP: the pi-mcp-adapter extension reads this file.
    mcpConfig: {
      settingsDir: "~/.pi/agent",
      filename: "mcp.json",
      format: "json",
    },
    skillsConfig: {
      targetDir: "~/.pi/agent/skills",
    },
    modelsJsonRoute: { agentDir: "~/.pi/agent", providerName: PI_FAMILY_PROVIDER, apiKeyRef: "dollar" },
    verdictFromStream: true,
    // pi's default cache warming issues extra requests that show up as usage.
    settingsStamp: {
      path: "~/.pi/agent/settings.json",
      document: { cacheWarming: "off", enableInstallTelemetry: false },
    },
    buildCommand: ({ prompt, model, isResume, reasoningEffort, isDirectMode, isExternalGateway, mcpConfigured, homeDir = DEFAULT_HOME_DIR }) => {
      const agentDir = `${homeDir}/.pi/agent`;
      const continueFlag = isResume ? "--continue " : "";
      const level = piThinkingLevel(reasoningEffort);
      const thinkingFlag = level ? ` --thinking ${level}` : "";
      const wireModel = piFamilyWireModel(model, { isDirectMode, isExternalGateway });
      // The adapter loads only when MCP servers were configured; a run without them never pays its startup.
      const adapterFlag = mcpConfigured ? ` --extension "\${${PI_MCP_ADAPTER_EXTENSION_ENV}:-${PI_MCP_ADAPTER_EXTENSION}}"` : "";
      // --approve: project resources and skills load only with trust granted, and JSON mode cannot ask.
      // --session-dir: one flat dir (the default nests per cwd). The PI_* vars stop every pi.dev call.
      return `PI_OFFLINE=1 PI_TELEMETRY=0 PI_SKIP_VERSION_CHECK=1 pi --mode json --approve ${continueFlag}--provider ${PI_FAMILY_PROVIDER} --model ${wireModel}${thinkingFlag} --session-dir ${agentDir}/sessions${adapterFlag} -- "${prompt}" </dev/null`;
    },
  },

  "prime-agent": {
    image: "evolve-all",
    // OpenRouter-only (owner 2026-09-25); models.json names this var, bare (Prime's spelling).
    apiKeyEnv: "OPENROUTER_API_KEY",
    effortSupport: "level",
    defaultModel: "openrouter/anthropic/claude-opus-5",
    // Prime's own default is medium; owner policy pins graded harnesses at high.
    defaultReasoningEffort: "high",
    providerEnvMap: {
      openrouter: { keyEnv: "OPENROUTER_API_KEY" },
    },
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    models: [...OPENROUTER_ROSTER],
    systemPromptFile: "AGENTS.md",
    // Prime reads MCP servers from the GLOBAL settings.json only (project-level maps are ignored).
    mcpConfig: {
      settingsDir: "~/.prime/agent",
      filename: "settings.json",
      format: "json",
    },
    skillsConfig: {
      targetDir: "~/.prime/agent/skills",
    },
    modelsJsonRoute: { agentDir: "~/.prime/agent", providerName: PI_FAMILY_PROVIDER, apiKeyRef: "bare" },
    verdictFromStream: true,
    // Prime's waitForUsage parks a 429'd session until the provider's reset; a metered run's clock is the only budget.
    settingsStamp: {
      path: "~/.prime/agent/settings.json",
      document: { retry: { provider: { waitForUsage: { enabled: false, pauseUntilReset: false } } } },
    },
    // The Python kernel venv (~214 MB, a reproducible install) never rides a checkpoint.
    checkpointExcludes: [
      ".prime/agent/kernel-venv",
    ],
    buildCommand: ({ prompt, model, isResume, reasoningEffort, isDirectMode, isExternalGateway }) => {
      const continueFlag = isResume ? "--continue " : "";
      const level = piThinkingLevel(reasoningEffort);
      const thinkingFlag = level ? ` --thinking ${level}` : "";
      const wireModel = piFamilyWireModel(model, { isDirectMode, isExternalGateway });
      // --cwd "$PWD": a daemon-side worker runs the session, so the spawn cwd travels explicitly.
      // TMPDIR: the daemon socket lives under it (108-byte socket path limit). Exit 0 is no verdict (verdictFromStream).
      return `PRIME_AGENT_TELEMETRY=0 TMPDIR=/tmp prime-agent --mode json --offline --cwd "$PWD" ${continueFlag}--provider ${PI_FAMILY_PROVIDER} --model ${wireModel}${thinkingFlag} -- "${prompt}" </dev/null`;
    },
  },
  // dsh: routing rides an Evolve-owned --patch file (dshRoutePatch), never
  // flags; recon team/dev-items/harness-recon-2026-09-25/01-deepseek.md.
  dsh: {
    image: "evolve-all",
    // The patch's apiKeyEnv names this env; never DEEPSEEK_API_KEY, which
    // dsh's web_search would send to DeepSeek's own search API.
    apiKeyEnv: "OPENROUTER_API_KEY",
    effortSupport: "level",
    efforts: DSH_REASONING_EFFORTS,
    // Read by the patch as `!!js process.env.EVOLVE_DSH_BASE_URL`; every mode sets it ending in /v1.
    baseUrlEnv: "EVOLVE_DSH_BASE_URL",
    defaultModel: "openrouter/deepseek/deepseek-v4.1-flash",
    // DeepSeek's documented default (01-deepseek.md §C); owner policy pins graded harnesses high.
    defaultReasoningEffort: "high",
    // Direct mode is OpenRouter-only, like opencode; the fireworks/ names are gateway routes.
    providerEnvMap: {
      openrouter: { keyEnv: "OPENROUTER_API_KEY" },
    },
    // Owner decision 2026-09-25 (recon README): V4.1 Flash and V4 Pro on both
    // routes; alias == wire id, the gateway's exact entry for each name.
    models: [
      { alias: "openrouter/deepseek/deepseek-v4.1-flash", modelId: "openrouter/deepseek/deepseek-v4.1-flash", description: "DeepSeek V4.1 Flash via OpenRouter" },
      { alias: "fireworks/deepseek-v4.1-flash", modelId: "fireworks/deepseek-v4.1-flash", description: "DeepSeek V4.1 Flash via Fireworks" },
      { alias: "openrouter/deepseek/deepseek-v4-pro-0813", modelId: "openrouter/deepseek/deepseek-v4-pro-0813", description: "DeepSeek V4 Pro via OpenRouter" },
      { alias: "fireworks/deepseek-v4-pro-0813", modelId: "fireworks/deepseek-v4-pro-0813", description: "DeepSeek V4 Pro via Fireworks" },
    ],
    // AGENTS.md then CLAUDE.md from the project root down to cwd (01-deepseek.md §F).
    systemPromptFile: "AGENTS.md",
    // MCP rows are a second patch file (mcp/yaml.ts); dsh reads no .mcp.json.
    mcpConfig: {
      settingsDir: "~/.dsh",
      filename: "evolve-mcp.patch.yml",
      format: "yaml",
    },
    // $DSH_HOME/skills, inside the captured home (§F; live S1).
    skillsConfig: {
      targetDir: "~/.dsh/skills",
    },
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    // OpenRouter itself knows the id without the gateway's openrouter/ route prefix.
    directModelAliases: {
      "openrouter/deepseek/deepseek-v4.1-flash": "deepseek/deepseek-v4.1-flash",
      "openrouter/deepseek/deepseek-v4-pro-0813": "deepseek/deepseek-v4-pro-0813",
    },
    // The patch's `headers` map reads these per request, so the file stays static per session.
    spendTrackingEnvs: {
      sessionTagEnv: "EVOLVE_LITELLM_CUSTOMER_ID",
      runTagEnv: "EVOLVE_LITELLM_TAGS",
    },
    dshRoutePatch: {
      path: "~/.dsh/evolve-route.patch.yml",
      providerName: "evolve",
      // The window every live run used; maxTokens is the request's max_tokens.
      contextWindow: 128000,
      maxTokens: 32000,
    },
    // dsh resumes only by `--session-id <id>` from its opening `session` line (§B).
    sessionIdStateFile: "~/.dsh/evolve-session.json",
    buildCommand: ({ prompt, isResume, sessionId, homeDir = DEFAULT_HOME_DIR }) => {
      const dshHome = `${homeDir}/.dsh`;
      const routePatch = `${dshHome}/evolve-route.patch.yml`;
      const mcpPatch = `${dshHome}/evolve-mcp.patch.yml`;
      const mcpFlag = `$(if [ -f ${mcpPatch} ]; then printf ' --patch ${mcpPatch}'; fi)`;
      const resumeFlag = isResume && sessionId ? ` --session-id ${shellSingleQuote(sessionId)}` : "";
      // No permission flag exists: the env unconfines the sandbox and never asks (§B).
      return `DSH_HOME=${dshHome} DSH_PERMISSION_MODE=danger-full-access DSH_TELEMETRY_DISABLED=1 dsh --profile headless --patch ${routePatch}${mcpFlag} --json${resumeFlag} -- "${prompt}"`;
    },
  },

  zcode: {
    image: "evolve-all",
    // The SDK's direct-mode input; the CLI reads its key and URL from the provider file, never env.
    apiKeyEnv: "OPENROUTER_API_KEY",
    effortSupport: "level",
    defaultModel: "openrouter/z-ai/glm-5.3",
    // Owner policy: graded-effort harnesses pin high; the pin lands in the provider file every run.
    defaultReasoningEffort: "high",
    // Direct mode is OpenRouter only; the fireworks/ routes are refused typed there (utils/config.ts).
    providerEnvMap: {
      openrouter: { keyEnv: "OPENROUTER_API_KEY" },
    },
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    // Owner decision 2026-09-25: GLM 5.3 and GLM 5.3 Flash under route-spelled names; alias == wire id.
    models: [
      { alias: "openrouter/z-ai/glm-5.3", modelId: "openrouter/z-ai/glm-5.3", description: "Zhipu GLM-5.3 via OpenRouter" },
      { alias: "openrouter/z-ai/glm-5.3-flash", modelId: "openrouter/z-ai/glm-5.3-flash", description: "Zhipu GLM-5.3 Flash via OpenRouter" },
      { alias: "fireworks/glm-5.3", modelId: "fireworks/glm-5.3", description: "Zhipu GLM-5.3 via Fireworks" },
      { alias: "fireworks/glm-5.3-flash", modelId: "fireworks/glm-5.3-flash", description: "Zhipu GLM-5.3 Flash via Fireworks" },
    ],
    // Z Code reads AGENTS.md from the cwd upward (never CLAUDE.md).
    systemPromptFile: "AGENTS.md",
    // User-level MCP file; every server carries an explicit `type` (the schema drops one without).
    mcpConfig: {
      settingsDir: "~/.zcode/cli",
      filename: "config.json",
      format: "json",
    },
    skillsConfig: {
      targetDir: "~/.zcode/skills",
    },
    // Direct mode sends OpenRouter its own ids; the fireworks rows have no direct-mode home.
    directModelAliases: {
      "openrouter/z-ai/glm-5.3": "z-ai/glm-5.3",
      "openrouter/z-ai/glm-5.3-flash": "z-ai/glm-5.3-flash",
    },
    zcodeProviderConfig: {
      path: "~/.zcode/v2/provider_config.json",
      providerId: "evolve",
      providerName: "Evolve gateway",
      // Every GLM route's real window is above this; Z Code compacts here.
      contextWindow: PINNED_CONTEXT_WINDOW_TOKENS,
      maxOutputTokens: 32768,
    },
    // The whole ~/.zcode home rides the checkpoint; the provider file (literal key) and two caches never do.
    checkpointDirs: [
      "~/.zcode",
    ],
    checkpointExcludes: [
      ".zcode/v2/provider_config.json",
      ".zcode/cli/plugins/cache",
      ".zcode/v2/runtime",
    ],
    // Exit 0 is no verdict: turn.failed and a non-success turn.completed are fatal errors (verdictFromStream).
    verdictFromStream: true,
    // `-p` is headless (yolo, no TTY); the model comes from the provider file. Every ZCODE_* a
    // task's `.env` could move or re-route is pinned on the command (zcodeEnvPins).
    buildCommand: ({ prompt, isResume, homeDir = DEFAULT_HOME_DIR }) => {
      const continueFlag = isResume ? "--continue " : "";
      const pins = Object.entries(zcodeEnvPins(homeDir))
        .map(([name, value]) => `${name}=${shellSingleQuote(value)}`)
        .join(" ");
      return `${pins} zcode -p "${prompt}" ${continueFlag}--output-format stream-json`;
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
 * True when `model` is an identifier the registry entry itself declares: a
 * roster alias or wire id, or a key or value of its alias tables.
 */
export function registryOwnsModel(registry: AgentRegistryEntry, model: string): boolean {
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

/**
 * The wire id the roster declares for `model` when it is a roster alias; any
 * other name verbatim.
 */
export function registryWireId(registry: AgentRegistryEntry, model: string): string {
  return registry.models.find((entry) => entry.alias === model)?.modelId ?? model;
}

/**
 * The model string opencode's command line carries for `model`, derived from
 * this file's own roster — not a mirror of the gateway's route spellings,
 * which name more routes than this harness carries.
 *
 * The roster speaks OpenRouter ids (`openrouter/<vendor>/<model>`, OpenRouter's
 * own form), so a name in that form rides as-is — a roster id, or beyond the
 * table any OpenRouter id the caller routes explicitly (the docs' prefixed
 * routing) — to OpenRouter itself in direct mode or to the gateway's
 * `openrouter/*` route. Every other roster id already carries its route in
 * its spelling (alias == wire id, pinned in
 * tests/unit/harness-capabilities.test.ts): `fireworks/deepseek-v4.1-flash`
 * rides verbatim onto the gateway's exact entry for that name. Only a bare
 * name that is neither gets OpenRouter's prefix.
 */
export function opencodeRoutedModel(model: string): string {
  if (model.startsWith("openrouter/") || registryOwnsModel(AGENT_REGISTRY.opencode, model)) {
    return model;
  }
  return `openrouter/${model}`;
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
