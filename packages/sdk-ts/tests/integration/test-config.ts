/**
 * Test Configuration Utility
 *
 * Reads model and agent configuration from .env file.
 *
 * Required env vars:
 *   EVOLVE_API_KEY - API key for Evolve
 *   E2B_API_KEY - API key for E2B sandbox
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

import type { AgentType } from "../../dist/index.js";

export interface AgentConfig {
  type: AgentType;
  apiKey: string;
  model: string;
  reasoningEffort?: "low" | "medium" | "high";
  betas?: string[];
}

export interface TestEnv {
  EVOLVE_API_KEY: string;
  E2B_API_KEY: string;
}

/**
 * Get environment variables required for tests
 */
export function getTestEnv(): TestEnv {
  const EVOLVE_API_KEY = process.env.EVOLVE_API_KEY;
  const E2B_API_KEY = process.env.E2B_API_KEY;

  if (!EVOLVE_API_KEY) {
    throw new Error("EVOLVE_API_KEY not set in .env");
  }
  if (!E2B_API_KEY) {
    throw new Error("E2B_API_KEY not set in .env");
  }

  return { EVOLVE_API_KEY, E2B_API_KEY };
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
 * Get agent configuration for a specific agent type
 */
export function getAgentConfig(type: AgentType): AgentConfig {
  const env = getTestEnv();

  switch (type) {
    case "claude":
      return {
        type: "claude",
        apiKey: env.EVOLVE_API_KEY,
        model: process.env.ANTHROPIC_MODEL || "opus",
        betas: process.env.ANTHROPIC_BETAS?.split(",").map(b => b.trim()).filter(Boolean),
      };

    case "codex":
      return {
        type: "codex",
        apiKey: env.EVOLVE_API_KEY,
        model: process.env.CODEX_MODEL || "gpt-5.2",
        reasoningEffort: (process.env.CODEX_REASONING_EFFORT as "low" | "medium" | "high") || "medium",
      };

    case "gemini":
      return {
        type: "gemini",
        apiKey: env.EVOLVE_API_KEY,
        model: process.env.GEMINI_MODEL || "gemini-3-pro-preview",
      };

    case "qwen":
      return {
        type: "qwen",
        apiKey: env.EVOLVE_API_KEY,
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
