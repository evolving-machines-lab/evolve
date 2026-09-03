"""Read, repair, and shrink an ATIF trajectory without lying about the trace.

Four transforms, applied in increasing order of cost to the reader:

  1. repair    - the hub sanitises some numeric fields to a bare [REDACTED]
                 token, which is not valid JSON. A plain json.load raises and,
                 in every pipeline that catches broadly, silently drops the
                 trial. Repair first, always.
  2. dedup     - `observation.results[].extra` re-states the observation's own
                 `content` (often twice), and `tool_calls[].extra.raw_arguments`
                 re-states `arguments`. Removing a string that is provably
                 recoverable from a sibling field costs the reader nothing.
  3. base64    - inline image payloads. Bytes, not reasoning.
  4. clip      - the only lossy step: per-observation head+tail truncation,
                 walked down a ladder until the file fits. Never touches a
                 step's `message` (the agent's reasoning) and never drops a
                 step, so the action sequence stays intact end to end.

Steps 1-3 are lossless for anything that reads the trace, so they run
unconditionally. Step 4 runs only if the file is still over budget.
"""
from __future__ import annotations

import json
import re
from typing import Any, Iterator

# Ladder and tail protection are inherited from the corpus normaliser, so a
# clipped upload and a locally rendered trace agree on what got elided.
BUDGET_LADDER = (20_000, 8_000, 4_000, 2_000, 1_000, 400)
TAIL_PROTECT_OBS = 8
TAIL_BUDGET_MULTIPLIER = 4

BASE64_KEYS = ("base64", "data")
BASE64_MIN_CHARS = 100_000
# Below this, a duplicated string is not worth a marker that says so.
DUP_MIN_CHARS = 200

_REDACTED = re.compile(r":\s*\[REDACTED\]")


def loads(text: str) -> Any:
    """json.loads with the [REDACTED] repair. Raises if it is still not JSON."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return json.loads(_REDACTED.sub(": null", text))


def observations(traj: Any) -> Iterator[dict]:
    """Each observation result dict, in trace order."""
    for step in traj.get("steps") or []:
        if not isinstance(step, dict):
            continue
        for r in (step.get("observation") or {}).get("results") or []:
            if isinstance(r, dict):
                yield r


def strip_duplicate_extra(traj: Any) -> dict:
    """Remove restatements of a sibling field. Provably lossless.

    A string under `extra` is removed only when it is a SUBSTRING of the
    content it sits beside — that is the proof it carries nothing new. A
    payload that merely looks redundant is left alone, so an unfamiliar
    harness cannot lose data here.
    """
    n_obs = n_args = 0
    freed = 0

    def prune(node: Any, content: str) -> Any:
        nonlocal n_obs, freed
        if isinstance(node, dict):
            return {k: prune(v, content) for k, v in node.items()}
        if isinstance(node, list):
            return [prune(v, content) for v in node]
        if isinstance(node, str) and len(node) >= DUP_MIN_CHARS and node in content:
            n_obs += 1
            freed += len(node)
            return f"[{len(node):,} chars identical to observation content, removed for upload]"
        return node

    for step in traj.get("steps") or []:
        if not isinstance(step, dict):
            continue
        for tc in step.get("tool_calls") or []:
            if not isinstance(tc, dict):
                continue
            extra = tc.get("extra")
            if (isinstance(extra, dict) and "raw_arguments" in extra
                    and extra["raw_arguments"] == tc.get("arguments")):
                freed += len(json.dumps(extra.pop("raw_arguments")))
                n_args += 1

    for r in observations(traj):
        content, extra = r.get("content"), r.get("extra")
        if isinstance(content, str) and content and extra is not None:
            r["extra"] = prune(extra, content)

    return {"observation_strings": n_obs, "raw_arguments": n_args,
            "chars_freed": freed}


def strip_base64(traj: Any) -> dict:
    """Replace inline base64 payloads with a byte count."""
    n = 0
    freed = 0

    def walk(o: Any) -> None:
        nonlocal n, freed
        if isinstance(o, dict):
            for k, v in list(o.items()):
                if k in BASE64_KEYS and isinstance(v, str) and len(v) > BASE64_MIN_CHARS:
                    o[k] = f"[{len(v):,} bytes of base64 stripped for upload]"
                    n += 1
                    freed += len(v)
                else:
                    walk(v)
        elif isinstance(o, list):
            for v in o:
                walk(v)

    walk(traj)
    return {"fields": n, "chars_freed": freed}


def _clip(text: str, budget: int, marker: str) -> str:
    if len(text) <= budget:
        return text
    head = budget * 2 // 3
    return text[:head] + marker.format(n=len(text) - budget) + text[-(budget - head):]


def clip_observations(traj: Any, target_bytes: int) -> int | None:
    """Walk the ladder until the encoded trajectory fits. Returns the rung used.

    Truncation is per observation and always head+tail, so the command that
    produced an observation and the verdict at its end both survive. The last
    TAIL_PROTECT_OBS observations get a larger budget because a failure's
    evidence is concentrated in the final verification and its output.
    """
    if len(json.dumps(traj).encode()) <= target_bytes:
        return None
    marker = ("\n... [{n:,} characters clipped to fit the "
              f"{target_bytes // (1024 * 1024)} MiB analysis budget] ...\n")
    obs = list(observations(traj))
    originals = [r.get("content") if isinstance(r.get("content"), str) else None
                 for r in obs]
    tail_from = max(0, len(obs) - TAIL_PROTECT_OBS)
    used = None
    for budget in BUDGET_LADDER:
        for i, (r, orig) in enumerate(zip(obs, originals)):
            if orig is None:
                continue
            b = budget * TAIL_BUDGET_MULTIPLIER if i >= tail_from else budget
            r["content"] = _clip(orig, b, marker)
        used = budget
        if len(json.dumps(traj).encode()) <= target_bytes:
            break
    return used


def compress(text: str, target_bytes: int) -> tuple[bytes, dict]:
    """Full pipeline. Returns (encoded trajectory, report)."""
    traj = loads(text)
    report = {"original_bytes": len(text.encode())}

    report["dedup"] = strip_duplicate_extra(traj)
    report["after_dedup_bytes"] = len(json.dumps(traj).encode())

    report["base64"] = strip_base64(traj)
    report["after_base64_bytes"] = len(json.dumps(traj).encode())

    report["obs_budget_chars"] = clip_observations(traj, target_bytes)

    out = json.dumps(traj).encode()
    report["final_bytes"] = len(out)
    report["lossy"] = report["obs_budget_chars"] is not None
    return out, report
