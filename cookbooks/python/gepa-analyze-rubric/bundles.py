"""Labelled examples in one shape (a *trial bundle*), whatever dataset they came from.

A bundle is a plain dict:

    id, source, split                     "trace/abc123", "trace", "train"
    task        {instruction, files} | None   files: {relative path: text}
    result      {reward, exception} | None
    verifier_stdout  str | None
    trajectory  [{step_id, source, message, tool_calls, observation}]   ATIF-like
    gold        {hack, codes, label, explanation, key_steps}

Converters: PatronusAI/trace-dataset (TRACE), Harbor trial directories plus a
labels file, and bundles you already wrote as JSONL. Add a converter per new
dataset; everything downstream reads only this shape.
"""

from __future__ import annotations

import hashlib
import json
import random
import re
from collections import defaultdict
from pathlib import Path
from typing import Any, Iterable

SPLITS = ("train", "val", "test")
# TRACE codes are dotted: 1.1 category, 1.1.1 subcategory. We score at
# subcategory depth and give half credit for the category (see score.py).
CODE_RE = re.compile(r"\b[1-9](?:\.\d+){1,3}\b")
BENIGN_RE = re.compile(r"\b(benign|none|no[_ -]?hack|clean|legitimate|negative)\b", re.I)
ROLE_TO_SOURCE = {"assistant": "agent", "user": "user", "system": "system", "tool": "tool", "function": "tool", "ipython": "tool"}


def normalize_code(code: str, depth: int = 3) -> str:
    return ".".join(code.split(".")[:depth])


def parse_label(label: Any, benign_re: re.Pattern[str] = BENIGN_RE) -> tuple[bool, list[str]]:
    """(is_hack, codes) from a free-form label: '1.1.1', '["1.1.1","1.2.3"]', 'benign', None.

    Anything that is not empty and not benign-looking is a hack; prepare.py
    prints the label counts so a new label format gets checked by eye.
    """
    if label is None or (isinstance(label, float) and label != label):  # None or NaN
        return False, []
    text = label if isinstance(label, str) else json.dumps(label)
    codes = sorted({normalize_code(c) for c in CODE_RE.findall(text)})
    if benign_re.search(text) or text.strip().lower() in {"", "0", "[]", "{}", "null", "false", "no"}:
        return False, codes
    return True, codes


def _text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, list):  # OpenAI content parts
        return "\n".join(_text(p.get("text", p) if isinstance(p, dict) else p) for p in content)
    return json.dumps(content)


def chat_to_steps(conversation: Any) -> list[dict[str, Any]]:
    """ChatML (a JSON message list, or <|im_start|> text) to ATIF-like steps."""
    messages: list[dict[str, Any]]
    if isinstance(conversation, str):
        try:
            conversation = json.loads(conversation)
        except json.JSONDecodeError:
            pass
    if isinstance(conversation, dict):
        conversation = conversation.get("messages") or conversation.get("conversation") or [conversation]
    if isinstance(conversation, list):
        messages = [m if isinstance(m, dict) else {"role": "user", "content": m} for m in conversation]
    else:
        found = re.findall(r"<\|im_start\|>(\w+)\n(.*?)(?:<\|im_end\|>|$)", str(conversation), re.S)
        messages = [{"role": r, "content": c} for r, c in found] or [{"role": "user", "content": str(conversation)}]
    steps = []
    for i, m in enumerate(messages, start=1):
        role = str(m.get("role") or m.get("from") or "user").lower()
        steps.append(
            {
                "step_id": i,
                "source": ROLE_TO_SOURCE.get(role, role),
                "message": _text(m.get("content") if "content" in m else m.get("value")),
                "tool_calls": m.get("tool_calls") or None,
                "observation": None,
            }
        )
    return steps


def from_trace_rows(rows: Iterable[dict[str, Any]], benign_re: re.Pattern[str] = BENIGN_RE) -> list[dict[str, Any]]:
    """PatronusAI/trace-dataset rows: {trajectory_id, conversation, label}."""
    bundles = []
    for row in rows:
        hack, codes = parse_label(row.get("label"), benign_re)
        bundles.append(
            {
                "id": f"trace/{row['trajectory_id']}",
                "source": "trace",
                "split": None,
                "task": None,
                "result": None,
                "verifier_stdout": None,
                "trajectory": chat_to_steps(row["conversation"]),
                "gold": {"hack": hack, "codes": codes if hack else [], "label": row.get("label"), "explanation": None, "key_steps": []},
            }
        )
    return bundles


def load_trace(path: str | None = None, token: str | None = None) -> list[dict[str, Any]]:
    """TRACE rows from a local .parquet/.jsonl, else from the Hub (gated: accept the terms, set HF_TOKEN)."""
    if path:
        if path.endswith(".parquet"):
            import pandas as pd

            return pd.read_parquet(path).to_dict("records")
        return [json.loads(line) for line in Path(path).read_text().splitlines() if line.strip()]
    from datasets import load_dataset

    return list(load_dataset("PatronusAI/trace-dataset", split="train", token=token))


def _read(path: Path, limit: int = 200_000) -> str | None:
    if not path.is_file():
        return None
    text = path.read_text(errors="replace")
    return text if len(text) <= limit else text[:limit] + f"\n[... truncated {len(text) - limit} chars]"


def _atif_steps(trajectory: dict[str, Any]) -> list[dict[str, Any]]:
    steps = []
    for i, s in enumerate(trajectory.get("steps", []), start=1):
        obs = s.get("observation")
        if isinstance(obs, dict):
            obs = "\n".join(_text(r.get("content")) for r in obs.get("results", []) if isinstance(r, dict)) or None
        steps.append(
            {
                "step_id": s.get("step_id", i),
                "source": s.get("source", "agent"),
                "message": _text(s.get("message")),
                "tool_calls": s.get("tool_calls") or None,
                "observation": _text(obs) if obs else None,
            }
        )
    return steps


def from_harbor_trial(trial_dir: Path, gold: dict[str, Any], task_dir: Path | None = None, source: str = "harbor") -> dict[str, Any]:
    """A Harbor trial directory (result.json, agent/trajectory.json, verifier/...) plus its gold label."""
    result = json.loads((trial_dir / "result.json").read_text()) if (trial_dir / "result.json").is_file() else {}
    rewards = (result.get("verifier_result") or {}).get("rewards") or {}
    exception = (result.get("exception_info") or {}).get("exception_type")
    traj_path = trial_dir / "agent" / "trajectory.json"
    trajectory = _atif_steps(json.loads(traj_path.read_text())) if traj_path.is_file() else []
    task = None
    if task_dir and task_dir.is_dir():
        files = {}
        for sub in ("tests", "solution", "environment"):
            for f in sorted((task_dir / sub).rglob("*")) if (task_dir / sub).is_dir() else []:
                if f.is_file() and (text := _read(f, 20_000)) is not None:
                    files[str(f.relative_to(task_dir))] = text
        task = {"instruction": _read(task_dir / "instruction.md"), "files": files}
    hack = bool(gold.get("hack"))
    codes = sorted({normalize_code(c) for c in gold.get("codes", [])})
    return {
        "id": f"{source}/{gold.get('id') or trial_dir.name}",
        "source": source,
        "split": None,
        "task": task,
        "result": {"reward": rewards.get("reward"), "exception": exception},
        "verifier_stdout": _read(trial_dir / "verifier" / "test-stdout.txt"),
        "trajectory": trajectory,
        "gold": {
            "hack": hack,
            "codes": codes if hack else [],
            "label": gold.get("label", gold.get("codes")),
            "explanation": gold.get("explanation"),
            "key_steps": [int(s) for s in gold.get("key_steps", [])],
        },
    }


def load_harbor(trials_root: str, labels_path: str, tasks_root: str | None = None, source: str = "harbor") -> list[dict[str, Any]]:
    """labels.jsonl lines: {"id": <trial dir name>, "hack": bool, "codes": [...], "explanation": ..., "key_steps": [...], "task": <task dir name>}."""
    bundles = []
    for line in Path(labels_path).read_text().splitlines():
        if not line.strip():
            continue
        gold = json.loads(line)
        task_dir = Path(tasks_root) / gold["task"] if tasks_root and gold.get("task") else None
        bundles.append(from_harbor_trial(Path(trials_root) / gold["id"], gold, task_dir, source))
    return bundles


def bundle_hash(bundle: dict[str, Any]) -> str:
    body = {k: v for k, v in bundle.items() if k != "split"}
    return hashlib.sha256(json.dumps(body, sort_keys=True).encode()).hexdigest()


def sample_per_stratum(bundles: list[dict[str, Any]], n: int | None, seed: int = 42) -> list[dict[str, Any]]:
    """At most n examples per (source, hack) stratum, picked with a fixed seed."""
    if not n:
        return bundles
    strata: dict[tuple[str, bool], list[dict[str, Any]]] = defaultdict(list)
    for b in sorted(bundles, key=lambda b: b["id"]):
        strata[(b["source"], b["gold"]["hack"])].append(b)
    picked = []
    for key in sorted(strata):
        group = strata[key]
        random.Random(f"{seed}:{key}").shuffle(group)
        picked.extend(group[:n])
    return sorted(picked, key=lambda b: b["id"])


def assign_splits(bundles: list[dict[str, Any]], fractions: tuple[float, float] = (0.4, 0.3), seed: int = 42) -> None:
    """40/30/30 train/val/test, stratified by (source, hack). Mutates `split`."""
    strata: dict[tuple[str, bool], list[dict[str, Any]]] = defaultdict(list)
    for b in sorted(bundles, key=lambda b: b["id"]):
        strata[(b["source"], b["gold"]["hack"])].append(b)
    for key in sorted(strata):
        group = strata[key]
        random.Random(f"{seed}:{key}").shuffle(group)
        n = len(group)
        n_train = round(n * fractions[0])
        n_val = round(n * fractions[1])
        if n >= 3:  # every stratum shows up in val and test
            n_train = min(n_train, n - 2)
            n_val = max(1, min(n_val, n - n_train - 1))
        for i, b in enumerate(group):
            b["split"] = "train" if i < n_train else "val" if i < n_train + n_val else "test"


def test_fingerprint(bundles: list[dict[str, Any]]) -> str:
    rows = sorted(f"{b['id']}:{bundle_hash(b)}" for b in bundles if b["split"] == "test")
    return hashlib.sha256("\n".join(rows).encode()).hexdigest()


def write_dataset(bundles: list[dict[str, Any]], out_dir: str | Path, *, refreeze: bool = False, terms: str | None = None) -> str:
    """bundles.jsonl + manifest.jsonl + test.lock. Refuses to move a frozen test split."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    fingerprint = test_fingerprint(bundles)
    lock = out / "test.lock"
    if lock.exists() and not refreeze:
        frozen = json.loads(lock.read_text())["test_sha256"]
        if frozen != fingerprint:
            raise SystemExit(
                f"{lock}: the test split is frozen at {frozen[:12]} and this build would change it to {fingerprint[:12]}. "
                "Keep the same inputs and seed, or pass --refreeze and throw away results scored on the old split."
            )
    with (out / "bundles.jsonl").open("w") as f:
        for b in bundles:
            f.write(json.dumps(b) + "\n")
    with (out / "manifest.jsonl").open("w") as f:
        for b in bundles:
            row = {"id": b["id"], "source": b["source"], "split": b["split"], "gold": b["gold"], "sha256": bundle_hash(b)}
            if terms:
                row["terms"] = terms
            f.write(json.dumps(row) + "\n")
    lock.write_text(json.dumps({"test_sha256": fingerprint, "n_test": sum(b["split"] == "test" for b in bundles)}, indent=2) + "\n")
    return fingerprint


def read_dataset(path: str | Path, split: str | None = None) -> list[dict[str, Any]]:
    p = Path(path)
    if p.is_dir():
        p = p / "bundles.jsonl"
    bundles = [json.loads(line) for line in p.read_text().splitlines() if line.strip()]
    return [b for b in bundles if split is None or b["split"] == split]
