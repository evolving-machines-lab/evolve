/**
 * Prime Agent profile over the pi-family core: one tool, `ipython {code}`
 * (shell, MCP, skills and sub-agents all run inside the cell), whose result
 * `details.status` — not the wire's isError — says whether the cell failed.
 */

import { createPiFamilyParser, stringField, type PiToolDescription } from "./pi-family";
import type { OutputEvent, ToolCallContent } from "./types";

/** Prime's session-level events beyond the core loop, as typed at v0.9.6. */
const PRIME_KNOWN_EVENTS: ReadonlySet<string> = new Set([
  "session_action_update",
  "compaction_start",
  "compaction_end",
  "session_info_changed",
  "thinking_level_changed",
  "service_tier_changed",
  "auth_stale",
  "ipython_sent_agent_message",
  "rlm_child_update",
  "rlm_progress_note",
  "recap_update",
  "goal_update",
  "bash_start",
  "bash_output",
  "bash_end",
  "refine_complete",
  "refine_failed",
]);

export function createPrimeAgentParser(): (jsonLine: string) => OutputEvent[] | null {
  return createPiFamilyParser({
    harness: "prime-agent",
    describeTool: describePrimeTool,
    toolFailed: primeToolFailed,
    knownEvents: PRIME_KNOWN_EVENTS,
  });
}

/** A cell that raised leaves isError false; `details.status` is the verdict (round-2 E2b). */
function primeToolFailed(_toolName: string, details: Record<string, unknown> | null, isError: boolean): boolean {
  if (isError) return true;
  return details !== null && details.status === "error";
}

function describePrimeTool(toolName: string, args: Record<string, unknown>): PiToolDescription {
  const content: ToolCallContent[] = [];
  if (toolName === "ipython") {
    const code = stringField(args, "code");
    if (code) content.push({ type: "content", content: { type: "text", text: code } });
    // The cell's first line is the title; the whole cell rides content.
    const firstLine = code.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "";
    return { title: firstLine ? `ipython ${firstLine}` : "ipython", kind: "execute", locations: [], content };
  }
  return { title: toolName, kind: "other", locations: [], content };
}
