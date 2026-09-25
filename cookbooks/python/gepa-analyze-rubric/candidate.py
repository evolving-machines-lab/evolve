"""The thing GEPA edits: an analyzer prompt plus the rubric's guidance text.

A candidate is ``{"prompt": str, "rubric": json.dumps({name: guidance})}``.
Criterion names, their order and each ``description`` stay fixed, so the
result stays a drop-in rubric for ``evolve analyze -r/-p`` and
``harbor analyze -r/-p``. The guards reject a candidate that would break
either loader before it costs a judge call.
"""

from __future__ import annotations

import json
import string
import tomllib
from dataclasses import dataclass
from pathlib import Path

# The placeholders both analyzers fill (evolve: docs-evals/core-concepts/analyze;
# harbor: analyze/analyzer.py format_map). Anything else in braces is dropped.
PLACEHOLDERS = ("trial_path", "task_section", "criteria_guidance")


@dataclass(frozen=True)
class Criterion:
    name: str
    description: str
    guidance: str


@dataclass(frozen=True)
class Seed:
    prompt: str
    criteria: tuple[Criterion, ...]

    def candidate(self) -> dict[str, str]:
        return to_candidate(self.prompt, self.criteria)


def load_rubric(path: str | Path) -> tuple[Criterion, ...]:
    """Read a rubric in any format the analyzers accept: TOML, YAML or JSON."""
    path = Path(path)
    text = path.read_text()
    if path.suffix == ".toml":
        data = tomllib.loads(text)
    elif path.suffix in (".yaml", ".yml"):
        import yaml  # optional: only for YAML rubrics

        data = yaml.safe_load(text)
    else:
        data = json.loads(text)
    # `evolve analyze --show-defaults --json` wraps the rubric with the prompt.
    if "rubric" in data and "criteria" not in data:
        data = data["rubric"]
    criteria = tuple(Criterion(c["name"], c.get("description", ""), c["guidance"]) for c in data["criteria"])
    names = [c.name for c in criteria]
    if len(set(names)) != len(names):
        raise ValueError(f"{path}: criterion names must be unique, got {names}")
    return criteria


def load_seed(prompt_path: str | Path | None, rubric_path: str | Path | None, defaults_path: str | Path | None = None) -> Seed:
    """Build the seed from files, or from `evolve analyze --show-defaults --json` output."""
    if defaults_path:
        data = json.loads(Path(defaults_path).read_text())
        data = data.get("defaults", data)
        prompt = data["prompt"]
        criteria = tuple(Criterion(c["name"], c.get("description", ""), c["guidance"]) for c in data["rubric"]["criteria"])
        return Seed(prompt, criteria)
    if not prompt_path or not rubric_path:
        raise ValueError("pass both a prompt and a rubric, or an --seed-defaults file")
    return Seed(Path(prompt_path).read_text(), load_rubric(rubric_path))


def to_candidate(prompt: str, criteria: tuple[Criterion, ...]) -> dict[str, str]:
    return {"prompt": prompt, "rubric": json.dumps({c.name: c.guidance for c in criteria}, indent=2)}


def from_candidate(candidate: dict[str, str], seed: Seed) -> tuple[str, tuple[Criterion, ...]]:
    """The candidate's prompt and criteria, with the seed's names and descriptions."""
    guidance = json.loads(candidate["rubric"])
    return candidate["prompt"], tuple(Criterion(c.name, c.description, guidance[c.name]) for c in seed.criteria)


def _toml_string(value: str) -> str:
    # A JSON string literal is a valid TOML basic string: TOML accepts every
    # escape json.dumps emits (\" \\ \n \t \r \b \f \uXXXX).
    return json.dumps(value)


def rubric_toml(criteria: tuple[Criterion, ...]) -> str:
    blocks = []
    for c in criteria:
        blocks.append(
            "[[criteria]]\n"
            f"name = {_toml_string(c.name)}\n"
            f"description = {_toml_string(c.description)}\n"
            f"guidance = {_toml_string(c.guidance)}\n"
        )
    return "\n".join(blocks)


def write_candidate(candidate: dict[str, str], seed: Seed, out_dir: str | Path) -> Path:
    """Write prompt.txt + rubric.toml, the pair `evolve analyze -p/-r` loads."""
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    prompt, criteria = from_candidate(candidate, seed)
    (out / "prompt.txt").write_text(prompt if prompt.endswith("\n") else prompt + "\n")
    (out / "rubric.toml").write_text(rubric_toml(criteria))
    (out / "candidate.json").write_text(json.dumps(candidate, indent=2) + "\n")
    return out


def load_candidate_dir(path: str | Path, seed: Seed) -> dict[str, str]:
    """Read back a prompt.txt + rubric.toml pair as a candidate (names checked against the seed)."""
    path = Path(path)
    criteria = load_rubric(path / "rubric.toml")
    if [c.name for c in criteria] != [c.name for c in seed.criteria]:
        raise ValueError(f"{path}: criteria {[c.name for c in criteria]} differ from the seed's")
    return to_candidate((path / "prompt.txt").read_text(), criteria)


def _fields(text: str) -> list[str]:
    """Every {field} in a str.format template; raises ValueError on a stray brace."""
    return [field for _, field, _, _ in string.Formatter().parse(text) if field is not None]


def guard_violations(
    candidate: dict[str, str],
    seed: Seed,
    *,
    max_growth: float = 2.0,
    required_markers: tuple[str, ...] = ("CODES=", "STEP="),
) -> list[str]:
    """Why this candidate can't ship; empty when it can.

    - the rubric is a JSON map with exactly the seed's criterion names, in order
    - the prompt keeps every placeholder the seed uses and adds no others
      (a stray brace breaks str.format; an unknown field renders as nothing)
    - no guidance contains braces (the analyzers splice it into the prompt)
    - no part grows past `max_growth` times the seed's length
    - every marker the seed's guidance asks for (CODES=, STEP=) is still asked for
    """
    problems: list[str] = []
    prompt = candidate.get("prompt", "")

    try:
        fields = _fields(prompt)
    except ValueError as err:
        problems.append(f"prompt: unbalanced braces ({err}); write literal braces nowhere")
        fields = []
    seed_fields = set(_fields(seed.prompt))
    for name in sorted(seed_fields - set(fields)):
        problems.append(f"prompt: lost the {{{name}}} placeholder")
    for name in sorted(set(fields) - seed_fields):
        known = f" (only {', '.join('{' + p + '}' for p in PLACEHOLDERS)} are filled)" if name not in PLACEHOLDERS else ""
        problems.append(f"prompt: new placeholder {{{name}}}{known}")
    if len(prompt) > max_growth * len(seed.prompt):
        problems.append(f"prompt: {len(prompt)} chars, over {max_growth}x the seed's {len(seed.prompt)}")

    try:
        guidance = json.loads(candidate.get("rubric", ""))
    except json.JSONDecodeError as err:
        return problems + [f"rubric: not valid JSON ({err.msg})"]
    if not isinstance(guidance, dict) or not all(isinstance(v, str) for v in guidance.values()):
        return problems + ["rubric: must be a JSON object mapping criterion name to guidance text"]
    seed_names = [c.name for c in seed.criteria]
    if list(guidance) != seed_names:
        problems.append(f"rubric: criterion names must be exactly {seed_names} in that order, got {list(guidance)}")
    for c in seed.criteria:
        text = guidance.get(c.name)
        if text is None:
            continue
        if not text.strip():
            problems.append(f"rubric.{c.name}: empty guidance")
        if "{" in text or "}" in text:
            problems.append(f"rubric.{c.name}: contains a curly brace")
        if len(text) > max_growth * len(c.guidance):
            problems.append(f"rubric.{c.name}: {len(text)} chars, over {max_growth}x the seed's {len(c.guidance)}")
        for marker in required_markers:
            if marker in c.guidance and marker not in text:
                problems.append(f"rubric.{c.name}: no longer asks for {marker}")
    return problems
