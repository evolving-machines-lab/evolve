/**
 * Test Configuration Utility
 *
 * Reads model and agent configuration from .env file.
 *
 * Required env vars:
 *   EVOLVE_API_KEY - API key for Evolve
 *   E2B_API_KEY or DAYTONA_API_KEY - API key for sandbox provider (at least one required)
 *
 * Optional env vars:
 *   TEST_AGENT_TYPE - Agent type for tests (if empty, Evolve resolves from env)
 *   CODEX_MODEL - Model for codex agent (default: gpt-5.1-codex)
 *   CODEX_REASONING_EFFORT - Reasoning effort for codex (default: medium)
 *   ANTHROPIC_MODEL - Model for claude agent (default: opus)
 *   ANTHROPIC_BETAS - Comma-separated beta headers for Claude (e.g., "context-1m-2025-08-07")
 *   GEMINI_MODEL - Model for gemini agent (default: gemini-3-pro-preview)
 *   QWEN_OPENAI_MODEL - Model for qwen agent (default: qwen3-coder-plus)
 */

import type { AgentType, SandboxProvider } from "../../dist/index.js";
import { createE2BProvider } from "../../../e2b/dist/index.js";
import { createDaytonaProvider } from "../../../daytona/dist/index.js";
import { createModalProvider } from "../../../modal/dist/index.js";

export interface AgentConfig {
  type: AgentType;
  apiKey: string;
  model: string;
  reasoningEffort?: "low" | "medium" | "high";
  betas?: string[];
}

export interface TestEnv {
  EVOLVE_API_KEY?: string;
  E2B_API_KEY?: string;
  DAYTONA_API_KEY?: string;
  MODAL_TOKEN_ID?: string;
  MODAL_TOKEN_SECRET?: string;
  // Direct mode keys
  ANTHROPIC_API_KEY?: string;
  OPENAI_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

/**
 * Get environment variables required for tests.
 * Supports both gateway mode (EVOLVE_API_KEY) and direct mode (provider API keys).
 */
export function getTestEnv(): TestEnv {
  const EVOLVE_API_KEY = process.env.EVOLVE_API_KEY;
  const E2B_API_KEY = process.env.E2B_API_KEY;
  const DAYTONA_API_KEY = process.env.DAYTONA_API_KEY;
  const MODAL_TOKEN_ID = process.env.MODAL_TOKEN_ID;
  const MODAL_TOKEN_SECRET = process.env.MODAL_TOKEN_SECRET;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

  // Need either gateway key or at least one provider key
  if (!EVOLVE_API_KEY && !ANTHROPIC_API_KEY && !OPENAI_API_KEY && !GEMINI_API_KEY) {
    throw new Error("Either EVOLVE_API_KEY or provider API keys (ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY) must be set");
  }
  if (!E2B_API_KEY && !DAYTONA_API_KEY && !(MODAL_TOKEN_ID && MODAL_TOKEN_SECRET)) {
    throw new Error("Either E2B_API_KEY, DAYTONA_API_KEY, or MODAL_TOKEN_ID+MODAL_TOKEN_SECRET must be set in .env");
  }

  return { EVOLVE_API_KEY, E2B_API_KEY, DAYTONA_API_KEY, MODAL_TOKEN_ID, MODAL_TOKEN_SECRET, ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY };
}

export type ProviderName = "e2b" | "modal" | "daytona";

/**
 * Get sandbox provider by name.
 * Throws if required env vars are missing.
 */
export function getSandboxProviderByName(name: ProviderName): SandboxProvider {
  switch (name) {
    case "e2b": {
      const apiKey = process.env.E2B_API_KEY;
      if (!apiKey) throw new Error("E2B_API_KEY required for e2b provider");
      return createE2BProvider({ apiKey });
    }
    case "daytona": {
      const apiKey = process.env.DAYTONA_API_KEY;
      if (!apiKey) throw new Error("DAYTONA_API_KEY required for daytona provider");
      return createDaytonaProvider({ apiKey });
    }
    case "modal": {
      if (!process.env.MODAL_TOKEN_ID || !process.env.MODAL_TOKEN_SECRET) {
        throw new Error("MODAL_TOKEN_ID and MODAL_TOKEN_SECRET required for modal provider");
      }
      return createModalProvider();
    }
    default:
      throw new Error(`Unknown provider: ${name}. Valid: e2b, modal, daytona`);
  }
}

/**
 * Get list of available providers based on env vars.
 */
export function getAvailableProviders(): ProviderName[] {
  const available: ProviderName[] = [];
  if (process.env.E2B_API_KEY) available.push("e2b");
  if (process.env.DAYTONA_API_KEY) available.push("daytona");
  if (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) available.push("modal");
  return available;
}

/**
 * Get sandbox provider based on available env vars.
 * Prefers E2B > Daytona > Modal.
 */
export function getSandboxProvider(): SandboxProvider {
  const available = getAvailableProviders();
  if (available.length === 0) {
    throw new Error("No sandbox provider available. Set E2B_API_KEY, DAYTONA_API_KEY, or MODAL_TOKEN_ID+MODAL_TOKEN_SECRET");
  }
  const name = available[0];
  console.log(`[test-config] Using ${name} sandbox provider`);
  return getSandboxProviderByName(name);
}

/**
 * Get the agent type from TEST_AGENT_TYPE env var.
 * Returns undefined if not set, letting Evolve resolve from env.
 */
export function getDefaultAgentType(): AgentType | undefined {
  const type = process.env.TEST_AGENT_TYPE;
  if (!type) return undefined;
  if (!["claude", "codex", "gemini", "qwen"].includes(type)) {
    throw new Error(`Invalid TEST_AGENT_TYPE: ${type}. Valid types: claude, codex, gemini, qwen`);
  }
  return type as AgentType;
}

/**
 * Get agent configuration for a specific agent type.
 * Uses EVOLVE_API_KEY (gateway) if available, falls back to provider keys (direct mode).
 */
export function getAgentConfig(type: AgentType): AgentConfig {
  const env = getTestEnv();

  switch (type) {
    case "claude":
      return {
        type: "claude",
        apiKey: env.EVOLVE_API_KEY || env.ANTHROPIC_API_KEY || "",
        model: process.env.ANTHROPIC_MODEL || "opus",
        betas: process.env.ANTHROPIC_BETAS?.split(",").map(b => b.trim()).filter(Boolean),
      };

    case "codex":
      return {
        type: "codex",
        apiKey: env.EVOLVE_API_KEY || env.OPENAI_API_KEY || "",
        model: process.env.CODEX_MODEL || "gpt-5.2",
        reasoningEffort: (process.env.CODEX_REASONING_EFFORT as "low" | "medium" | "high") || "medium",
      };

    case "gemini":
      return {
        type: "gemini",
        apiKey: env.EVOLVE_API_KEY || env.GEMINI_API_KEY || "",
        model: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
      };

    case "qwen":
      return {
        type: "qwen",
        apiKey: env.EVOLVE_API_KEY || env.OPENAI_API_KEY || "",
        model: process.env.QWEN_OPENAI_MODEL || "qwen3-coder-plus",
      };

    default:
      throw new Error(`Unknown agent type: ${type}`);
  }
}

/**
 * Get all agent configurations (for parallel testing)
 */
export function getAllAgentConfigs(): Record<AgentType, AgentConfig> {
  const types: AgentType[] = ["claude", "codex", "gemini", "qwen"];
  const configs: Record<string, AgentConfig> = {};

  for (const type of types) {
    configs[type] = getAgentConfig(type);
  }

  return configs as Record<AgentType, AgentConfig>;
}

/**
 * Get agent config from TEST_AGENT_TYPE env var.
 * Returns undefined if not set, letting Evolve resolve from env.
 */
export function getDefaultAgentConfig(): AgentConfig | undefined {
  const type = getDefaultAgentType();
  if (!type) return undefined;
  return getAgentConfig(type);
}
