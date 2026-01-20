/**
 * Cookbook UI helpers (prompt + output renderer).
 *
 * Goal: keep `swarm.ts` minimal. It should need only:
 * - `readPrompt()` for user input
 * - `makeRenderer()` for streaming content output
 */

import chalk from "chalk";
import logUpdate from "log-update";
import { marked, Renderer as MarkedRenderer } from "marked";
import { markedTerminal } from "marked-terminal";
import boxen from "boxen";
import { TextDecoder } from "node:util";

let configuredMarkdownWidth = 0;
function configureMarkdownRenderer(): void {
  const width = process.stdout.columns || 100;
  if (width === configuredMarkdownWidth) return;
  configuredMarkdownWidth = width;

  // Match Rich's "natural" markdown feel:
  // - respect terminal width
  // - don't print `###` prefixes for headings
  // - wrap table cells instead of overflowing
  // - marked-terminal v7 uses chalk.bold/italic by default for strong/em
  marked.use(
    markedTerminal({
      width,
      showSectionPrefix: false,
      reflowText: false,
      tableOptions: { wordWrap: true },
    }) as marked.MarkedExtension
  );

  // Fix marked-terminal bug: inline formatting (bold/italic) not working in list items.
  // The issue is that list items contain "text" tokens with nested inline tokens,
  // but marked-terminal's text renderer just uses the raw text instead of parsing
  // the nested tokens. This extension fixes that by properly rendering inline tokens.
  marked.use({
    renderer: {
      text(token: { text?: string; tokens?: unknown[] } | string): string {
        if (typeof token === "string") return token;
        // If this text token has nested inline tokens, parse them properly
        if (token.tokens && Array.isArray(token.tokens) && token.tokens.length > 0) {
          // Use the parser to render inline tokens (bold, italic, code, etc.)
          return (this as unknown as { parser: { parseInline: (tokens: unknown[]) => string } }).parser.parseInline(token.tokens);
        }
        return token.text ?? "";
      },
    } as Partial<MarkedRenderer>,
  });
}

// ─────────────────────────────────────────────────────────────
// Markdown rendering helper
// ─────────────────────────────────────────────────────────────

/**
 * Render markdown to terminal-formatted string.
 * Applies marked-terminal and fixes bullet points to use • instead of *.
 */
function renderMarkdown(content: string): string {
  configureMarkdownRenderer();
  let rendered = marked(content) as string;
  // Replace asterisk bullets with proper bullet dots (matching Python Rich)
  // Only match when followed by ANSI reset code [0m - this is the pattern
  // marked-terminal uses for list items. Code blocks don't have this pattern,
  // so they're safely preserved.
  rendered = rendered.replace(/^(\s*)\* (\x1b\[0m)/gm, "$1• $2");
  return rendered.trim();
}

// ─────────────────────────────────────────────────────────────
// Theme colors (matching Python Rich theme)
// ─────────────────────────────────────────────────────────────

const theme = {
  info: chalk.cyan,
  warning: chalk.magenta,
  error: chalk.bold.red,
  success: chalk.bold.green,
  muted: chalk.dim.white,
  thought: chalk.dim.italic,
  tool: chalk.dim.cyan,
};

// Spinner frames (matching Rich "dots" spinner)
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// ─────────────────────────────────────────────────────────────
// Console helpers
// ─────────────────────────────────────────────────────────────

export const console_ = {
  print: (msg: string = "") => console.log(msg),
  printSuccess: (msg: string) => console.log(theme.success(msg)),
  printMuted: (msg: string) => console.log(theme.muted(msg)),
  printInfo: (msg: string) => console.log(theme.info(msg)),
};

// ─────────────────────────────────────────────────────────────
// Prompt input
// ─────────────────────────────────────────────────────────────

export async function readPrompt(): Promise<string> {
  configureMarkdownRenderer();
  logUpdate.clear();
  logUpdate.done();

  const bgHex = "#303030";
  const prefixColor = "#00d75f";

  const width = process.stdout.columns || 100;
  const bg = chalk.bgHex(bgHex);

  function printSubmittedPrompt(prompt: string) {
    const hPad = 2; // horizontal padding (left and right)
    const availWidth = Math.max(1, width - hPad * 2);
    const leftPad = " ".repeat(hPad);
    const fullPad = bg(" ".repeat(width));

    console.log(fullPad); // pad above
    const lines = prompt.split(/\r?\n/);
    for (const line of lines) {
      const chunks = line.length > availWidth
        ? line.match(new RegExp(`.{1,${availWidth}}`, "g")) ?? [line]
        : [line];
      for (const chunk of chunks) {
        const rightPadLen = Math.max(0, width - hPad - chunk.length - hPad);
        console.log(bg(leftPad + chunk + " ".repeat(rightPadLen + hPad)));
      }
    }
    console.log(fullPad); // pad below
  }

  // Raw-input prompt bar (non-fullscreen) to match Python prompt_toolkit UX.
  // - full-width gray background
  // - multiline wrap, grows as needed
  // - bracketed paste support (no accidental submit)
  // - Enter submits, Esc+Enter inserts newline
  return await new Promise<string>((resolve) => {
    const stdin = process.stdin;
    const wasRaw = (stdin as any).isRaw;
    const decoder = new TextDecoder("utf-8", { fatal: false });

    let escArmed = false;
    let pasteMode = false;
    let pasteEndedThisChunk = false; // Delay pasteMode=false until after processing
    let pending = ""; // carry partial escape sequences across chunks
    let textValue = "";
    let cursorIndex = 0;

    const PASTE_START = "\u001b[200~";
    const PASTE_END = "\u001b[201~";

    const promptPrefix = bg(chalk.hex(prefixColor).bold("> "));
    const indentPrefix = bg("  ");

    function cleanup() {
      try {
        logUpdate.clear();
        logUpdate.done();
      } catch {
        // ignore
      }
      try {
        if (process.stdout.isTTY) process.stdout.write("\u001b[?2004l");
      } catch {
        // ignore
      }
      try {
        if (stdin.isTTY) stdin.setRawMode(Boolean(wasRaw));
      } catch {
        // ignore
      }
      try {
        stdin.pause();
      } catch {
        // ignore
      }
    }

    function wrapVisualLines(text: string): string[] {
      const lines = text.split("\n");
      const visual: string[] = [];
      const avail = Math.max(1, width - 2);
      for (const line of lines) {
        if (line.length === 0) {
          visual.push("");
          continue;
        }
        for (let i = 0; i < line.length; i += avail) {
          visual.push(line.slice(i, i + avail));
        }
      }
      return visual;
    }

    function layoutWithCursor(value: string, cursor: number): { lines: string[]; cursorLine: number; cursorCol: number } {
      const avail = Math.max(1, width - 2);
      const clamped = Math.max(0, Math.min(cursor, value.length));

      const lines: string[] = [""];
      let lineIndex = 0;
      let col = 0;
      let cursorLine = 0;
      let cursorCol = 0;

      for (let i = 0; i <= value.length; i++) {
        if (i === clamped) {
          cursorLine = lineIndex;
          cursorCol = col;
        }

        if (i === value.length) break;
        const ch = value[i]!;

        if (ch === "\n") {
          lines.push("");
          lineIndex++;
          col = 0;
          continue;
        }

        if (col >= avail) {
          lines.push("");
          lineIndex++;
          col = 0;
        }

        lines[lineIndex] += ch;
        col++;
      }

      // If cursor lands exactly on a wrap boundary, show it on the next line.
      if (cursorCol >= avail) {
        lines.push("");
        cursorLine++;
        cursorCol = 0;
      }

      return { lines, cursorLine, cursorCol };
    }

    function deleteBeforeCursor(): void {
      if (cursorIndex <= 0) return;
      textValue = textValue.slice(0, cursorIndex - 1) + textValue.slice(cursorIndex);
      cursorIndex -= 1;
    }

    function deleteAtCursor(): void {
      if (cursorIndex >= textValue.length) return;
      textValue = textValue.slice(0, cursorIndex) + textValue.slice(cursorIndex + 1);
    }

    function insertAtCursor(s: string): void {
      if (!s) return;
      textValue = textValue.slice(0, cursorIndex) + s + textValue.slice(cursorIndex);
      cursorIndex += s.length;
    }

    function moveHome(): void {
      const prevNl = textValue.lastIndexOf("\n", Math.max(0, cursorIndex - 1));
      cursorIndex = prevNl === -1 ? 0 : prevNl + 1;
    }

    function moveEnd(): void {
      const nextNl = textValue.indexOf("\n", cursorIndex);
      cursorIndex = nextNl === -1 ? textValue.length : nextNl;
    }

    function render() {
      const { lines, cursorLine, cursorCol } = layoutWithCursor(textValue, cursorIndex);

      const out: string[] = [];
      out.push(bg(" ".repeat(width))); // pad above
      const cursorBlockEmpty = chalk.bgWhite(" ");
      for (let i = 0; i < lines.length; i++) {
        const chunk = lines[i] ?? "";
        const prefix = i === 0 ? promptPrefix : indentPrefix;

        if (i === cursorLine) {
          const left = chunk.slice(0, cursorCol);
          const right = chunk.slice(cursorCol);
          const under = right.length > 0 ? right[0]! : " ";
          const cursorCell =
            right.length > 0 ? chalk.bgWhite.black(under) : cursorBlockEmpty;
          const rightRest = right.length > 0 ? right.slice(1) : "";
          const padLen = Math.max(0, width - 2 - left.length - rightRest.length - 1);
          out.push(
            prefix +
              bg(chalk.white(left)) +
              cursorCell +
              bg(chalk.white(rightRest)) +
              bg(" ".repeat(padLen))
          );
        } else {
          const padLen = Math.max(0, width - 2 - chunk.length);
          out.push(prefix + bg(chalk.white(chunk)) + bg(" ".repeat(padLen)));
        }
      }
      out.push(bg(" ".repeat(width))); // pad below
      out.push(chalk.dim("  /q to quit"));
      logUpdate(out.join("\n"));
    }

    function stripAndHandleEscapes(input: string): string {
      let s = pending + input;
      pending = "";
      pasteEndedThisChunk = false;

      // Preserve trailing partial sequences that might be paste markers.
      const maxMarker = Math.max(PASTE_START.length, PASTE_END.length);
      for (let k = Math.min(maxMarker - 1, s.length); k > 0; k--) {
        const tail = s.slice(-k);
        if (PASTE_START.startsWith(tail) || PASTE_END.startsWith(tail)) {
          pending = tail;
          s = s.slice(0, -k);
          break;
        }
      }

      // Handle bracketed paste markers.
      while (true) {
        const iStart = s.indexOf(PASTE_START);
        const iEnd = s.indexOf(PASTE_END);
        if (iStart === -1 && iEnd === -1) break;
        if (iStart !== -1 && (iEnd === -1 || iStart < iEnd)) {
          pasteMode = true;
          s = s.slice(0, iStart) + s.slice(iStart + PASTE_START.length);
          continue;
        }
        if (iEnd !== -1) {
          // Don't set pasteMode=false yet - delay until after processing content
          pasteEndedThisChunk = true;
          s = s.slice(0, iEnd) + s.slice(iEnd + PASTE_END.length);
        }
      }

      return s;
    }

    function handleCsiSequence(
      s: string,
      startIndex: number
    ): { consumed: number; seq: string | null } | null {
      // Consume CSI sequences: ESC [ ... finalByte
      if (s[startIndex] !== "\u001b") return null;
      if (s[startIndex + 1] !== "[") return null;
      for (let j = startIndex + 2; j < s.length; j++) {
        const ch = s[j]!;
        // Final byte is in range 0x40-0x7E, commonly letter or '~'
        const code = ch.charCodeAt(0);
        if (code >= 0x40 && code <= 0x7e) {
          return { consumed: j - startIndex + 1, seq: s.slice(startIndex, j + 1) };
        }
      }
      // Incomplete CSI, keep for next chunk.
      pending = s.slice(startIndex);
      return { consumed: s.length - startIndex, seq: null };
    }

    function submit() {
      stdin.off("data", onData);
      cleanup();
      const value = textValue.replace(/\n$/, "");
      textValue = "";
      cursorIndex = 0;
      if (value.length > 0) {
        printSubmittedPrompt(value);
        console.log();
      }
      resolve(value);
    }

    const onData = (chunk: Buffer) => {
      try {
        let text = decoder.decode(chunk, { stream: true });
        text = stripAndHandleEscapes(text);
        text = text.replace(/\r\n/g, "\n");

        for (let i = 0; i < text.length; i++) {
          const ch = text[i]!;

          // Ctrl-C
          if (ch === "\u0003") {
            stdin.off("data", onData);
            cleanup();
            process.exit(0);
          }

          // Escape sequences
          if (ch === "\u001b") {
            const csi = handleCsiSequence(text, i);
            if (csi) {
              // Interpret common cursor movement keys when not pasting.
              if (!pasteMode && csi.seq) {
                if (csi.seq === "\u001b[D") {
                  // Left
                  cursorIndex = Math.max(0, cursorIndex - 1);
                } else if (csi.seq === "\u001b[C") {
                  // Right
                  cursorIndex = Math.min(textValue.length, cursorIndex + 1);
                } else if (csi.seq === "\u001b[H" || csi.seq === "\u001b[1~" || csi.seq === "\u001b[7~") {
                  // Home
                  moveHome();
                } else if (csi.seq === "\u001b[F" || csi.seq === "\u001b[4~" || csi.seq === "\u001b[8~") {
                  // End
                  moveEnd();
                } else if (csi.seq === "\u001b[3~") {
                  // Delete
                  deleteAtCursor();
                }
                escArmed = false;
              }

              i += csi.consumed - 1;
              continue;
            }
            // Plain ESC (not CSI) arms newline mode
            if (!pasteMode) escArmed = true;
            continue;
          }

          // Backspace (DEL)
          if (ch === "\u007f") {
            escArmed = false;
            deleteBeforeCursor();
            continue;
          }

          // Enter / newline
          if (ch === "\r" || ch === "\n") {
            if (pasteMode || escArmed) {
              insertAtCursor("\n");
              escArmed = false;
              continue;
            }
            submit();
            return;
          }

          // Regular character
          insertAtCursor(ch);
          escArmed = false;
        }

        // Now that we've processed all characters, reset pasteMode if paste ended
        if (pasteEndedThisChunk) {
          pasteMode = false;
          pasteEndedThisChunk = false;
        }

        render();
      } catch {
        stdin.off("data", onData);
        cleanup();
        resolve("");
      }
    };

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    if (process.stdout.isTTY) process.stdout.write("\u001b[?2004h");
    render();
    stdin.on("data", onData);
  });
}

// ─────────────────────────────────────────────────────────────
// Renderer
// ─────────────────────────────────────────────────────────────

interface ToolInfo {
  title: string;
  kind: string;
  status: string;
  rawInput: Record<string, unknown>;
}

interface PlanEntry {
  status: string;
  content: string;
}

const KIND_LABELS: Record<string, string> = {
  read: "Read",
  edit: "Write",
  execute: "Bash",
  fetch: "Fetch",
  search: "Search",
  think: "Task",
  switch_mode: "Mode",
};

export class Renderer {
  private currentMessage = "";
  private thoughtBuffer = "";
  private tools: Map<string, ToolInfo> = new Map();
  private toolOrder: string[] = [];
  private showReasoning: boolean;
  private isLive = false;
  private spinnerFrame = 0;
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private lastPlanStr = "";
  private hasContent = false;
  private lastPrintWasBlank = false;

  constructor(showReasoning = false) {
    this.showReasoning = showReasoning;
  }

  private oneLine(value: unknown, maxLen = 120): string {
    const str = String(value ?? "");
    const compact = str.split(/\s+/).join(" ");
    if (compact.length > maxLen) {
      return compact.slice(0, maxLen - 3) + "...";
    }
    return compact;
  }

  reset(): void {
    this.stopLiveInternal(false);
    this.currentMessage = "";
    this.thoughtBuffer = "";
    this.tools.clear();
    this.toolOrder = [];
    this.lastPlanStr = "";
    this.hasContent = false;
    this.lastPrintWasBlank = false;
  }

  handleEvent(event: { update?: Record<string, unknown> }): void {
    const update = event.update ?? {};
    const eventType = update.sessionUpdate as string | undefined;

    if (eventType === "agent_message_chunk") {
      this.handleMessage(update);
    } else if (eventType === "agent_thought_chunk") {
      this.handleThought(update);
    } else if (eventType === "tool_call") {
      this.handleToolCall(update);
    } else if (eventType === "tool_call_update") {
      this.handleToolUpdate(update);
    } else if (eventType === "plan") {
      this.handlePlan(update);
    }
  }

  private handleMessage(update: Record<string, unknown>): void {
    const content = update.content as Record<string, unknown> | undefined;
    if (content?.type === "text") {
      this.currentMessage += (content.text as string) ?? "";
    }
  }

  private handleThought(update: Record<string, unknown>): void {
    const content = update.content as Record<string, unknown> | undefined;
    if (content?.type === "text") {
      this.thoughtBuffer += (content.text as string) ?? "";
    }
  }

  private handleToolCall(update: Record<string, unknown>): void {
    const toolId = (update.toolCallId as string) ?? "";
    const title = (update.title as string) ?? "Tool";
    const kind = (update.kind as string) ?? "other";
    const rawInput = (update.rawInput as Record<string, unknown>) ?? {};
    const status = (update.status as string) ?? "pending";

    // Flush message first
    this.flushMessage();

    // Upsert tool
    if (!this.tools.has(toolId)) {
      this.toolOrder.push(toolId);
    }
    this.tools.set(toolId, { title, kind, status, rawInput });

    // Skip todo tools (don't refresh for them)
    if (this.shouldSkipTool(title)) {
      return;
    }

    this.refreshLive();
  }

  private handleToolUpdate(update: Record<string, unknown>): void {
    const toolId = (update.toolCallId as string) ?? "";
    const status = update.status as string | undefined;
    const title = update.title as string | undefined;

    // Create placeholder if updates arrive out of order
    if (!this.tools.has(toolId)) {
      this.toolOrder.push(toolId);
      this.tools.set(toolId, {
        title: title ?? "Tool",
        kind: "other",
        status: status ?? "pending",
        rawInput: {},
      });
    }

    const tool = this.tools.get(toolId)!;
    if (status !== undefined && tool.status !== status) {
      tool.status = status;
    }
    if (title) {
      tool.title = title;
    }

    if (this.shouldSkipTool(tool.title)) {
      return;
    }

    this.refreshLive();
  }

  private handlePlan(update: Record<string, unknown>): void {
    const entries = (update.entries as PlanEntry[]) ?? [];
    if (entries.length === 0) return;

    // Flush any buffered message
    this.flushMessage();

    const lines: string[] = [];
    for (const entry of entries) {
      const status = entry.status ?? "pending";
      const content = entry.content ?? "";
      const icon = { completed: "✓", in_progress: "→", pending: "○" }[status] ?? "○";
      lines.push(`${icon} ${content}`);
    }

    const planStr = lines.join("\n");
    if (planStr === this.lastPlanStr) return;
    this.lastPlanStr = planStr;

    // Style the plan
    const styledLines: string[] = [];
    for (const entry of entries) {
      const status = entry.status ?? "pending";
      const content = entry.content ?? "";
      const icon = { completed: "✓", in_progress: "→", pending: "○" }[status] ?? "○";
      const style = {
        completed: theme.success,
        in_progress: theme.info,
        pending: theme.muted,
      }[status] ?? theme.muted;
      styledLines.push(style(`${icon} ${content}`));
    }

    // Clear live area, print plan, restart live
    this.clearLive();

    console.log(
      boxen(styledLines.join("\n"), {
        title: chalk.bold("Plan"),
        titleAlignment: "center",
        borderColor: "cyan",
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        width: process.stdout.columns ? Math.min(process.stdout.columns - 2, 100) : 100,
      })
    );
    this.lastPrintWasBlank = false;
    console.log();
    this.lastPrintWasBlank = true;
    this.hasContent = true;

    // Restart live area
    this.startLiveInternal();
  }

  private shouldSkipTool(title: string): boolean {
    return (
      title === "write_todos" ||
      title === "TodoWrite" ||
      title.toLowerCase().includes("todo")
    );
  }

  private hasVisibleTools(): boolean {
    for (const toolId of this.toolOrder) {
      const tool = this.tools.get(toolId);
      if (tool && !this.shouldSkipTool(tool.title)) {
        return true;
      }
    }
    return false;
  }

  private formatToolLine(toolId: string): string {
    const tool = this.tools.get(toolId)!;
    const { title, kind, status, rawInput } = tool;

    const content = this.getToolContent(kind, rawInput, title);

    const dotColor =
      status === "completed"
        ? theme.success
        : status === "failed"
        ? theme.error
        : theme.tool;

    const label = KIND_LABELS[kind];
    if (label) {
      return `${dotColor("●")} ${chalk.white(label)}(${theme.muted(this.oneLine(content))})`;
    }
    return `${dotColor("●")} ${chalk.white(title)}(${theme.muted(this.oneLine(content))})`;
  }

  private flushMessage(): void {
    if (this.currentMessage.trim()) {
      // Clear live area
      this.clearLive();

      if (this.hasVisibleTools() && !this.lastPrintWasBlank) {
        console.log();
        this.lastPrintWasBlank = true;
      }

      // Render markdown
      console.log(renderMarkdown(this.currentMessage));
      this.lastPrintWasBlank = false;
      console.log();
      this.lastPrintWasBlank = true;
      this.currentMessage = "";
      this.hasContent = true;

      // Restart live area
      this.startLiveInternal();
    }
  }

  private getToolContent(
    kind: string,
    rawInput: Record<string, unknown>,
    title: string
  ): string {
    if (kind === "fetch") {
      return (rawInput.url as string) ?? (rawInput.query as string) ?? title;
    } else if (kind === "search") {
      return (
        (rawInput.query as string) ??
        (rawInput.pattern as string) ??
        (rawInput.path as string) ??
        title
      );
    } else if (kind === "edit") {
      return (rawInput.file_path as string) ?? (rawInput.path as string) ?? title;
    } else if (kind === "read") {
      return (
        (rawInput.file_path as string) ??
        (rawInput.absolute_path as string) ??
        (rawInput.path as string) ??
        title
      );
    } else if (kind === "execute") {
      return (rawInput.command as string) ?? title;
    } else {
      return (
        (rawInput.command as string) ??
        (rawInput.query as string) ??
        (rawInput.file_path as string) ??
        (rawInput.path as string) ??
        (rawInput.instruction as string) ??
        title
      );
    }
  }

  private renderToolLines(): string[] {
    const lines: string[] = [];
    for (const toolId of this.toolOrder) {
      const tool = this.tools.get(toolId);
      if (!tool || this.shouldSkipTool(tool.title)) continue;
      lines.push(this.formatToolLine(toolId));
    }
    return lines;
  }

  private renderLive(showSpinner: boolean): string {
    const lines = this.renderToolLines();

    if (showSpinner) {
      const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length];
      // Spinner dot is bright cyan, "Working..." is dim cyan (matching Python Rich)
      const spinnerLine = `${theme.info(frame)} ${chalk.dim.cyan("Working...")}`;

      if (lines.length > 0) {
        lines.push(""); // blank line before spinner
        lines.push(spinnerLine);
      } else {
        lines.push(spinnerLine);
      }
    }

    return lines.join("\n");
  }

  private startLiveInternal(): void {
    if (this.isLive) return;
    this.isLive = true;

    // Start spinner animation
    this.spinnerInterval = setInterval(() => {
      this.spinnerFrame++;
      this.refreshLive();
    }, 80);

    this.refreshLive();
  }

  private refreshLive(): void {
    if (!this.isLive) return;
    logUpdate(this.renderLive(true));
  }

  private clearLive(): void {
    if (!this.isLive) return;

    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }

    // Clear and finalize - logUpdate.clear() alone doesn't work well with console.log()
    logUpdate("");
    logUpdate.done();
    this.isLive = false;
  }

  private stopLiveInternal(final: boolean): void {
    if (!this.isLive) return;

    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
    }

    if (final) {
      // Print final tool state (without spinner) and persist
      const lines = this.renderToolLines();
      if (lines.length > 0) {
        logUpdate(lines.join("\n"));
        logUpdate.done();
      } else {
        logUpdate("");
        logUpdate.done();
      }
    } else {
      logUpdate("");
      logUpdate.done();
    }

    this.isLive = false;
  }

  startLive(): void {
    console.log();
    console.log(chalk.bold.cyan("Swarm"));
    console.log();
    this.lastPrintWasBlank = true;
    this.startLiveInternal();
  }

  stopLive(): void {
    this.stopLiveInternal(true);

    if (this.currentMessage.trim()) {
      if (this.hasVisibleTools()) {
        console.log();
        this.lastPrintWasBlank = true;
      }
      console.log(renderMarkdown(this.currentMessage));
      this.lastPrintWasBlank = false;
    }

    if (this.showReasoning && this.thoughtBuffer.trim()) {
      console.log();
      console.log(
        boxen(theme.thought(this.thoughtBuffer), {
          title: theme.muted("Reasoning"),
          borderColor: "gray",
          padding: { top: 0, bottom: 0, left: 1, right: 1 },
        })
      );
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────

export function makeRenderer(options: { showReasoning?: boolean } = {}): Renderer {
  return new Renderer(options.showReasoning ?? false);
}

// ─────────────────────────────────────────────────────────────
// Panel helper (for welcome message)
// ─────────────────────────────────────────────────────────────

export function printPanel(content: string, options: { borderColor?: string } = {}): void {
  console.log(
    boxen(content, {
      borderColor: options.borderColor ?? "cyan",
      padding: { top: 0, bottom: 0, left: 1, right: 1 },
    })
  );
}
