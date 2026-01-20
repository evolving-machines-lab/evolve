"""Utilities for Hacker News Time Capsule pipeline."""

import json
from pathlib import Path


def save_intermediate(results, step_name: str) -> None:
    """Save intermediate results to intermediate/{step_name}/."""
    step_dir = Path(f"intermediate/{step_name}")
    step_dir.mkdir(parents=True, exist_ok=True)
    for r in results:
        item_dir = step_dir / f"item_{r.meta.item_index:02d}"
        item_dir.mkdir(exist_ok=True)
        (item_dir / "status.txt").write_text(r.status)
        # Save files (for fetch step: meta.json, article.txt, comments.json)
        if r.files:
            for name, content in r.files.items():
                if isinstance(content, bytes):
                    (item_dir / name).write_bytes(content)
                else:
                    (item_dir / name).write_text(content)
        # Save structured data (for analyze step: data.json)
        if r.data:
            data = r.data.model_dump() if hasattr(r.data, 'model_dump') else r.data
            (item_dir / "data.json").write_text(json.dumps(data, indent=2))
        if r.error:
            (item_dir / "error.txt").write_text(r.error)
