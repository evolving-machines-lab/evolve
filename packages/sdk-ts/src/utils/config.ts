/**
 * Configuration Utilities
 */

import * as fs from "fs";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { AgentConfig, AgentPreset, AgentType, ResolvedAgentConfig, RunOptions } from "../types";
import { AGENT_PRESETS } from "../types";
import { DEFAULT_AGENT_TYPE, ENV_EVOLVE_API_KEY, RESERVED_OBSERVABILITY_KEYS } from "../constants";
import { AGENT_REGISTRY, getAgentConfig, isValidAgentType } from "../registry";

/**
 * A configuration field the caller got wrong, reported by name.
 *
 * Without a check at the door the mistake travels: an empty model or a missing
 * prompt reaches the command builder and comes back as
 * `Cannot read properties of undefined (reading 'replace')` thrown by a
 * shell-quoting helper, which names nothing the caller wrote and points at a
 * file they have never opened.
 */
export class EvolveConfigError extends Error {
  /** The configuration field at fault, e.g. "model" or "prompt". */
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = "EvolveConfigError";
    this.field = field;
  }
}

/** A usable string value: present, a string, and not just whitespace. */
function isFilled(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

/** How a bad value reads back to the caller, quoted so "" is visible. */
function describe(value: unknown): string {
  return value === null || value === undefined ? String(value) : JSON.stringify(value);
}

/**
 * Check an agent config's required fields before anything builds a command.
 *
 * Omitting a field is allowed wherever the SDK has a default — `model` left out
 * means "use the agent's default model". Setting a field to an unusable value
 * is not: it is a mistake the caller wants named, not silently replaced by the
 * default. Takes both the config the caller writes and the resolved one, since
 * .withAgent() and `new Agent()` are both doors into the same command builder.
 */
export function validateAgentConfig(config?: AgentConfig | ResolvedAgentConfig): void {
  if (!config) return;

  if (config.type !== undefined && !isValidAgentType(config.type as string)) {
    throw new EvolveConfigError(
      "type",
      `Evolve agent config: unknown agent type ${describe(config.type)}. ` +
      `Valid types: ${Object.keys(AGENT_REGISTRY).join(", ")}.`,
    );
  }

  const type = (config.type ?? DEFAULT_AGENT_TYPE) as AgentType;
  if (config.model !== undefined && !isFilled(config.model)) {
    throw new EvolveConfigError(
      "model",
      `Evolve agent config: "model" is empty (${describe(config.model)}). ` +
      `Pass a model id such as "${getAgentConfig(type).defaultModel}", ` +
      `or omit model entirely to use ${type}'s default.`,
    );
  }

  if (config.config !== undefined) {
    if (!agentSupportsNativeConfig(type)) {
      // Harbor's SUPPORTS_CONFIG refusal (agents/installed/base.py:528-531),
      // named at the door instead of at run time.
      throw new EvolveConfigError(
        "config",
        `Evolve agent config: agent "${type}" does not support a native config. ` +
        `Agents with native-config support: ${nativeConfigAgentTypes().join(", ")}.`,
      );
    }
    const value = config.config;
    if (typeof value === "string") {
      if (!isFilled(value)) {
        throw new EvolveConfigError(
          "config",
          `Evolve agent config: "config" is an empty path (${describe(value)}). ` +
          `Pass a local settings file path or an inline JSON object.`,
        );
      }
    } else if (!isPlainRecord(value)) {
      throw new EvolveConfigError(
        "config",
        `Evolve agent config: "config" must be a local file path or a JSON object, ` +
        `received ${describe(value)}.`,
      );
    }
  }

  if (config.preset !== undefined) {
    validateAgentPreset(type, config.preset);
  }
}

/**
 * Refuse a preset the harness cannot GUARANTEE, by name — an unknown preset
 * and a known preset on a harness without delivery knowledge for it are both
 * typed refusals here, never a run that silently lacks its guarantee.
 */
export function validateAgentPreset(type: AgentType, preset: unknown): asserts preset is AgentPreset {
  if (!(AGENT_PRESETS as readonly string[]).includes(preset as string)) {
    throw new EvolveConfigError(
      "preset",
      `Evolve agent config: unknown preset ${describe(preset)}. ` +
      `Valid presets: ${AGENT_PRESETS.join(", ")}.`,
    );
  }
  const supported = agentPresetTypes(preset as AgentPreset);
  if (!supported.includes(type)) {
    throw new EvolveConfigError(
      "preset",
      `Evolve agent config: agent "${type}" cannot guarantee preset "${preset}". ` +
      `Agents that can: ${supported.join(", ")}.`,
    );
  }
}

/** The presets an agent type can guarantee, registry order. */
export function agentPresets(type: AgentType): AgentPreset[] {
  const presets = AGENT_REGISTRY[type]?.presets;
  return presets ? (Object.keys(presets) as AgentPreset[]) : [];
}

/** The agent types that can guarantee one preset, registry order. */
export function agentPresetTypes(preset: AgentPreset): AgentType[] {
  return (Object.keys(AGENT_REGISTRY) as AgentType[]).filter((type) =>
    agentPresets(type).includes(preset),
  );
}

/**
 * Merge a preset's configStamp ON TOP of a base settings document: plain
 * objects recurse, arrays union (base order kept, stamp entries appended when
 * missing — a user's own `permissions.deny` survives beside the preset's),
 * anything else the stamp overwrites. Pure — inputs are not mutated.
 */
export function stampNativeConfig(
  base: Record<string, unknown>,
  stamp: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...base };
  for (const [key, stampValue] of Object.entries(stamp)) {
    const baseValue = merged[key];
    if (isPlainRecord(baseValue) && isPlainRecord(stampValue)) {
      merged[key] = stampNativeConfig(baseValue, stampValue);
    } else if (Array.isArray(baseValue) && Array.isArray(stampValue)) {
      const union = [...baseValue];
      for (const item of stampValue) {
        if (!union.some((existing) => canonicalJson(existing) === canonicalJson(item))) {
          union.push(item);
        }
      }
      merged[key] = union;
    } else {
      merged[key] = stampValue;
    }
  }
  return merged;
}

/** A JSON-object-shaped value: a plain record, not an array/null/scalar. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an agent type has native-config knowledge in the registry. */
export function agentSupportsNativeConfig(type: AgentType): boolean {
  return AGENT_REGISTRY[type]?.nativeConfig !== undefined;
}

/** The agent types that accept a native config document, registry order. */
export function nativeConfigAgentTypes(): AgentType[] {
  return (Object.keys(AGENT_REGISTRY) as AgentType[]).filter(agentSupportsNativeConfig);
}

/**
 * Normalize a native agent config input into the document object the sandbox
 * delivery writes: a file path is read and parsed here (JSON, or TOML for a
 * TOML-format harness), an inline object is round-trip checked so nothing the
 * wire cannot carry (functions, Dates, NaN) sneaks into a settings file —
 * Harbor does the identical checks in base.py:533-559 and codex.py:989-1020.
 */
export function loadNativeAgentConfig(
  type: AgentType,
  config: string | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (config === undefined) return undefined;
  const native = AGENT_REGISTRY[type]?.nativeConfig;
  if (!native) {
    throw new EvolveConfigError(
      "config",
      `Evolve agent config: agent "${type}" does not support a native config. ` +
      `Agents with native-config support: ${nativeConfigAgentTypes().join(", ")}.`,
    );
  }

  let document: unknown;
  if (typeof config === "string") {
    const expandedPath = config.replace(/^~/, process.env.HOME || "");
    if (!fs.existsSync(expandedPath)) {
      throw new EvolveConfigError("config", `Agent config file not found: ${expandedPath}`);
    }
    const text = fs.readFileSync(expandedPath, "utf-8");
    try {
      document = native.format === "toml" ? parseToml(text) : JSON.parse(text);
    } catch (error) {
      throw new EvolveConfigError(
        "config",
        `Invalid ${type} config file ${config}: ${(error as Error).message}`,
      );
    }
  } else {
    // Inline object: must survive a JSON round trip unchanged, so a value the
    // serializer would rewrite (a Date, NaN, undefined, a function) is refused
    // by name instead of silently landing in the sandbox as something else.
    let roundTripped: unknown;
    try {
      roundTripped = JSON.parse(JSON.stringify(config)) as unknown;
    } catch (error) {
      throw new EvolveConfigError(
        "config",
        `Invalid inline ${type} config: not JSON-serializable: ${(error as Error).message}`,
      );
    }
    if (JSON.stringify(roundTripped) !== JSON.stringify(config)) {
      throw new EvolveConfigError(
        "config",
        `Invalid inline ${type} config: expected a JSON object that can be ` +
        `represented without conversion`,
      );
    }
    document = roundTripped;
  }

  if (!isPlainRecord(document)) {
    throw new EvolveConfigError(
      "config",
      `Invalid ${type} config: expected a ${native.format === "toml" ? "TOML table" : "JSON object"}.`,
    );
  }

  if (native.format === "toml") {
    // The document must serialize to TOML losslessly (Harbor codex.py:994-1006).
    // smol-toml silently DROPS what TOML cannot carry (null above all), so the
    // round trip is compared key-insensitively — a dropped key is exactly the
    // silent rewrite this check exists to refuse.
    let roundTripped: unknown;
    try {
      roundTripped = parseToml(stringifyToml(document));
    } catch (error) {
      throw new EvolveConfigError(
        "config",
        `Invalid ${type} config for TOML conversion: ${(error as Error).message}`,
      );
    }
    if (canonicalJson(roundTripped) !== canonicalJson(document)) {
      throw new EvolveConfigError(
        "config",
        `Invalid ${type} config: the document cannot be represented losslessly as TOML ` +
        `(TOML has no null and no mixed-type arrays)`,
      );
    }
  }

  return document;
}

/** JSON with recursively sorted object keys — an order-insensitive comparison form. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Check a run's required fields before anything builds a command.
 *
 * The prompt is the one field a run cannot default: it becomes the agent's
 * argv, and an absent one used to reach the shell-quoting helper.
 */
export function validateRunOptions(options?: RunOptions): void {
  if (!options || !isFilled(options.prompt)) {
    throw new EvolveConfigError(
      "prompt",
      `run() requires a non-empty "prompt" string, received ${describe(options?.prompt)}.`,
    );
  }
}

/**
 * Check observability metadata for names the session envelope already owns.
 *
 * Metadata annotates a session; it may not rename one. The names in
 * RESERVED_OBSERVABILITY_KEYS carry the session's identity to the dashboard,
 * and metadata is spread over them, so `{ tag: "nightly" }` silently forks the
 * run into two half-filled rows instead of labelling it. The caller wanted a
 * label, so say which key is not available rather than accepting the value and
 * splitting their billing.
 */
export function validateObservabilityMeta(meta?: Record<string, unknown>): void {
  if (!meta) return;

  for (const key of RESERVED_OBSERVABILITY_KEYS) {
    if (key in meta) {
      throw new EvolveConfigError(
        `observability.${key}`,
        `Evolve observability metadata: "${key}" is reserved for session identity ` +
        `and would split this run across two dashboard sessions. ` +
        `Reserved keys: ${RESERVED_OBSERVABILITY_KEYS.join(", ")}. ` +
        `Use a different key, or set the session tag with .withSessionTagPrefix().`,
      );
    }
  }
}

/**
 * externalGateway is a standalone credential mode: it must not be combined
 * with gateway mode (apiKey) or direct mode (providerApiKey/providerBaseUrl/oauthToken).
 */
export function assertExternalGatewayExclusive(config: AgentConfig): void {
  if (!config.externalGateway) return;
  if (config.providerApiKey || config.providerBaseUrl || config.oauthToken) {
    throw new Error(
      "externalGateway cannot be combined with providerApiKey/providerBaseUrl/oauthToken (direct mode)",
    );
  }
  if (config.apiKey) {
    throw new Error(
      "externalGateway cannot be combined with apiKey (Evolve gateway mode)",
    );
  }
}

/** Read OAuth file content (for file-based OAuth like Codex) */
function readOAuthFile(filePath: string): string {
  const expandedPath = filePath.replace(/^~/, process.env.HOME || "");
  if (!fs.existsSync(expandedPath)) {
    throw new Error(`OAuth file not found: ${expandedPath}`);
  }
  return fs.readFileSync(expandedPath, "utf-8");
}

/**
 * Resolve AgentConfig with defaults and environment variables.
 *
 * Priority (explicit config first, then env vars):
 *   1. Explicit: oauthToken → providerApiKey → apiKey
 *   2. Environment: EVOLVE_API_KEY → provider env → oauth env
 *
 * Gateway mode (EVOLVE_API_KEY) takes precedence over direct mode env vars
 * to route traffic through the gateway when both are set.
 */
export function resolveAgentConfig(config?: AgentConfig): ResolvedAgentConfig {
  const type = (config?.type ?? DEFAULT_AGENT_TYPE) as AgentType;
  const registry = getAgentConfig(type);

  // Native config and preset are credential-mode independent: normalized and
  // validated once here (file paths read NOW, at run resolution — Harbor
  // reads at agent __init__; an unguaranteeable preset refuses NOW, before a
  // sandbox exists) and attached to whichever mode branch returns below.
  const nativeConfig = loadNativeAgentConfig(type, config?.config);
  if (config?.preset !== undefined) {
    validateAgentPreset(type, config.preset);
  }
  const nativeConfigProp = {
    ...(nativeConfig !== undefined ? { config: nativeConfig } : {}),
    ...(config?.preset !== undefined ? { preset: config.preset } : {}),
  };

  // ─────────────────────────────────────────────────────────────────────────
  // EXPLICIT CONFIG (user passed values directly - always respect these)
  // ─────────────────────────────────────────────────────────────────────────

  // External gateway mode (caller-minted revocable credential)
  if (config?.externalGateway) {
    assertExternalGatewayExclusive(config);
    const { apiKey, baseUrl, revoke } = config.externalGateway;
    if (!apiKey || !baseUrl || typeof revoke !== "function") {
      throw new Error(
        "externalGateway requires apiKey, baseUrl, and a revoke() function",
      );
    }
    return {
      type,
      apiKey,
      baseUrl,
      isDirectMode: true,
      externalGateway: { revoke },
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      maxContextSize: config.maxContextSize,
      ...nativeConfigProp,
    };
  }

  // OAuth token (Claude Max subscription only)
  if (config?.oauthToken) {
    if (type !== "claude") {
      throw new Error(
        `oauthToken is only supported for claude agent (Claude Max subscription), not ${type}. ` +
        `Use providerApiKey for ${type} instead.`
      );
    }
    return {
      type,
      apiKey: config.oauthToken,
      isDirectMode: true,
      isOAuth: true,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      maxContextSize: config.maxContextSize,
      ...nativeConfigProp,
    };
  }

  // Provider API key (direct mode)
  if (config?.providerApiKey) {
    const envBaseUrl = registry.baseUrlEnv ? process.env[registry.baseUrlEnv] : undefined;
    const baseUrl = config.providerBaseUrl ?? envBaseUrl ?? registry.defaultBaseUrl;
    return {
      type,
      apiKey: config.providerApiKey,
      baseUrl,
      isDirectMode: true,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      maxContextSize: config.maxContextSize,
      ...nativeConfigProp,
    };
  }

  // Gateway API key (explicit)
  if (config?.apiKey) {
    return {
      type,
      apiKey: config.apiKey,
      isDirectMode: false,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      maxContextSize: config.maxContextSize,
      ...nativeConfigProp,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ENVIRONMENT VARIABLES (auto-resolve - gateway takes precedence)
  // ─────────────────────────────────────────────────────────────────────────

  // Gateway mode (EVOLVE_API_KEY) - preferred for observability & billing
  const evolveKey = process.env[ENV_EVOLVE_API_KEY];
  if (evolveKey) {
    return {
      type,
      apiKey: evolveKey,
      isDirectMode: false,
      model: config?.model,
      reasoningEffort: config?.reasoningEffort,
      maxContextSize: config?.maxContextSize,
      ...nativeConfigProp,
    };
  }

  // Prefix-mapped direct mode (e.g., OpenCode: "openrouter/..." → OPENROUTER_API_KEY)
  // Checked BEFORE generic apiKeyEnv for registries that use model-prefix key mapping.
  if (registry.providerEnvMap) {
    const model = config?.model ?? registry.defaultModel;
    const prefix = model?.split("/")[0];
    const mapping = prefix ? registry.providerEnvMap[prefix] : undefined;
    const altKey = mapping ? process.env[mapping.keyEnv] : undefined;
    if (altKey) {
      const envBaseUrl = registry.baseUrlEnv ? process.env[registry.baseUrlEnv] : undefined;
      const baseUrl = envBaseUrl ?? registry.defaultBaseUrl;
      return {
        type,
        apiKey: altKey,
        baseUrl,
        isDirectMode: true,
        model: config?.model,
        reasoningEffort: config?.reasoningEffort,
        maxContextSize: config?.maxContextSize,
        ...nativeConfigProp,
      };
    }
  }

  // Direct mode (generic provider env var — fallback for single-provider agents)
  const providerKey = process.env[registry.apiKeyEnv];
  if (providerKey) {
    const envBaseUrl = registry.baseUrlEnv ? process.env[registry.baseUrlEnv] : undefined;
    const baseUrl = envBaseUrl ?? registry.defaultBaseUrl;
    return {
      type,
      apiKey: providerKey,
      baseUrl,
      isDirectMode: true,
      model: config?.model,
      reasoningEffort: config?.reasoningEffort,
      maxContextSize: config?.maxContextSize,
      ...nativeConfigProp,
    };
  }

  // OAuth mode (token or file-based)
  if (registry.oauthEnv) {
    const oauthValue = process.env[registry.oauthEnv];
    if (oauthValue) {
      if (registry.oauthFileName) {
        // File-based OAuth (Codex, Gemini): env var is file path, read content
        const oauthFileContent = readOAuthFile(oauthValue);
        return {
          type,
          apiKey: "__oauth_file__",
          isDirectMode: true,
          isOAuth: true,
          oauthFileContent,
          model: config?.model,
          reasoningEffort: config?.reasoningEffort,
          maxContextSize: config?.maxContextSize,
          ...nativeConfigProp,
        };
      }
      // Token-based OAuth (Claude): env var is token itself
      return {
        type,
        apiKey: oauthValue,
        isDirectMode: true,
        isOAuth: true,
        model: config?.model,
        reasoningEffort: config?.reasoningEffort,
        maxContextSize: config?.maxContextSize,
        ...nativeConfigProp,
      };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NO KEY FOUND
  // ─────────────────────────────────────────────────────────────────────────

  const oauthHint = registry.oauthEnv
    ? (registry.oauthFileName ? `, or ${registry.oauthEnv}` : `, oauthToken, or ${registry.oauthEnv}`)
    : "";
  throw new Error(
    `No API key found for ${type}. Set apiKey (gateway), providerApiKey (direct)${oauthHint}, ` +
    `or ${ENV_EVOLVE_API_KEY} / ${registry.apiKeyEnv} env var.`
  );
}
