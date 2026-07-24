/**
 * Configuration Utilities
 */

import * as fs from "fs";
import type { AgentConfig, AgentType, ResolvedAgentConfig } from "../types";
import { DEFAULT_AGENT_TYPE, ENV_EVOLVE_API_KEY } from "../constants";
import { getAgentConfig } from "../registry";

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
