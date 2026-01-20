/**
 * Unified Parser Entry Point
 *
 * Routes NDJSON lines to the appropriate agent-specific parser.
 * Simple line-based parsing - no buffering needed since CLIs output complete JSON per line.
 */

import type { AgentType } from "../types";
import type { OutputEvent } from "./types";
import { createClaudeParser } from "./claude";
import { createCodexParser } from "./codex";
import { createGeminiParser } from "./gemini";
import { createQwenParser } from "./qwen";

// Re-export types for convenience
export type { OutputEvent } from "./types";

/** Parser function type */
export type AgentParser = (jsonLine: string) => OutputEvent[] | null;

/**
 * Create a parser instance for the given agent type.
 * Each Evolve instance should create its own parser for proper isolation.
 *
 * @param agentType - The agent type to create a parser for
 * @returns Parser function that takes NDJSON lines and returns OutputEvents
 */
export function createAgentParser(agentType: AgentType): AgentParser {
  switch (agentType) {
    case "claude":
      return createClaudeParser();

    case "codex":
      return createCodexParser();

    case "gemini":
      return createGeminiParser();

    case "qwen":
      return createQwenParser();

    default:
      return () => null;
  }
}

/**
 * Parse a single NDJSON line from any agent (creates new parser per call - use createAgentParser for efficiency)
 *
 * @param agentType - The agent type to parse for
 * @param line - Single line of NDJSON output
 * @returns Array of OutputEvent objects, or null if line couldn't be parsed
 */
export function parseNdjsonLine(
  agentType: AgentType,
  line: string
): OutputEvent[] | null {
  // Skip empty lines
  const trimmed = line.trim();
  if (!trimmed) {
    return null;
  }

  // Create parser and parse (note: creates new parser instance - use createAgentParser for multi-line parsing)
  const parser = createAgentParser(agentType);
  return parser(trimmed);
}

/**
 * Parse multiple NDJSON lines (convenience wrapper)
 *
 * @param agentType - The agent type to parse for
 * @param output - Multi-line NDJSON output
 * @returns Array of all parsed OutputEvent objects
 */
export function parseNdjsonOutput(
  agentType: AgentType,
  output: string
): OutputEvent[] {
  const events: OutputEvent[] = [];
  const lines = output.split("\n");
  const parser = createAgentParser(agentType);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parsed = parser(trimmed);
    if (parsed) {
      events.push(...parsed);
    }
  }

  return events;
}

// Re-export parser factory functions for direct use if needed
export { createClaudeParser } from "./claude";
export { createCodexParser } from "./codex";
export { createGeminiParser } from "./gemini";
export { createQwenParser, parseQwenOutput } from "./qwen";
