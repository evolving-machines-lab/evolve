"""Prompt templates for Swarm abstractions.

Prompts are stored as markdown files for easy editing.
They are loaded at import time using importlib.resources.
"""

from importlib import resources
from typing import Dict, Union


def _load_prompt(subdir: str, filename: str) -> str:
    """Load a prompt template from a .md file in a subdirectory."""
    return resources.files(__package__).joinpath(subdir, filename).read_text(encoding='utf-8')


# Load agent prompts (system prompts - goes into CLAUDE.md-like context)
JUDGE_PROMPT: str = _load_prompt('agent_md', 'judge.md')
VERIFY_PROMPT: str = _load_prompt('agent_md', 'verify.md')
REDUCE_PROMPT: str = _load_prompt('agent_md', 'reduce.md')

# Load user prompts (task prompts - passed to .run())
JUDGE_USER_PROMPT: str = _load_prompt('user', 'judge.md')
VERIFY_USER_PROMPT: str = _load_prompt('user', 'verify.md')
RETRY_FEEDBACK_PROMPT: str = _load_prompt('user', 'retry_feedback.md')


def apply_template(template: str, variables: Dict[str, str]) -> str:
    """Apply template variables to a template string.

    Replaces {{variable}} with the corresponding value from variables dict.

    Args:
        template: Template string with {{variable}} placeholders
        variables: Dict mapping variable names to values

    Returns:
        Template with placeholders replaced
    """
    result = template
    for key, value in variables.items():
        result = result.replace(f"{{{{{key}}}}}", value)
    return result


def build_file_tree(files: Dict[str, Union[str, bytes]]) -> str:
    """Build a formatted file tree string for judge context.

    Generates an ASCII tree representation of the files structure,
    with comments explaining the purpose of each section.

    Args:
        files: Dict mapping file paths to content

    Returns:
        Formatted file tree string
    """
    if not files:
        return "context/\n  (empty)"

    # Get unique top-level folders, sorted with worker_task first
    folders = sorted(
        set(path.split("/")[0] for path in files.keys()),
        key=lambda f: ("" if f == "worker_task" else f)
    )

    if not folders:
        return "context/\n  (empty)"

    # Check what exists in worker_task/
    has_system_prompt = "worker_task/system_prompt.txt" in files
    has_schema = "worker_task/schema.json" in files
    has_input = any(p.startswith("worker_task/input/") for p in files.keys())

    # Build entries with comments
    entries: list[tuple[str, str]] = []  # (line, comment)

    for i, folder in enumerate(folders):
        is_last_folder = i == len(folders) - 1
        folder_prefix = "└── " if is_last_folder else "├── "
        child_indent = "    " if is_last_folder else "│   "

        if folder == "worker_task":
            entries.append((f"{folder_prefix}{folder}/", "task given to workers"))

            # Build worker_task children (only show what exists)
            children: list[tuple[str, str]] = []
            if has_system_prompt:
                children.append(("system_prompt.txt", "worker system prompt"))
            children.append(("user_prompt.txt", "worker task prompt"))
            if has_schema:
                children.append(("schema.json", "expected output schema"))
            if has_input:
                children.append(("input/", "worker input files"))

            for j, (name, comment) in enumerate(children):
                is_last_child = j == len(children) - 1
                child_prefix = "└── " if is_last_child else "├── "
                entries.append((f"{child_indent}{child_prefix}{name}", comment))

        elif folder.startswith("candidate_"):
            idx = folder.replace("candidate_", "")
            entries.append((f"{folder_prefix}{folder}/", f"worker {idx} solution"))
        elif folder == "worker_output":
            entries.append((f"{folder_prefix}{folder}/", "output to verify"))
        elif folder.startswith("item_"):
            idx = folder.replace("item_", "")
            entries.append((f"{folder_prefix}{folder}/", f"input {idx}"))
        else:
            entries.append((f"{folder_prefix}{folder}/", ""))

    # Calculate max line width for alignment
    max_width = max(len(line) for line, _ in entries)

    # Build final output with aligned comments
    lines = ["context/"]
    for line, comment in entries:
        if comment:
            padding = " " * (max_width - len(line) + 3)
            lines.append(f"{line}{padding}# {comment}")
        else:
            lines.append(line)

    return "\n".join(lines)


__all__ = ['JUDGE_PROMPT', 'JUDGE_USER_PROMPT', 'VERIFY_PROMPT', 'VERIFY_USER_PROMPT', 'REDUCE_PROMPT', 'RETRY_FEEDBACK_PROMPT', 'apply_template', 'build_file_tree']
