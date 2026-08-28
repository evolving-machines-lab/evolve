#!/usr/bin/env python3
"""Grade one MADE-style closed-loop discovery campaign.

Reports MADE's continuous campaign statistics as named metrics AND a thresholded
binary primary reward. The threshold is a conversion decision, not something MADE
publishes — see the README beside this task.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from made_model import FormulaError, is_stable, parse_formula  # noqa: E402

BUDGET = 15
REQUIRED_DISCOVERIES = 3
TOTAL_STABLE = 4


def load_claims(path: Path) -> list[str]:
    try:
        payload = json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(payload, dict):
        payload = payload.get("stable_compounds", [])
    if not isinstance(payload, list):
        return []
    return [str(item) for item in payload if isinstance(item, str)]


def main() -> int:
    workdir = Path(os.environ.get("TASK_WORKDIR", "/app"))
    logs = Path(os.environ.get("LOGS_DIR", "/logs")) / "verifier"
    logs.mkdir(parents=True, exist_ok=True)

    claims = load_claims(workdir / "answer.json")

    # Distinct by COMPOSITION, not by string: Li2Sn2 and LiSn are one discovery.
    correct: set[float] = set()
    wrong = 0
    for formula in claims:
        try:
            x = parse_formula(formula)
        except FormulaError:
            wrong += 1
            continue
        if is_stable(x):
            correct.add(round(x, 9))
        else:
            wrong += 1

    log = workdir / "campaign.jsonl"
    calls = sum(1 for line in log.open() if line.strip()) if log.is_file() else 0

    found = len(correct)
    discovery_rate = found / TOTAL_STABLE
    precision = found / len(claims) if claims else 0.0
    within_budget = calls <= BUDGET

    payload = {
        # Continuous campaign statistics, in MADE's spirit.
        "discovery_rate": round(discovery_rate, 4),
        "precision": round(precision, 4),
        "n_stable_found": found,
        "n_incorrect_claims": wrong,
        "oracle_calls_used": calls,
        "within_oracle_budget": int(within_budget),
        # The primary reward is binary: continuous scores make a fine metric but a
        # poor verdict, so the threshold is declared once, here, and documented.
        "reward": int(found >= REQUIRED_DISCOVERIES and wrong == 0 and within_budget),
    }

    with (logs / "reward.json").open("w") as handle:
        json.dump(payload, handle, indent=2, sort_keys=True)

    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
