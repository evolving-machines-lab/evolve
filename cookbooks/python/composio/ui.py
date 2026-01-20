"""Cookbook UI helpers (prompt + output renderer).

Goal: keep `swarm.py` minimal. It should need only:
- `read_prompt()` for user input
- `make_renderer()` for streaming content output
"""

from __future__ import annotations

import asyncio
from rich.console import Console
from rich.console import Group
from rich.live import Live
from rich.markdown import Markdown
from rich.panel import Panel
from rich.spinner import Spinner
from rich.table import Table
from rich.text import Text
from rich.theme import Theme


theme = Theme({
    "info": "cyan",
    "warning": "magenta",
    "error": "bold red",
    "success": "bold green",
    "muted": "dim white",
    "thought": "dim italic",
    "tool": "dim cyan",
})

console = Console(theme=theme)


def _print_submitted_prompt(prompt: str, *, bg: str) -> None:
    width = getattr(console, "width", None) or 100
    h_pad = 2  # horizontal padding (left and right)
    prompt_style = f"bold fg:#00d75f on {bg}"
    text_style = f"fg:#ffffff on {bg}"
    fill_style = f"on {bg}"

    def emit(prefix: str, chunk: str) -> None:
        # Render a single physical terminal line with full-width background.
        t = Text(style=fill_style)
        t.append(" " * h_pad, style=fill_style)  # left pad
        t.append(prefix, style=prompt_style)
        t.append(chunk, style=text_style)
        pad = max(0, width - h_pad - len(prefix) - len(chunk) - h_pad)
        t.append(" " * (pad + h_pad), style=fill_style)  # right pad
        console.print(t, overflow="crop", no_wrap=True)

    def emit_pad() -> None:
        # Emit an empty padding row with full-width background.
        t = Text(" " * width, style=fill_style)
        console.print(t, overflow="crop", no_wrap=True)

    first_prefix = ""
    cont_prefix = ""

    emit_pad()  # pad above
    for raw_line in prompt.splitlines() or [""]:
        remaining = raw_line
        prefix = first_prefix
        while True:
            avail = max(1, width - h_pad * 2 - len(prefix))
            chunk, remaining = remaining[:avail], remaining[avail:]
            emit(prefix, chunk)
            if not remaining:
                break
            prefix = cont_prefix
    emit_pad()  # pad below


async def read_prompt(*, fallback_console: Console | None = console) -> str:
    """Read user input with a styled, full-width, multiline input bar.

    - Enter submits.
    - Esc then Enter inserts a newline (portable across terminals).
    """
    try:
        from prompt_toolkit.application import Application
        from prompt_toolkit.formatted_text import HTML
        from prompt_toolkit.key_binding import KeyBindings
        from prompt_toolkit.layout import Layout
        from prompt_toolkit.layout.containers import HSplit, Window
        from prompt_toolkit.layout.controls import FormattedTextControl
        from prompt_toolkit.output import create_output
        from prompt_toolkit.styles import Style
        from prompt_toolkit.widgets import TextArea
    except Exception:
        if fallback_console is None:
            raise
        return (await asyncio.to_thread(fallback_console.input, "[bold green]>[/bold green] ")).rstrip("\n")

    bg = "#303030"
    style = Style.from_dict({
        "inputbar": f"bg:{bg}",
        "prompt": f"bold fg:#00d75f bg:{bg}",
        "input": f"fg:#ffffff bg:{bg}",
        "hint": "fg:#666666",
    })

    text_area = TextArea(
        prompt=HTML("<prompt>&gt;</prompt> "),
        multiline=True,
        wrap_lines=True,
        style="class:input",
    )

    kb = KeyBindings()

    @kb.add("enter")
    def _submit(event) -> None:
        event.app.exit(result=text_area.text)

    @kb.add("escape", "enter")
    def _newline(event) -> None:
        text_area.buffer.insert_text("\n")

    def _max_input_lines() -> int:
        try:
            rows = create_output().get_size().rows
        except Exception:
            rows = 24
        # 2 pad lines + keep ~3 lines for context above.
        return max(1, rows - 5)

    def _input_height() -> int:
        return max(1, min(text_area.document.line_count, _max_input_lines()))

    input_window = Window(
        content=text_area.control,
        style="class:inputbar",
        height=_input_height,
        dont_extend_height=True,
    )

    pad = Window(
        content=FormattedTextControl(""),
        style="class:inputbar",
        height=1,
        dont_extend_height=True,
    )

    hint = Window(
        content=FormattedTextControl(HTML("<hint>  /q to quit</hint>")),
        style="class:hint",
        height=1,
        dont_extend_height=True,
    )

    input_bar = HSplit([pad, input_window, pad, hint])

    app = Application(
        layout=Layout(input_bar),
        key_bindings=kb,
        style=style,
        full_screen=False,
        erase_when_done=True,
    )

    prompt = ((await app.run_async()) or "").rstrip("\n")

    # Re-print the submitted prompt into the transcript so it is never clipped.
    # (The prompt_toolkit UI is erased on submit.) Keep the same "flat bar" style,
    # without adding borders/boxes.
    if prompt:
        _print_submitted_prompt(prompt, bg=bg)

    return prompt


class RichRenderer:
    """Renders ACP content events with incremental output (Claude Code style)."""

    def __init__(self, show_reasoning: bool = False):
        self.current_message = ""
        self.thought_buffer = ""
        self.tools = {}  # tool_id -> {info}
        self.tool_order = []  # ordered list of tool_ids
        self.show_reasoning = show_reasoning
        self.status_live: Live | None = None
        self._last_was_tool = False
        self._last_plan_str = ""
        self._has_content = False
        self._last_print_was_blank = False

    def _one_line(self, value: str, max_len: int = 120) -> str:
        if not isinstance(value, str):
            value = str(value)
        compact = " ".join(value.split())
        if len(compact) > max_len:
            return compact[: max_len - 3] + "..."
        return compact

    def reset(self):
        self._stop_status_live(final=False)
        self.current_message = ""
        self.thought_buffer = ""
        self.tools = {}
        self.tool_order = []
        self._last_was_tool = False
        self._last_plan_str = ""
        self._has_content = False
        self._last_print_was_blank = False

    def handle_event(self, event: dict):
        update = event.get("update", {})
        event_type = update.get("sessionUpdate")

        if event_type == "agent_message_chunk":
            self._handle_message(update)
        elif event_type == "agent_thought_chunk":
            self._handle_thought(update)
        elif event_type == "tool_call":
            self._handle_tool_call(update)
        elif event_type == "tool_call_update":
            self._handle_tool_update(update)
        elif event_type == "plan":
            self._handle_plan(update)

    def _handle_message(self, update: dict):
        content = update.get("content", {})
        if content.get("type") == "text":
            self.current_message += content.get("text", "")

    def _handle_thought(self, update: dict):
        content = update.get("content", {})
        if content.get("type") == "text":
            self.thought_buffer += content.get("text", "")

    def _handle_tool_call(self, update: dict):
        tool_id = update.get("toolCallId", "")
        title = update.get("title", "Tool")
        kind = update.get("kind", "other")
        raw_input = update.get("rawInput", {})
        status = update.get("status") or "pending"

        # Flush message first
        self._flush_message()

        # Upsert tool (some backends may emit tool_call multiple times per id)
        if tool_id not in self.tools:
            self.tool_order.append(tool_id)
            self.tools[tool_id] = {}
        self.tools[tool_id].update({
            'title': title,
            'kind': kind,
            'status': status,
            'raw_input': raw_input,
        })

        # Skip todo tools
        if title in ("write_todos", "TodoWrite") or "todo" in title.lower():
            return

        self._last_was_tool = True
        self._refresh_status_live()

    def _handle_tool_update(self, update: dict):
        tool_id = update.get("toolCallId", "")
        status = update.get("status")
        title = update.get("title")

        # Create placeholder if updates arrive out of order
        if tool_id not in self.tools:
            self.tool_order.append(tool_id)
            self.tools[tool_id] = {
                'title': title or "Tool",
                'kind': "other",
                'status': status or "pending",
                'raw_input': {},
            }

        old_status = self.tools[tool_id].get('status')
        if status is not None and old_status != status:
            self.tools[tool_id]['status'] = status
        if title:
            self.tools[tool_id]['title'] = title

        effective_title = self.tools[tool_id].get('title', '')
        if effective_title in ("write_todos", "TodoWrite") or "todo" in effective_title.lower():
            return

        self._refresh_status_live()

    def _handle_plan(self, update: dict):
        entries = update.get("entries", [])
        if not entries:
            return

        # Flush any buffered message before rendering plan updates.
        self._flush_message()

        lines = []
        for entry in entries:
            status = entry.get("status", "pending")
            content = entry.get("content", "")
            icon = {"completed": "✓", "in_progress": "→", "pending": "○"}.get(status, "○")
            lines.append(f"{icon} {content}")

        plan_str = "\n".join(lines)
        if plan_str == self._last_plan_str:
            return
        self._last_plan_str = plan_str

        styled_lines = []
        for entry in entries:
            status = entry.get("status", "pending")
            content = entry.get("content", "")
            icon = {"completed": "✓", "in_progress": "→", "pending": "○"}.get(status, "○")
            style = {"completed": "success", "in_progress": "info", "pending": "muted"}.get(status, "muted")
            styled_lines.append(f"[{style}]{icon} {content}[/{style}]")

        console.print(Panel("\n".join(styled_lines), title="[bold]Plan[/bold]", border_style="cyan", padding=(0, 1)))
        self._last_print_was_blank = False
        console.print()
        self._last_print_was_blank = True
        self._last_was_tool = False
        self._has_content = True
        self._refresh_status_live()

    def _should_display_tool(self, title: str) -> bool:
        if title in ("write_todos", "TodoWrite") or "todo" in title.lower():
            return False
        return True

    def _has_visible_tools(self) -> bool:
        for tool_id in self.tool_order:
            tool = self.tools.get(tool_id, {}) or {}
            title = tool.get('title', '') or ''
            if self._should_display_tool(title):
                return True
        return False

    def _format_tool_line(self, tool_id: str) -> Text:
        tool = self.tools[tool_id]
        title = tool.get('title', 'Tool')
        kind = tool.get('kind', 'other')
        status = tool.get('status', 'pending')
        raw_input = tool.get('raw_input', {}) or {}

        kind_labels = {
            "read": "Read", "edit": "Write", "execute": "Bash",
            "fetch": "Fetch", "search": "Search", "think": "Task", "switch_mode": "Mode",
        }

        content = self._get_tool_content(kind, raw_input, title)

        result = Text()
        dot_style = "success" if status == 'completed' else "error" if status == 'failed' else "tool"
        result.append("● ", style=dot_style)

        label = kind_labels.get(kind)
        if label:
            result.append(f"{label}(", style="white")
            result.append(self._one_line(content), style="dim white")
            result.append(")", style="white")
        else:
            result.append(f"{title}(", style="white")
            result.append(self._one_line(content), style="dim white")
            result.append(")", style="white")

        return result

    def _flush_message(self):
        if self.current_message.strip():
            if self._has_visible_tools() and not self._last_print_was_blank:
                console.print()
                self._last_print_was_blank = True

            console.print(Markdown(self.current_message))
            self._last_print_was_blank = False
            console.print()
            self._last_print_was_blank = True
            self.current_message = ""
            self._last_was_tool = False
            self._has_content = True
            self._refresh_status_live()

    def _get_tool_content(self, kind: str, raw_input: dict, title: str) -> str:
        raw_input = raw_input or {}
        if kind == "fetch":
            return raw_input.get("url") or raw_input.get("query") or title
        elif kind == "search":
            return raw_input.get("query") or raw_input.get("pattern") or raw_input.get("path") or title
        elif kind == "edit":
            return raw_input.get("file_path") or raw_input.get("path") or title
        elif kind == "read":
            return raw_input.get("file_path") or raw_input.get("absolute_path") or raw_input.get("path") or title
        elif kind == "execute":
            return raw_input.get("command") or title
        else:
            return (raw_input.get("command") or raw_input.get("query") or
                    raw_input.get("file_path") or raw_input.get("path") or
                    raw_input.get("instruction") or title)

    def _render_status(self, show_spinner: bool = True):
        lines = []
        for tool_id in self.tool_order:
            tool = self.tools.get(tool_id, {}) or {}
            title = tool.get('title', '') or ''
            if not self._should_display_tool(title):
                continue
            lines.append(self._format_tool_line(tool_id))

        if not show_spinner:
            return Group(*lines) if lines else Text("")

        spinner_table = Table.grid(padding=(0, 1))
        spinner_table.add_row(Spinner("dots", style="cyan"), Text("Working...", style="dim cyan"))

        if lines:
            lines.append(Text(""))
            lines.append(spinner_table)
            return Group(*lines)

        return spinner_table

    def _start_status_live(self):
        if self.status_live is not None:
            return
        self.status_live = Live(
            self._render_status(show_spinner=True),
            console=console,
            refresh_per_second=12,
            transient=False,
        )
        self.status_live.start()

    def _refresh_status_live(self):
        if self.status_live is None:
            return
        self.status_live.update(self._render_status(show_spinner=True), refresh=True)

    def _stop_status_live(self, *, final: bool):
        if self.status_live is None:
            return
        if final:
            self.status_live.update(self._render_status(show_spinner=False), refresh=True)
        self.status_live.stop()
        self.status_live = None

    def start_live(self):
        console.print()
        console.print("[bold cyan]Swarm[/bold cyan]")
        console.print()
        self._last_print_was_blank = True
        self._start_status_live()

    def stop_live(self):
        self._stop_status_live(final=True)

        if self.current_message.strip():
            if self._has_visible_tools():
                console.print()
                self._last_print_was_blank = True
            console.print(Markdown(self.current_message))
            self._last_print_was_blank = False

        if self.show_reasoning and self.thought_buffer.strip():
            console.print()
            console.print(Panel(
                Text(self.thought_buffer, style="thought"),
                title="[dim]Reasoning[/dim]",
                border_style="dim",
                padding=(0, 1),
            ))


def make_renderer(*, show_reasoning: bool = False) -> RichRenderer:
    """Create the Rich output renderer used for `agent.on("content", ...)`."""
    return RichRenderer(show_reasoning=show_reasoning)
