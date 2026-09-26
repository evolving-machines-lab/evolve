/**
 * MCP Configuration Module
 *
 * Unified entry point for writing MCP server configs.
 * Routes to the appropriate writer based on agent type.
 */

import type { AgentType, SandboxInstance, McpServerConfig } from "../types";
import {
  writeClaudeMcpConfig,
  writeGeminiMcpConfig,
  writeQwenMcpConfig,
  writeKimiMcpConfig,
  writeOpenCodeMcpConfig,
  writeDroidMcpConfig,
  writePiMcpConfig,
  writePrimeAgentMcpConfig,
} from "./json";
import { writeCodexMcpConfig } from "./toml";

/**
 * Write MCP server configuration for an agent
 *
 * Routes to the appropriate config writer based on agent type:
 * - Claude: JSON to ${workingDir}/.mcp.json + ~/.claude/settings.json
 * - Codex: TOML to ~/.codex/config.toml
 * - Gemini: JSON to ~/.gemini/settings.json
 * - Qwen: JSON to ~/.qwen/settings.json
 * - Droid: JSON to ${workingDir}/.factory/mcp.json
 * - OpenCode: JSON to ${workingDir}/opencode.json (mcp key)
 * - pi: JSON to ~/.pi/agent/mcp.json (the pi-mcp-adapter extension's file)
 * - Prime Agent: JSON to ~/.prime/agent/settings.json (mcpServers key)
 */
export async function writeMcpConfig(
  agentType: AgentType,
  sandbox: SandboxInstance,
  workingDir: string,
  servers: Record<string, McpServerConfig>,
  homeDir?: string
): Promise<void> {
  if (!servers || Object.keys(servers).length === 0) {
    return;
  }

  switch (agentType) {
    case "claude":
      await writeClaudeMcpConfig(sandbox, workingDir, servers, homeDir);
      break;

    case "codex":
      await writeCodexMcpConfig(sandbox, servers, homeDir);
      break;

    case "gemini":
      await writeGeminiMcpConfig(sandbox, servers, homeDir);
      break;

    case "qwen":
      await writeQwenMcpConfig(sandbox, servers, homeDir);
      break;

    case "kimi":
      await writeKimiMcpConfig(sandbox, servers, homeDir);
      break;

    case "opencode":
      await writeOpenCodeMcpConfig(sandbox, workingDir, servers);
      break;

    case "droid":
      await writeDroidMcpConfig(sandbox, workingDir, servers);
      break;

    case "pi":
      await writePiMcpConfig(sandbox, servers, homeDir);
      break;

    case "prime-agent":
      await writePrimeAgentMcpConfig(sandbox, servers, homeDir);
      break;

    default:
      throw new Error(`Unknown agent type for MCP config: ${agentType}`);
  }
}

// Re-export individual writers for direct use if needed
export {
  writeClaudeMcpConfig,
  writeGeminiMcpConfig,
  writeQwenMcpConfig,
  writeKimiMcpConfig,
  writeOpenCodeMcpConfig,
  writeDroidMcpConfig,
  writePiMcpConfig,
  writePrimeAgentMcpConfig,
  writeJsonSpendHeaders,
  writeQwenThinkingConfig,
  writeDroidGatewaySettings,
  writeModelsJsonRoute,
  writeJsonSettingsStamp,
  PI_MCP_ADAPTER_SETTINGS,
  type ModelsJsonRouteWrite,
} from "./json";
export { writeCodexMcpConfig, writeCodexSpendProvider, writeKimiSpendConfig } from "./toml";
