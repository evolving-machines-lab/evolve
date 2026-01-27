/**
 * Configuration Utilities
 */

import * as fs from "fs";
import * as os from "os";
import type { AgentConfig, AgentType, ResolvedAgentConfig } from "../types";
import { DEFAULT_AGENT_TYPE, ENV_EVOLVE_API_KEY } from "../constants";
import { getAgentConfig } from "../registry";

/**
 * Resolve OAuth file input to JSON content.
 * Accepts either a file path (e.g., "~/.codex/auth.json") or raw JSON content.
 */
function resolveOAuthFile(input: string): string {
  const trimmed = input.trim();
  // If input looks like JSON, return as-is
  if (trimmed.startsWith("{")) {
    return trimmed;
  }
  // Otherwise treat as file path, expand ~ and read
  const expandedPath = trimmed.replace(/^~/, os.homedir());
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
    return { type, apiKey: config.oauthToken, isDirectMode: true, isOAuth: true, model: config.model, reasoningEffort: config.reasoningEffort, betas: config.betas };
  }

  // OAuth file (Codex/Gemini - ChatGPT Pro / Google AI subscriptions)
  if (config?.oauthFile) {
    if (type === "claude") {
      throw new Error(
        `oauthFile is not supported for claude agent. Use oauthToken instead.`
      );
    }
    if (!registry.oauthFilePath) {
      throw new Error(
        `oauthFile is not supported for ${type} agent.`
      );
    }
    const oauthFileContent = resolveOAuthFile(config.oauthFile);
    return { type, apiKey: "", isDirectMode: true, isOAuth: true, oauthFileContent, model: config.model, reasoningEffort: config.reasoningEffort, betas: config.betas };
  }

  // Provider API key (direct mode)
  if (config?.providerApiKey) {
    const baseUrl = config.providerBaseUrl ?? process.env[registry.baseUrlEnv] ?? registry.defaultBaseUrl;
    return { type, apiKey: config.providerApiKey, baseUrl, isDirectMode: true, model: config.model, reasoningEffort: config.reasoningEffort, betas: config.betas };
  }

  // Gateway API key (explicit)
  if (config?.apiKey) {
    return { type, apiKey: config.apiKey, isDirectMode: false, model: config.model, reasoningEffort: config.reasoningEffort, betas: config.betas };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // ENVIRONMENT VARIABLES (auto-resolve - gateway takes precedence)
  // ─────────────────────────────────────────────────────────────────────────

  // Gateway mode (EVOLVE_API_KEY) - preferred for observability & billing
  const evolveKey = process.env[ENV_EVOLVE_API_KEY];
  if (evolveKey) {
    return { type, apiKey: evolveKey, isDirectMode: false, model: config?.model, reasoningEffort: config?.reasoningEffort, betas: config?.betas };
  }

  // Direct mode (provider env var)
  const providerKey = process.env[registry.apiKeyEnv];
  if (providerKey) {
    const baseUrl = process.env[registry.baseUrlEnv] ?? registry.defaultBaseUrl;
    return { type, apiKey: providerKey, baseUrl, isDirectMode: true, model: config?.model, reasoningEffort: config?.reasoningEffort, betas: config?.betas };
  }

  // OAuth mode (Claude Max env var)
  if (registry.oauthEnv) {
    const oauthKey = process.env[registry.oauthEnv];
    if (oauthKey) {
      return { type, apiKey: oauthKey, isDirectMode: true, isOAuth: true, model: config?.model, reasoningEffort: config?.reasoningEffort, betas: config?.betas };
    }
  }

  // OAuth file mode (Codex/Gemini env var)
  if (registry.oauthFileEnv) {
    const oauthFileValue = process.env[registry.oauthFileEnv];
    if (oauthFileValue) {
      const oauthFileContent = resolveOAuthFile(oauthFileValue);
      return { type, apiKey: "", isDirectMode: true, isOAuth: true, oauthFileContent, model: config?.model, reasoningEffort: config?.reasoningEffort, betas: config?.betas };
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // NO KEY FOUND
  // ─────────────────────────────────────────────────────────────────────────

  const oauthHint = registry.oauthEnv
    ? `, oauthToken (Claude Max), or ${registry.oauthEnv}`
    : registry.oauthFileEnv
      ? `, oauthFile, or ${registry.oauthFileEnv}`
      : "";
  throw new Error(
    `No API key found for ${type}. Set apiKey (gateway), providerApiKey (direct)${oauthHint}, ` +
    `or ${ENV_EVOLVE_API_KEY} / ${registry.apiKeyEnv} env var.`
  );
}
