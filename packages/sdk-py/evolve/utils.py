"""File utilities for Evolve SDK."""

import base64
import os
from pathlib import Path
from typing import Any, Dict, Union


def _filter_none(d: Dict[str, Any]) -> Dict[str, Any]:
    """Filter out None values from a dict. Used for building RPC params."""
    return {k: v for k, v in d.items() if v is not None}


def _encode_files_for_transport(
    files: Dict[str, Union[str, bytes]]
) -> Dict[str, Dict[str, str]]:
    """Encode files dict for JSON-RPC transport.

    Handles both text (str) and binary (bytes) content with appropriate encoding.
    Uses 'content' field consistently for both input and output files.
    """
    result = {}
    for name, file_content in files.items():
        if isinstance(file_content, bytes):
            result[name] = {
                'content': base64.b64encode(file_content).decode('utf-8'),
                'encoding': 'base64'
            }
        else:
            result[name] = {'content': file_content, 'encoding': 'text'}
    return result


def read_local_dir(local_path: str, recursive: bool = False) -> Dict[str, bytes]:
    """Read files from a local directory into a dict for upload.

    Args:
        local_path: Path to local directory
        recursive: Include subdirectories (default: False)

    Returns:
        Dict mapping relative paths to file content as bytes
    """
    result: Dict[str, bytes] = {}
    root = Path(local_path)

    paths = root.rglob('*') if recursive else root.iterdir()

    for p in paths:
        if p.is_file():
            result[str(p.relative_to(root))] = p.read_bytes()

    return result


def save_local_dir(local_path: str, files: Dict[str, Union[str, bytes]]) -> None:
    """Save files dict to a local directory, creating nested directories as needed.

    Args:
        local_path: Base directory to save files to
        files: Dict mapping relative paths to content (from get_output_files().files or other source)

    Example:
        >>> output = await agent.get_output_files(recursive=True)
        >>> save_local_dir('./output', output.files)
        # Creates: ./output/file.txt, ./output/subdir/nested.txt, etc.
    """
    for name, content in files.items():
        file_path = os.path.join(local_path, name)
        parent = os.path.dirname(file_path)

        # Create parent directories if needed
        if parent:
            os.makedirs(parent, exist_ok=True)

        # Write content
        if isinstance(content, bytes):
            with open(file_path, 'wb') as f:
                f.write(content)
        else:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write(content)
