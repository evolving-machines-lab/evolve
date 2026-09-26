/**
 * Prime Agent (`prime-agent --mode json`) parser — the pi-family core
 * (parsers/pi-family.ts) with Prime's own tool and session events.
 *
 * Prime Agent v0.9.6 replaced pi's tools with ONE model tool, `ipython
 * {code}` (packages/coding-agent/src/core/tools/ipython.ts:189-316): shell
 * commands run inside Python via `bash()`, MCP servers are reached from
 * Python (`await mcp.call_tool(...)`), skills are read with `open()`, and
 * sub-agents are spawned with `await rlm.spawn(...)` — all of it text in
 * `args.code` and `details.stdout`, with no separate tool event. The result's
 * `details` is IpythonToolDetails {status: ok|error|aborted|starting,
 * durationMs, stdout, stderr, errorEname?, error{ename,evalue,traceback}?,
 * kernelRestarted}; a Python exception leaves the wire's isError FALSE and
 * says `status: "error"` (round-2 E2b), so the profile reads that field.
 * Session-level events beyond the core (agent-session.ts:414-487):
 * session_action_update, rlm_child_update (a sub-agent's progress: id,
 * sessionName, status queued|running|done, tokenCount, answerPreview —
 * round-2 U1), auth_stale, compaction_*, thinking_level_changed,
 * service_tier_changed, ipython_sent_agent_message, rlm_progress_note,
 * recap_update, goal_update, bash_start/output/end, refine_complete/failed.
 * A sub-agent's reply reaches the parent as a `custom` message of type
 * agent_message (the core maps it to a user turn).
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
