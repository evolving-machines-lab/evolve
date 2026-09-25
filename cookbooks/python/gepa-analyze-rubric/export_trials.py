"""Write a split's bundles out as a Harbor job folder, for a real analyzer run.

    python export_trials.py --data data/reward-hacking --split test --out exported/test

    # Harbor: finds trials by trial.log, writes analysis.json into each
    harbor analyze exported/test -p out/reward-hacking/prompt.txt -r out/reward-hacking/rubric.toml

    # Evolve: import the folder as a job, then analyze it
    evolve upload exported/test
    evolve analyze "$JOB_ID" -p out/reward-hacking/prompt.txt -r out/reward-hacking/rubric.toml --watch
    evolve analysis download "$ANALYSIS_ID" -o exported/test-evolve/   # once per analysis

    python evaluate.py --data data/reward-hacking --candidate out/reward-hacking \
        --real-results exported/test --real-candidate reward-hacking

Each trial gets result.json (with the keys `evolve upload` requires),
agent/trajectory.json (ATIF: tool messages fold into the preceding agent
step's observation), verifier/test-stdout.txt and trial.log; result.json
validates as Harbor's TrialResult. index.json maps trial folder names back to
bundle ids. A bundle's task files go to <out>.tasks/<trial>/, which
result.json points at, so `harbor analyze` reads them; sources without tasks
(TRACE) have none. `evolve upload` does not take that path: pass
`-d name@version` so it links the published task instead.
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

from bundles import read_dataset


def trial_name(bundle_id: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "__", bundle_id)


def atif(bundle: dict[str, Any]) -> dict[str, Any]:
    steps: list[dict[str, Any]] = []
    for s in bundle["trajectory"]:
        source = s.get("source")
        if source == "tool" and steps and steps[-1]["source"] == "agent":
            obs = steps[-1].setdefault("observation", {"results": []})
            obs["results"].append({"content": s.get("message", "")})
            continue
        step: dict[str, Any] = {"step_id": len(steps) + 1, "source": source if source in ("system", "user", "agent") else "user", "message": s.get("message", "")}
        if s.get("tool_calls"):
            step["tool_calls"] = s["tool_calls"]
        if s.get("observation"):
            step["observation"] = {"results": [{"content": s["observation"]}]}
        steps.append(step)
    return {"schema_version": "ATIF-v1.4", "session_id": trial_name(bundle["id"]), "agent": {"name": "unknown", "version": ""}, "steps": steps}


def write_task(task: dict[str, Any], task_dir: Path) -> None:
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / "instruction.md").write_text(task.get("instruction") or "")
    for rel, text in (task.get("files") or {}).items():
        (task_dir / rel).parent.mkdir(parents=True, exist_ok=True)
        (task_dir / rel).write_text(text)


def write_trial(bundle: dict[str, Any], job_dir: Path, tasks_dir: Path) -> str:
    name = trial_name(bundle["id"])
    d = job_dir / name
    (d / "agent").mkdir(parents=True, exist_ok=True)
    # Harbor's TrialResult needs a task path; it reads the task only if the path exists.
    task_path = (tasks_dir / name).resolve()
    if bundle.get("task"):
        write_task(bundle["task"], task_path)
    result: dict[str, Any] = {
        "task_name": name,
        "trial_name": name,
        "trial_uri": "",
        "task_id": {"path": str(task_path)},
        "task_checksum": "",
        "config": {"task": {"path": str(task_path)}},
        "agent_info": {"name": "unknown", "version": "", "model_info": {"name": "unknown"}},
    }
    res = bundle.get("result") or {}
    if res.get("reward") is not None:
        result["verifier_result"] = {"rewards": {"reward": res["reward"]}}
    if res.get("exception"):
        result["exception_info"] = {"exception_type": res["exception"], "exception_message": "", "exception_traceback": "", "occurred_at": "1970-01-01T00:00:00Z"}
    (d / "result.json").write_text(json.dumps(result, indent=2))
    (d / "agent" / "trajectory.json").write_text(json.dumps(atif(bundle), indent=2))
    if bundle.get("verifier_stdout"):
        (d / "verifier").mkdir(exist_ok=True)
        (d / "verifier" / "test-stdout.txt").write_text(bundle["verifier_stdout"])
    (d / "trial.log").write_text(f"exported from bundle {bundle['id']}\n")
    return name


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True)
    ap.add_argument("--split", default="test", choices=["train", "val", "test"])
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    job_dir = Path(args.out)
    job_dir.mkdir(parents=True, exist_ok=True)
    bundles = read_dataset(args.data, args.split)
    tasks_dir = job_dir.parent / f"{job_dir.name}.tasks"
    index = {write_trial(b, job_dir, tasks_dir): b["id"] for b in bundles}
    (job_dir / "index.json").write_text(json.dumps(index, indent=2))
    (job_dir / "config.json").write_text(json.dumps({"job_name": job_dir.name, "source": f"{args.data} ({args.split})"}, indent=2))
    (job_dir / "result.json").write_text(json.dumps({"n_total_trials": len(bundles)}, indent=2))
    (job_dir / "job.log").write_text(f"exported {len(bundles)} bundles\n")
    print(f"Wrote {len(bundles)} trials to {job_dir}")


if __name__ == "__main__":
    main()
