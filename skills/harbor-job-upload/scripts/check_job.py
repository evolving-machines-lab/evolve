#!/usr/bin/env python3
"""Check a job directory against every cap `evolve upload` will apply.

Answers the question the CLI cannot answer until after a long transfer: will
this be accepted, and once accepted will the analyzer actually read it?

The archive size is MEASURED, not estimated — the directory is tarred and
gzipped to a temp file exactly as the SDK does, so the number reported is the
number the server will see. Compression ratio varies from ~1.0x on blobs to
~1.8x on JSON, so an estimate is not good enough to trust near a cap.

Beyond the caps it looks for the three failures that produce a SUCCESSFUL
upload carrying an unreadable trial:

  * a symlink              -> skipped by the packer, never followed
  * agent/trajectory.json.gz -> maps to no ingest slot; empty trace
  * a trajectory over the analyzer ceiling -> stored whole, then head-truncated
                                              at analysis time

Exit codes: 0 clean, 1 violations found, 2 not a job directory.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import pathlib
import sys
import tarfile
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import jobspec  # noqa: E402


def measure_archive(job: pathlib.Path) -> tuple[int, int, int]:
    """(compressed, decompressed, entries), by actually packing it."""
    with tempfile.TemporaryDirectory(prefix="harbor-job-check-") as tmp:
        path = pathlib.Path(tmp) / "job.tar.gz"
        entries = raw = 0
        with tarfile.open(path, "w:gz") as tar:
            for cur, dirs, files in os.walk(job):
                dirs[:] = [d for d in dirs if d not in (".git", ".venv")]
                for f in sorted(files):
                    if f == ".DS_Store":
                        continue
                    p = pathlib.Path(cur) / f
                    if p.is_symlink() or not p.is_file():
                        continue
                    tar.add(p, arcname=str(p.relative_to(job)))
                    entries += 1
                    raw += p.stat().st_size
        return path.stat().st_size, raw, entries


def check(job: pathlib.Path, caps: dict, live: bool, target: int) -> list[dict]:
    findings: list[dict] = []

    def bad(level, what, detail):
        findings.append({"level": level, "what": what, "detail": detail})

    for rel in jobspec.RECORD_FILES:
        if not (job / rel).is_file():
            bad("error", "not_a_job_dir",
                f"{job}/{rel} is missing — the client refuses before packing")

    trials = sorted(d for d in job.iterdir() if d.is_dir())
    if len(trials) > caps["job_trials"]:
        bad("error", "job_too_large",
            f"{len(trials)} trials, cap is {caps['job_trials']}")

    for t in trials:
        for cur, _dirs, files in os.walk(t):
            for f in files:
                p = pathlib.Path(cur) / f
                rel = p.relative_to(job)
                if p.is_symlink():
                    bad("error", "symlink",
                        f"{rel} is a symlink — the packer skips it silently")
                    continue
                if not p.is_file():
                    continue
                size = p.stat().st_size
                trial_rel = str(p.relative_to(t))
                if trial_rel in jobspec.RECORD_FILES and size > jobspec.MAX_RECORD_FILE_BYTES:
                    bad("error", "not_a_job_dir",
                        f"{rel} is {jobspec.human(size)}, record cap is 8.0 MiB")
                elif size > caps["job_trial_file_bytes"]:
                    bad("error", "invalid_trial",
                        f"{rel} is {jobspec.human(size)}, per-file cap is "
                        f"{jobspec.human(caps['job_trial_file_bytes'])}")
                elif size > target:
                    bad("warn", "analyzer_truncation",
                        f"{rel} is {jobspec.human(size)}, over the "
                        f"{jobspec.human(target)} analyzer ceiling — it uploads "
                        f"clean and is then head-truncated at analysis time")

        if (t / "agent" / "trajectory.json.gz").exists():
            bad("error", "empty_trace",
                f"{t.name}/agent/trajectory.json.gz maps to no ingest slot — "
                f"the trial will upload with no trace")
        traj = t / "agent" / "trajectory.json"
        if not traj.is_file():
            bad("warn", "no_trajectory", f"{t.name} has no agent/trajectory.json")
        else:
            try:
                json.loads(traj.read_text(errors="replace"))
            except json.JSONDecodeError as e:
                bad("error", "invalid_trajectory",
                    f"{t.name}/agent/trajectory.json is not valid JSON ({e.msg}) — "
                    f"an unrepaired [REDACTED] token does this")

        sess = t / "agent" / "sessions"
        if sess.is_dir():
            total = sum(p.stat().st_size for p in sess.rglob("*") if p.is_file())
            if total > caps["job_trial_session_bytes"]:
                bad("error", "invalid_trial",
                    f"{t.name} session tree is {jobspec.human(total)}, cap is "
                    f"{jobspec.human(caps['job_trial_session_bytes'])}")

    compressed, raw, entries = measure_archive(job)
    if compressed > caps["job_archive_bytes"]:
        bad("error", "upload_too_large",
            f"archive is {jobspec.human(compressed)}, cap is "
            f"{jobspec.human(caps['job_archive_bytes'])}")
    if raw > jobspec.MAX_DECOMPRESSED_BYTES:
        bad("error", "upload_too_large",
            f"decompressed footprint is {jobspec.human(raw)}, cap is "
            f"{jobspec.human(jobspec.MAX_DECOMPRESSED_BYTES)}")
    if entries > jobspec.MAX_ARCHIVE_ENTRIES:
        bad("error", "invalid_archive",
            f"{entries:,} entries, cap is {jobspec.MAX_ARCHIVE_ENTRIES:,}")

    ratio = raw / compressed if compressed else 0
    print(f"{job.name}")
    print(f"  trials       {len(trials)} / {caps['job_trials']}")
    print(f"  archive      {jobspec.human(compressed)} / "
          f"{jobspec.human(caps['job_archive_bytes'])}   (measured, {ratio:.2f}x)")
    print(f"  decompressed {jobspec.human(raw)} / "
          f"{jobspec.human(jobspec.MAX_DECOMPRESSED_BYTES)}")
    print(f"  entries      {entries:,} / {jobspec.MAX_ARCHIVE_ENTRIES:,}")
    print(f"  caps from    {'GET /api/meta (live)' if live else 'frozen defaults — server unreachable'}")
    return findings


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("job", nargs="+", help="job directory")
    ap.add_argument("--target-bytes", type=int, default=jobspec.ANALYZER_FILE_BYTES,
                    help="the analyzer ceiling to warn against (default 24 MiB)")
    ap.add_argument("--offline", action="store_true",
                    help="do not query /api/meta; use the frozen defaults")
    ap.add_argument("--json", action="store_true", help="machine-readable findings")
    args = ap.parse_args()

    caps, live = jobspec.resolve_caps(offline=args.offline)
    all_findings = {}
    rc = 0
    for j in args.job:
        job = pathlib.Path(j)
        if not job.is_dir():
            print(f"{j}: not a directory", file=sys.stderr)
            return 2
        findings = check(job, caps, live, args.target_bytes)
        all_findings[str(job)] = findings
        errors = [f for f in findings if f["level"] == "error"]
        warns = [f for f in findings if f["level"] == "warn"]
        for f in errors + warns:
            print(f"  {f['level'].upper():5s} {f['what']}: {f['detail']}")
        if not findings:
            print("  OK — every cap satisfied")
        if errors:
            rc = 1
        print()

    if args.json:
        print(json.dumps(all_findings, indent=1))
    return rc


if __name__ == "__main__":
    sys.exit(main())
