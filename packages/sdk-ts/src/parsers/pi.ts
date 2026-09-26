/**
 * pi (`pi --mode json`) parser — the pi-family core (parsers/pi-family.ts)
 * with pi's own tool set.
 *
 * pi 0.87.1's built-in tools (packages/coding-agent/src/core/tools/, live
 * capture 2026-09-25): `read {path, offset?, limit?}`, `write {path,
 * content}`, `edit {path, oldText, newText}`, `bash {command, timeout?}`,
 * and the off-by-default `grep`/`find`/`ls`. MCP is not in pi's core: it
 * rides the pi-mcp-adapter extension (2.37.0 pinned in the image), whose
 * calls arrive as the ONE proxy tool `mcp` — `{tool, args}` for a call,
 * `{search}`, `{server}`, `{}` for status — or, with directTools on, as
 * `<server>_<tool>`. An adapter failure (a tool that does not exist) comes
 * back with isError FALSE and `details.error` set (round-2 M1), so the
 * profile reads that field. pi's session-level events beyond the core:
 * agent_settled (silent, the terminal record), entry_appended,
 * queue_update, session_info_changed, thinking_level_changed,
 * compaction_start/end, summarization_retry_* (types read at tag v0.87.1,
 * agent-session.ts:164-206).
 */

import { asRecord, createPiFamilyParser, stringField, type PiToolDescription } from "./pi-family";
import type { OutputEvent, ToolCallContent, ToolCallLocation, ToolKind } from "./types";

const PI_TOOL_KINDS: Record<string, ToolKind> = {
  read: "read",
  write: "edit",
  edit: "edit",
  bash: "execute",
  grep: "search",
  find: "search",
  ls: "search",
  mcp: "other",
};

/** pi's session-level events beyond the core loop, as typed at v0.87.1. */
const PI_KNOWN_EVENTS: ReadonlySet<string> = new Set([
  "entry_appended",
  "queue_update",
  "session_info_changed",
  "thinking_level_changed",
  "compaction_start",
  "compaction_end",
  "summarization_retry_scheduled",
  "summarization_retry_attempt_start",
  "summarization_retry_finished",
]);

export function createPiParser(): (jsonLine: string) => OutputEvent[] | null {
  return createPiFamilyParser({
    harness: "pi",
    describeTool: describePiTool,
    toolFailed: piToolFailed,
    knownEvents: PI_KNOWN_EVENTS,
  });
}

/** The MCP adapter reports its own failures in `details.error`, never through isError (round-2 M1). */
function piToolFailed(toolName: string, details: Record<string, unknown> | null, isError: boolean): boolean {
  if (isError) return true;
  return toolName === "mcp" && details !== null && typeof details.error === "string" && details.error.length > 0;
}

function describePiTool(toolName: string, args: Record<string, unknown>): PiToolDescription {
  const kind = PI_TOOL_KINDS[toolName] ?? "other";
  const locations: ToolCallLocation[] = [];
  const content: ToolCallContent[] = [];
  const path = stringField(args, "path");

  switch (toolName) {
    case "read": {
      if (path) {
        const offset = args.offset;
        locations.push({
          path,
          // pi's read offset is a 1-based line number; ACP's line is 0-based.
          line: typeof offset === "number" && Number.isFinite(offset) ? Math.max(0, offset - 1) : undefined,
        });
      }
      return { title: path ? `read ${path}` : "read", kind, locations, content };
    }
    case "write": {
      if (path) {
        locations.push({ path });
        if (typeof args.content === "string") {
          content.push({ type: "diff", path, oldText: null, newText: args.content });
        }
      }
      return { title: path ? `write ${path}` : "write", kind, locations, content };
    }
    case "edit": {
      if (path) {
        locations.push({ path });
        if (typeof args.oldText === "string" || typeof args.newText === "string") {
          content.push({
            type: "diff",
            path,
            oldText: typeof args.oldText === "string" ? args.oldText : "",
            newText: typeof args.newText === "string" ? args.newText : "",
          });
        }
      }
      return { title: path ? `edit ${path}` : "edit", kind, locations, content };
    }
    case "bash": {
      const command = stringField(args, "command");
      if (command) content.push({ type: "content", content: { type: "text", text: command } });
      return { title: command ? `bash ${command}` : "bash", kind, locations, content };
    }
    case "grep":
    case "find":
    case "ls": {
      if (path) locations.push({ path });
      const pattern = stringField(args, "pattern");
      return { title: pattern ? `${toolName} ${pattern}` : path ? `${toolName} ${path}` : toolName, kind, locations, content };
    }
    case "mcp": {
      // The adapter's one proxy tool: which MCP tool it reaches (or which
      // search/listing) is in the arguments, so the title names it.
      const tool = stringField(args, "tool");
      const search = stringField(args, "search");
      const server = stringField(args, "server");
      const detail = tool ? tool : search ? `search ${search}` : server ? server : "";
      const nested = asRecord(args.args);
      if (nested) content.push({ type: "content", content: { type: "text", text: JSON.stringify(nested) } });
      return { title: detail ? `mcp ${detail}` : "mcp", kind, locations, content };
    }
    default:
      return { title: toolName, kind, locations, content };
  }
}
