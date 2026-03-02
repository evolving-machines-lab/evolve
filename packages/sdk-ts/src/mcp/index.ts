/**
 * MCP Configuration Module
 *
 * Unified entry point for writing MCP server configs.
 * Routes to the appropriate writer based on agent type.
 */

import type { AgentType, SandboxInstance, McpServerConfig } from "../types";
import { writeClaudeMcpConfig, writeGeminiMcpConfig, writeQwenMcpConfig, writeKimiMcpConfig, writeOpenCodeMcpConfig } from "./json";
import { writeCodexMcpConfig } from "./toml";

/**
 * Write MCP server configuration for an agent
 *
 * Routes to the appropriate config writer based on agent type:
 * - Claude: JSON to ${workingDir}/.mcp.json + ~/.claude/settings.json
 * - Codex: TOML to ~/.codex/config.toml
 * - Gemini: JSON to ~/.gemini/settings.json
 * - Qwen: JSON to ~/.qwen/settings.json
 * - OpenCode: JSON to ${workingDir}/opencode.json (mcp key)
 */
export async function writeMcpConfig(
  agentType: AgentType,
  sandbox: SandboxInstance,
  workingDir: string,
  servers: Record<string, McpServerConfig>
): Promise<void> {
  if (!servers || Object.keys(servers).length === 0) {
    return;
  }

  switch (agentType) {
    case "claude":
      await writeClaudeMcpConfig(sandbox, workingDir, servers);
      break;

    case "codex":
      await writeCodexMcpConfig(sandbox, servers);
      break;

    case "gemini":
      await writeGeminiMcpConfig(sandbox, servers);
      break;

    case "qwen":
      await writeQwenMcpConfig(sandbox, servers);
      break;

    case "kimi":
      await writeKimiMcpConfig(sandbox, servers);
      break;

    case "opencode":
      await writeOpenCodeMcpConfig(sandbox, workingDir, servers);
      break;

    default:
      throw new Error(`Unknown agent type for MCP config: ${agentType}`);
  }
}

// Re-export individual writers for direct use if needed
export { writeClaudeMcpConfig, writeGeminiMcpConfig, writeQwenMcpConfig, writeKimiMcpConfig, writeOpenCodeMcpConfig } from "./json";
export { writeCodexMcpConfig, writeCodexSpendProvider } from "./toml";
