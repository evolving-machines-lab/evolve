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
    return {
      type,
      apiKey: config.oauthToken,
      isDirectMode: true,
      isOAuth: true,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
    };
  }

  // Provider API key (direct mode)
  if (config?.providerApiKey) {
    const baseUrl = config.providerBaseUrl ?? process.env[registry.baseUrlEnv] ?? registry.defaultBaseUrl;
    return {
      type,
      apiKey: config.providerApiKey,
      baseUrl,
      isDirectMode: true,
      model: config.model,
      reasoningEffort: config.reasoningEffort,
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
      const baseUrl = process.env[registry.baseUrlEnv] ?? registry.defaultBaseUrl;
      return {
        type,
        apiKey: altKey,
        baseUrl,
        isDirectMode: true,
        model: config?.model,
        reasoningEffort: config?.reasoningEffort,
      };
    }
  }

  // Direct mode (generic provider env var — fallback for single-provider agents)
  const providerKey = process.env[registry.apiKeyEnv];
  if (providerKey) {
    const baseUrl = process.env[registry.baseUrlEnv] ?? registry.defaultBaseUrl;
    return {
      type,
      apiKey: providerKey,
      baseUrl,
      isDirectMode: true,
      model: config?.model,
      reasoningEffort: config?.reasoningEffort,
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
