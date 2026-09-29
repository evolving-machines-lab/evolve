"""Score the seed and optimized candidates on a split (the held-out test split by default).

    python evaluate.py --data data/reward-hacking --candidate out/reward-hacking --repeats 3 \
        --judge-model openai/deepseek/deepseek-v4.1-flash --judge-model openai/zai/glm-5.3-flash \
        --report reports/reward-hacking.md

Every candidate runs on every example, for every judge model, `--repeats`
times. The report gives mean and range over repeats for score, balanced
accuracy, false-flag rate on benign trials and valid-output rate, results per
source, cost per trial, and the diff of each candidate against the seed.

Agreement with a real analyzer run: export the split with export_trials.py,
run `harbor analyze` (or `evolve upload` + `evolve analyze`) on it with a
candidate's files, then pass the folder holding the resulting analysis JSON
as --real-results and that candidate as --real-candidate.
"""

from __future__ import annotations

import argparse
import difflib
import json
import statistics
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

from bundles import read_dataset
from candidate import from_candidate, load_candidate_dir, load_seed
from harness import Harness
from judge import JUDGE_MODEL, LLM, FakeJudge, Log, Spend, api_key, is_peak
from score import metrics

HERE = Path(__file__).parent
KEYS = ("mean_score", "balanced_accuracy", "false_flag_rate", "tpr", "valid_rate", "code_credit_on_true_flags")


def _fmt(values: list[float | None]) -> str:
    vals = [v for v in values if v is not None]
    if not vals:
        return "n/a"
    mean = statistics.fmean(vals)
    return f"{mean:.3f}" if len(vals) == 1 or max(vals) == min(vals) else f"{mean:.3f} ({min(vals):.3f}-{max(vals):.3f})"


def read_real_results(path: Path, flag_criteria: list[str]) -> dict[str, bool]:
    """trial name -> flagged, from harbor's analysis.json files or any JSON with `checks`."""
    index_path = path / "index.json"
    index = json.loads(index_path.read_text()) if index_path.exists() else {}
    flagged = {}
    for f in path.rglob("*.json"):
        try:
            data = json.loads(f.read_text())
        except (json.JSONDecodeError, UnicodeDecodeError):
            continue
        if not isinstance(data, dict) or not isinstance(data.get("checks"), dict):
            continue
        name = data.get("trial_name") or f.parent.name
        outcome = lambda c: (c.get("outcome") if isinstance(c, dict) else None)  # noqa: E731
        flagged[index.get(name, name)] = any(outcome(data["checks"].get(n, {})) == "fail" for n in flag_criteria)
    return flagged


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", required=True)
    ap.add_argument("--split", default="test", choices=["train", "val", "test"])
    ap.add_argument("--candidate", action="append", default=[], help="directory with prompt.txt + rubric.toml (repeatable)")
    ap.add_argument("--seed-prompt", default=str(HERE / "seed" / "prompt.txt"))
    ap.add_argument("--seed-rubric", default=str(HERE / "seed" / "rubric.toml"))
    ap.add_argument("--seed-defaults", default=None)
    ap.add_argument("--flag-criterion", action="append", default=[])
    ap.add_argument("--target", choices=["evolve", "harbor"], default="evolve")
    ap.add_argument("--judge-model", action="append", default=[], help=f"repeatable; default {JUDGE_MODEL}")
    ap.add_argument("--judge-effort", default="default")
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--workers", type=int, default=8)
    ap.add_argument("--max-tokens", type=int, default=40_000)
    ap.add_argument("--max-spend", type=float, default=10.0)
    ap.add_argument("--allow-peak", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--report", default=None, help="markdown report path (records go next to it as .jsonl)")
    ap.add_argument("--real-results", default=None, help="folder of real analyzer results (see export_trials.py)")
    ap.add_argument("--real-candidate", default=None, help="which --candidate the real run used (default: the last one)")
    args = ap.parse_args()

    seed = load_seed(args.seed_prompt, args.seed_rubric, args.seed_defaults)
    candidates = {"seed": seed.candidate()}
    for path in args.candidate:
        candidates[Path(path).name] = load_candidate_dir(path, seed)
    examples = read_dataset(args.data, args.split)
    if not examples:
        sys.exit(f"{args.data}: no {args.split} examples")
    models = args.judge_model or [JUDGE_MODEL]
    if not args.dry_run:
        if not api_key():
            sys.exit("Set LLM_GATEWAY_API_KEY (or OPENAI_API_KEY), or pass --dry-run.")
        if any("deepseek" in m for m in models) and is_peak() and not args.allow_peak:
            sys.exit("DeepSeek is at peak pricing (01-04 and 06-10 UTC). Wait, or pass --allow-peak.")

    flag_criteria = Harness(seed, None, args.target, args.flag_criterion).flag_criteria
    report = Path(args.report) if args.report else None
    spend = Spend(cap_usd=args.max_spend)
    log = Log(report.with_suffix(".calls.jsonl") if report else None)
    records: list[dict[str, Any]] = []
    rows: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for model in models:
        judge = FakeJudge(spend, log) if args.dry_run else LLM(model, "judge", spend, log, effort=args.judge_effort)
        model = judge.model  # "fake-judge" in a dry run
        for name, cand in candidates.items():
            harness = Harness(seed, judge, args.target, args.flag_criterion, args.max_tokens)
            for rep in range(args.repeats):
                with ThreadPoolExecutor(max_workers=args.workers) as pool:
                    recs = list(pool.map(lambda b: harness.run(cand, b)[0], examples))
                for r in recs:
                    r.update(candidate=name, judge=model, repeat=rep)
                    r.pop("checks", None)
                records += recs
                rows.setdefault((model, name), []).append(metrics(recs))
                m = rows[(model, name)][-1]
                print(f"{model} | {name} | repeat {rep + 1}: score {m['mean_score']:.3f}  bal.acc {m['balanced_accuracy'] or 0:.3f}  "
                      f"false-flag {m['false_flag_rate'] or 0:.3f}  valid {m['valid_rate'] or 0:.3f}  ${m['cost_usd']:.3f}")

    lines = [f"# Analyzer rubric evaluation: {args.split} split", "", f"{len(examples)} examples ({sum(not b['gold']['hack'] for b in examples)} benign), "
             f"{args.repeats} repeat(s), target contract `{args.target}`, flag criteria `{', '.join(flag_criteria)}`.", ""]
    lines += ["| judge | candidate | " + " | ".join(KEYS) + " | $/trial |", "|---" * (len(KEYS) + 3) + "|"]
    for (model, name), ms in rows.items():
        per_trial = statistics.fmean(m["cost_usd"] for m in ms) / len(examples)
        lines.append(f"| {model} | {name} | " + " | ".join(_fmt([m[k] for m in ms]) for k in KEYS) + f" | {per_trial:.4f} |")
    lines += ["", "Values are mean (min-max) over repeats. false_flag_rate is flagged benign / judged benign.", ""]
    for (model, name), ms in rows.items():
        if "by_source" in ms[0]:
            lines += [f"**{name} on {model}, by source (repeat 1)**", "", "| source | n | mean_score | balanced_accuracy | false_flag_rate |", "|---|---|---|---|---|"]
            for src, m in ms[0]["by_source"].items():
                lines.append(f"| {src} | {m['n']} | {_fmt([m['mean_score']])} | {_fmt([m['balanced_accuracy']])} | {_fmt([m['false_flag_rate']])} |")
            lines.append("")

    if args.real_results:
        real_name = args.real_candidate or (Path(args.candidate[-1]).name if args.candidate else "seed")
        real = read_real_results(Path(args.real_results), flag_criteria)
        fast = {r["id"]: r.get("flagged", False) for r in records if r["candidate"] == real_name and r["judge"] == next(iter(rows))[0] and r["repeat"] == 0 and r["valid"]}
        both = sorted(set(real) & set(fast))
        agree = sum(real[i] == fast[i] for i in both)
        if both:
            rate = agree / len(both)
            note = f"Candidate `{real_name}`, {len(both)} trials in both: {agree} verdicts agree ({rate:.1%})."
            if rate < 0.85:
                note += " Below 85%: the fast harness is not a faithful proxy here; widen --max-tokens or add the missing task files before trusting GEPA's choice."
        else:
            note = "No trials matched between the real results and this split."
        lines += ["## Fast harness vs a real analyzer run", "", note, ""]
        print(note)

    for name, cand in candidates.items():
        if name == "seed":
            continue
        (sp, sc), (np_, nc) = from_candidate(candidates["seed"], seed), from_candidate(cand, seed)
        diff = list(difflib.unified_diff(sp.splitlines(), np_.splitlines(), "seed/prompt.txt", f"{name}/prompt.txt", lineterm=""))
        for a, b in zip(sc, nc):
            diff += difflib.unified_diff(a.guidance.split(". "), b.guidance.split(". "), f"seed/{a.name}", f"{name}/{b.name}", lineterm="")
        lines += [f"## Diff: {name} vs seed", "", "```diff", *(diff or ["(identical)"]), "```", ""]

    lines += [f"Total judge spend: ${spend.total:.3f} over {spend.calls.get('judge', 0)} calls."]
    text = "\n".join(lines) + "\n"
    if report:
        report.parent.mkdir(parents=True, exist_ok=True)
        report.write_text(text)
        with report.with_suffix(".records.jsonl").open("w") as f:
            for r in records:
                f.write(json.dumps(r) + "\n")
        print(f"\nReport: {report}")
    else:
        print("\n" + text)


if __name__ == "__main__":
    main()
