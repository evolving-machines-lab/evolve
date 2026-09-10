#!/usr/bin/env python3
"""The campaign oracle. Budgeted, deterministic, offline.

    python3 /app/oracle.py Li3Sn2 [more formulas ...]

Prints the formation energy of each formula and appends it to the campaign log.
MADE's closed loop is a stateful agent/oracle exchange under a fixed oracle
budget; a Harbor task hands the agent a container rather than an environment
server, so the loop is reconstructed here as a local CLI whose call budget is
enforced on disk and audited afterwards from the log.

The oracle reports formation energy ONLY. Whether a composition is on the convex
hull is the thing you are being asked to work out.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from made_model import FormulaError, formation_energy, parse_formula  # noqa: E402

BUDGET = 15


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2

    workdir = Path(os.environ.get("TASK_WORKDIR", "/app"))
    log = workdir / "campaign.jsonl"
    used = sum(1 for _ in log.open()) if log.is_file() else 0

    for formula in argv:
        if used >= BUDGET:
            print(f"oracle budget exhausted ({BUDGET} calls); no result for {formula}")
            return 1
        try:
            x = parse_formula(formula)
        except FormulaError as exc:
            # A rejected formula is not a measurement, so it does not cost budget.
            print(f"{formula}: {exc}")
            continue

        energy = formation_energy(x)
        used += 1
        with log.open("a") as handle:
            handle.write(json.dumps({"formula": formula, "x": x, "e_form": energy}) + "\n")
        remaining = BUDGET - used
        print(f"{formula}\tx={x:.4f}\te_form={energy:+.4f} eV/atom\t({remaining} calls left)")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
