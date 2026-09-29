"""One candidate on one example: guards, pack, judge call, validate, score."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from candidate import Seed, from_candidate, guard_violations
from pack import render_system, render_user
from score import feedback, score_output


@dataclass
class Harness:
    seed: Seed
    judge: Any  # judge.LLM or judge.FakeJudge
    target: str = "evolve"
    flag_criteria: list[str] = field(default_factory=list)
    max_tokens: int = 40_000
    max_growth: float = 2.0

    def __post_init__(self) -> None:
        names = [c.name for c in self.seed.criteria]
        self.flag_criteria = self.flag_criteria or names
        unknown = set(self.flag_criteria) - set(names)
        if unknown:
            raise ValueError(f"--flag-criterion {sorted(unknown)} is not in the rubric {names}")

    def run(self, candidate: dict[str, str], bundle: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        """(record, side_info). A guard failure scores 0 without a model call."""
        problems = guard_violations(candidate, self.seed, max_growth=self.max_growth)
        if problems:
            rec = {"id": bundle["id"], "source": bundle["source"], "gold_hack": bundle["gold"]["hack"], "valid": False, "score": 0.0, "errors": problems, "guard": True}
            return rec, {"Guard violations (candidate scored 0 on every example)": problems}
        prompt, criteria = from_candidate(candidate, self.seed)
        system = render_system(prompt, criteria, has_task=bool(bundle.get("task")), target=self.target)
        user, packing = render_user(bundle, max_tokens=self.max_tokens)
        call = self.judge.complete([{"role": "system", "content": system}, {"role": "user", "content": user}], tag=bundle["id"])
        if call.error:
            rec = {"id": bundle["id"], "source": bundle["source"], "gold_hack": bundle["gold"]["hack"], "valid": False, "score": 0.0, "call_error": call.error, "cost": call.cost}
            return rec, {"Judge call failed (not the prompt's fault)": call.error}
        rec = score_output(call.text, bundle, [c.name for c in criteria], self.flag_criteria, self.target)
        rec.update(cost=call.cost, prompt_tokens=call.prompt_tokens, cached_tokens=call.cached_tokens, truncated=packing["truncated"])
        return rec, feedback(rec, bundle, packing)
