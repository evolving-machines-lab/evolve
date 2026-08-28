"""The analytic oracle behind this task's Li-Sn campaign.

MADE offers three oracles — ORB, MACE and Analytic. This task pins the **Analytic**
one so the whole campaign is deterministic, offline, and CPU-only. The energies
below are a documented surrogate, NOT a physical potential and NOT Materials
Project data: treat the numbers as this task's ground truth and nothing more.

Formation energy is a piecewise-linear well model over the composition fraction
x = n_Sn / (n_Li + n_Sn):

    E(x) = min_k ( -depth_k + SLOPE * |x - x_k| )

Stability is MADE's own criterion: a composition is stable when it sits on the
lower convex hull of E over x, i.e. its energy above hull is zero.
"""

from __future__ import annotations

import re

ELEMENTS = ("Li", "Sn")

# (composition fraction of Sn, well depth in eV/atom). The two endpoints are the
# elemental references and are zero by definition.
WELLS: tuple[tuple[float, float], ...] = (
    (0.0, 0.00),
    (0.2, 0.30),
    (0.4, 0.50),
    (0.5, 0.55),
    (0.75, 0.35),
    (1.0, 0.00),
)

SLOPE = 2.0
TOLERANCE = 1e-9

_TOKEN = re.compile(r"([A-Z][a-z]?)(\d*)")


class FormulaError(ValueError):
    pass


def parse_formula(formula: str) -> float:
    """Return the Sn composition fraction x for a formula like 'Li3Sn2'."""
    text = formula.strip()
    if not text:
        raise FormulaError("empty formula")

    counts: dict[str, int] = {}
    position = 0
    for match in _TOKEN.finditer(text):
        if match.start() != position:
            raise FormulaError(f"cannot parse {formula!r}")
        position = match.end()
        element, digits = match.group(1), match.group(2)
        if element not in ELEMENTS:
            raise FormulaError(f"{element} is not in the Li-Sn system")
        counts[element] = counts.get(element, 0) + (int(digits) if digits else 1)
    if position != len(text):
        raise FormulaError(f"cannot parse {formula!r}")

    total = sum(counts.values())
    if total == 0:
        raise FormulaError(f"{formula!r} has no atoms")
    return counts.get("Sn", 0) / total


def formation_energy(x: float) -> float:
    return min(-depth + SLOPE * abs(x - centre) for centre, depth in WELLS)


def _lower_hull() -> list[tuple[float, float]]:
    points = sorted((centre, -depth) for centre, depth in WELLS)
    hull: list[tuple[float, float]] = []
    for point in points:
        while len(hull) >= 2:
            (x1, y1), (x2, y2) = hull[-2], hull[-1]
            # Drop the middle point when it sits on or above the chord.
            if (x2 - x1) * (point[1] - y1) - (point[0] - x1) * (y2 - y1) <= 0:
                hull.pop()
            else:
                break
        hull.append(point)
    return hull


def hull_energy(x: float) -> float:
    hull = _lower_hull()
    for (x1, y1), (x2, y2) in zip(hull, hull[1:]):
        if x1 - TOLERANCE <= x <= x2 + TOLERANCE:
            if x2 - x1 < TOLERANCE:
                return min(y1, y2)
            return y1 + (y2 - y1) * (x - x1) / (x2 - x1)
    raise FormulaError(f"composition {x} is outside [0, 1]")


def energy_above_hull(x: float) -> float:
    return formation_energy(x) - hull_energy(x)


def is_stable(x: float) -> bool:
    return energy_above_hull(x) <= 1e-6
