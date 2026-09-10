You are running a closed-loop materials discovery campaign on the **Li-Sn** binary
system. Your goal is to find compositions that are **thermodynamically stable** —
that is, compositions lying on the lower convex hull of formation energy against
composition.

## The oracle

```bash
python3 /app/oracle.py Li3Sn2 LiSn
```

It reports the formation energy in eV/atom for each formula and nothing else.
Whether a composition sits on the convex hull is for you to work out.

**You have 15 oracle calls in total.** The budget is enforced and every call is
logged to `/app/campaign.jsonl`. A formula the oracle cannot parse is rejected and
does not cost a call. Elemental Li and Sn are the references and have zero
formation energy by definition; they do not count as discoveries.

## The search space

Formulas `Li_i Sn_j` with `i, j >= 1` and `i + j <= 12`, written in reduced form
(`LiSn`, not `Li2Sn2`). `/app/data/system.json` states the same bounds.

## What to submit

Write `/app/answer.json`:

```json
{ "stable_compounds": ["Li4Sn", "LiSn"] }
```

You are scored on finding at least **3** stable compounds with **no incorrect
claims**, without exceeding the oracle budget. Claiming an unstable composition
costs you the task, so propose only what your measurements support.
