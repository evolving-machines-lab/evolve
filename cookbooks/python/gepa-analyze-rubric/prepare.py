"""Build a frozen, labelled evaluation set of trial bundles.

    # TRACE (gated on the Hub: accept its terms, then export HF_TOKEN)
    python prepare.py trace --per-stratum 30 --out data/reward-hacking

    # Your own Harbor trials plus a labels file
    python prepare.py harbor --trials jobs/my-job --labels labels.jsonl --tasks tasks/ --out data/my-set

    # Bundles you converted yourself (one JSON object per line, see bundles.py)
    python prepare.py bundles --file my_bundles.jsonl --out data/my-set

Several sources can go into one set: pass `--append` to add to an existing
set's pool (the split is recomputed over the union, so do it before the test
split is used for anything).
"""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import Counter
from pathlib import Path

import bundles as B


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", choices=["trace", "harbor", "bundles"])
    ap.add_argument("--out", required=True, help="dataset directory (bundles.jsonl, manifest.jsonl, test.lock)")
    ap.add_argument("--file", help="trace: local .parquet/.jsonl instead of the Hub; bundles: the JSONL file")
    ap.add_argument("--trials", help="harbor: directory holding the trial directories")
    ap.add_argument("--labels", help="harbor: labels.jsonl")
    ap.add_argument("--tasks", help="harbor: directory holding the task directories (optional)")
    ap.add_argument("--name", default=None, help="source name recorded in each bundle (default: the source)")
    ap.add_argument("--benign-pattern", default=None, help="regex that marks a label benign (default: benign|none|clean|...)")
    ap.add_argument("--per-stratum", type=int, default=None, help="keep at most N examples per (source, hack) stratum")
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--append", action="store_true", help="add to the bundles already in --out")
    ap.add_argument("--refreeze", action="store_true", help="allow the test split to change (invalidates earlier test results)")
    ap.add_argument("--terms", default=None, help="licence/terms note recorded in the manifest, e.g. 'CC-BY-SA-4.0, gated, internal only'")
    args = ap.parse_args()

    benign_re = re.compile(args.benign_pattern, re.I) if args.benign_pattern else B.BENIGN_RE
    if args.source == "trace":
        rows = B.load_trace(args.file, token=os.environ.get("HF_TOKEN"))
        print(f"TRACE: {len(rows)} rows. Label values (check the benign/hack mapping):")
        for label, n in Counter(str(r.get("label"))[:60] for r in rows).most_common(12):
            hack, codes = B.parse_label(label, benign_re)
            print(f"  {n:4d}  {label!r:64} -> {'HACK ' + ','.join(codes) if hack else 'benign'}")
        new = B.from_trace_rows(rows, benign_re)
        args.terms = args.terms or "PatronusAI/trace-dataset: CC-BY-SA-4.0, gated; internal evaluation only"
    elif args.source == "harbor":
        if not args.trials or not args.labels:
            ap.error("harbor needs --trials and --labels")
        new = B.load_harbor(args.trials, args.labels, args.tasks, args.name or "harbor")
    else:
        if not args.file:
            ap.error("bundles needs --file")
        new = [json.loads(line) for line in Path(args.file).read_text().splitlines() if line.strip()]
    if args.name:
        for b in new:
            b["source"] = args.name

    new = B.sample_per_stratum(new, args.per_stratum, args.seed)
    pool = new
    if args.append and (Path(args.out) / "bundles.jsonl").exists():
        existing = B.read_dataset(args.out)
        ids = {b["id"] for b in new}
        pool = [b for b in existing if b["id"] not in ids] + new
    B.assign_splits(pool, seed=args.seed)
    fingerprint = B.write_dataset(pool, args.out, refreeze=args.refreeze, terms=args.terms)

    table = Counter((b["source"], b["split"], "hack" if b["gold"]["hack"] else "benign") for b in pool)
    print(f"\n{len(pool)} bundles in {args.out}  (test split sha256 {fingerprint[:12]}, frozen in test.lock)")
    for source in sorted({b["source"] for b in pool}):
        row = "  ".join(f"{s}: {table[(source, s, 'hack')]}h/{table[(source, s, 'benign')]}b" for s in B.SPLITS)
        print(f"  {source:12} {row}")


if __name__ == "__main__":
    main()
