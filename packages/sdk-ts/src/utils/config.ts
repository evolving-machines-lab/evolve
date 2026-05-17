/**
 * Configuration Utilities
 */

import * as fs from "fs";
import type { AgentConfig, AgentType, ResolvedAgentConfig } from "../types";
import { DEFAULT_AGENT_TYPE, ENV_EVOLVE_API_KEY } from "../constants";
import { getAgentConfig } from "../registry";

/** Read OAuth file content (for file-based OAuth like Codex) */
function readOAuthFile(filePath: string): string {
  const expandedPath = filePath.replace(/^~/, process.env.HOME || "");
  if (!fs.existsSync(expandedPath)) {
    throw new Error(`OAuth file not found: ${expandedPath}`);
  }
  return fs.readFileSync(expandedPath, "utf-8");
}

function assertFastInferenceAllowed(type: AgentType, isOAuth: boolean, fastInference?: boolean): void {
  if (!fastInference) {
    return;
  }
  if (type !== "codex" || !isOAuth) {
    throw new Error(
      "fastInference is only supported for codex OAuth mode " +
      "(CODEX_OAUTH_FILE_PATH / ChatGPT auth), not API-key or gateway mode."
    );
  }
}

function resolveOAuthEnvConfig(
  type: AgentType,
  registry: ReturnType<typeof getAgentConfig>,
  config?: AgentConfig
): ResolvedAgentConfig | undefined {
  if (!registry.oauthEnv) {
    return undefined;
  }

  const oauthValue = process.env[registry.oauthEnv];
  if (!oauthValue) {
    return undefined;
  }

  if (registry.oauthFileName) {
    // File-based OAuth (Codex, Gemini): env var is file path, read content.
    const oauthFileContent = readOAuthFile(oauthValue);
    assertFastInferenceAllowed(type, true, config?.fastInference);
    return {
      type,
      apiKey: "__oauth_file__",
      isDirectMode: true,
      isOAuth: true,
      oauthFileContent,
      model: config?.model,
      reasoningEffort: config?.reasoningEffort,
      fastInference: config?.fastInference,
    };
  }

  // Token-based OAuth (Claude): env var is token itself.
  assertFastInferenceAllowed(type, true, config?.fastInference);
  return {
    type,
    apiKey: oauthValue,
    isDirectMode: true,
    isOAuth: true,
    model: config?.model,
    reasoningEffort: config?.reasoningEffort,
    fastInference: config?.fastInference,
  };
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

  // ─────────────────────────────────────────────────────────────────────────
  // EXPLICIT CONFIG (user passed values directly - always respect these)
  // ─────────────────────────────────────────────────────────────────────────

  // OAuth token (Claude Max subscription only)
  if (config?.oauthToken) {
    if (type !== "claude") {
      throw new Error(
        `oauthToken is only supported for claude agent (Claude Max subscription), not ${type}. ` +
        `Use providerApiKey for ${type} instead.`
      );
    }
    assertFastInferenceAllowed(type, true, config.fastInference);
    return {
      type,
      apiKey: config.oauthToken,
      isDirectMode: true,
      isOAuth: true,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      fastInference: config.fastInference,
    };
  }

  // Provider API key (direct mode)
  if (config?.providerApiKey) {
    assertFastInferenceAllowed(type, false, config.fastInference);
    const envBaseUrl = registry.baseUrlEnv ? process.env[registry.baseUrlEnv] : undefined;
    const baseUrl = config.providerBaseUrl ?? envBaseUrl ?? registry.defaultBaseUrl;
    return {
      type,
      apiKey: config.providerApiKey,
      baseUrl,
      isDirectMode: true,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      fastInference: config.fastInference,
    };
  }

  // Gateway API key (explicit)
  if (config?.apiKey) {
    assertFastInferenceAllowed(type, false, config.fastInference);
    return {
      type,
      apiKey: config.apiKey,
      isDirectMode: false,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      fastInference: config.fastInference,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ENVIRONMENT VARIABLES (auto-resolve - gateway takes precedence)
  // ─────────────────────────────────────────────────────────────────────────

  // Codex fast mode is OAuth-only; when requested, prefer Codex OAuth over
  // default env-key resolution so ambient EVOLVE_API_KEY/OPENAI_API_KEY cannot
  // silently force standard API pricing.
  if (type === "codex" && config?.fastInference) {
    const oauthConfig = resolveOAuthEnvConfig(type, registry, config);
    if (oauthConfig) {
      return oauthConfig;
    }
  }

  // Gateway mode (EVOLVE_API_KEY) - preferred for observability & billing
  const evolveKey = process.env[ENV_EVOLVE_API_KEY];
  if (evolveKey) {
    assertFastInferenceAllowed(type, false, config?.fastInference);
    return {
      type,
      apiKey: evolveKey,
      isDirectMode: false,
      model: config?.model,
      reasoningEffort: config?.reasoningEffort,
      fastInference: config?.fastInference,
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
      assertFastInferenceAllowed(type, false, config?.fastInference);
      const envBaseUrl = registry.baseUrlEnv ? process.env[registry.baseUrlEnv] : undefined;
      const baseUrl = envBaseUrl ?? registry.defaultBaseUrl;
      return {
        type,
        apiKey: altKey,
        baseUrl,
        isDirectMode: true,
        model: config?.model,
        reasoningEffort: config?.reasoningEffort,
        fastInference: config?.fastInference,
      };
    }
  }

  // Direct mode (generic provider env var — fallback for single-provider agents)
  const providerKey = process.env[registry.apiKeyEnv];
  if (providerKey) {
    assertFastInferenceAllowed(type, false, config?.fastInference);
    const envBaseUrl = registry.baseUrlEnv ? process.env[registry.baseUrlEnv] : undefined;
    const baseUrl = envBaseUrl ?? registry.defaultBaseUrl;
    return {
      type,
      apiKey: providerKey,
      baseUrl,
      isDirectMode: true,
      model: config?.model,
      reasoningEffort: config?.reasoningEffort,
      fastInference: config?.fastInference,
    };
  }

  // OAuth mode (token or file-based)
  const oauthConfig = resolveOAuthEnvConfig(type, registry, config);
  if (oauthConfig) {
    return oauthConfig;
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
