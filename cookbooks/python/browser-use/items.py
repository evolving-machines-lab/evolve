"""Items, run configuration, and result saving for browser-use cookbook."""

import json
from datetime import datetime
from pathlib import Path
from typing import Any

from evolve import save_local_dir


def build_items(count: int = 3) -> list[dict[str, str]]:
    """Build items for HN post processing. Each worker gets a config.json file."""
    items: list[dict[str, str]] = []
    for rank in range(1, count + 1):
        page = ((rank - 1) // 30) + 1
        position_on_page = ((rank - 1) % 30) + 1
        items.append(
            {
                "config.json": json.dumps(
                    {"rank": rank, "page": page, "position_on_page": position_on_page}
                )
            }
        )
    return items


def setup_run_dir(items: list[dict[str, str]]) -> tuple[Path, Path, str]:
    """Create output directories and write run config. Returns (run_dir, posts_dir, started_at)."""
    started_at = datetime.now().strftime("%Y%m%d_%H%M%S")
    script_dir = Path(__file__).resolve().parent
    run_dir = script_dir / "output_browser_use" / f"hn_top_{len(items)}_multimodal_{started_at}"
    posts_dir = run_dir / "posts"
    posts_dir.mkdir(parents=True, exist_ok=True)

    (run_dir / "run_config.json").write_text(
        json.dumps(
            {
                "started_at": started_at,
                "count": len(items),
                "concurrency": 4,
                "mcp_server": "browser-use",
                "target": "https://news.ycombinator.com/news",
            },
            indent=2,
        )
    )

    return run_dir, posts_dir, started_at


def save_results(result: Any, items: list[dict[str, str]], posts_dir: Path, run_dir: Path, started_at: str) -> None:
    """Save pipeline results to local filesystem."""
    step_results = result.steps[0].results if result.steps else []
    index: dict[str, Any] = {"started_at": started_at, "count": len(items), "results": []}

    for i, r in enumerate(step_results):
        cfg = json.loads(items[i]["config.json"])
        rank = int(cfg["rank"])
        post_dir = posts_dir / f"{rank:03d}"

        save_local_dir(str(post_dir), r.files)

        data_json = r.data.model_dump() if r.data else None
        if data_json:
            (post_dir / "data.json").write_text(json.dumps(data_json, indent=2))
            if data_json.get("summary"):
                (post_dir / "summary.md").write_text(data_json["summary"])

        index["results"].append({
            "rank": rank,
            "status": r.status,
            "data": data_json,
            "error": r.error,
        })

    (run_dir / "index.json").write_text(json.dumps(index, indent=2))
