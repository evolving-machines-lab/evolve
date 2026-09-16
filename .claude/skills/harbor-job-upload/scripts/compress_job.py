#!/usr/bin/env python3
"""Build an uploadable Harbor job directory from a set of trial directories.

Keeps exactly what the platform ingests, drops what it never reads, and
shrinks `agent/trajectory.json` to fit the ANALYZER's budget rather than the
upload cap — a file between the two is accepted and then silently truncated
at analysis time, which looks like a successful upload and reads like a
mangled trace.

Three failure modes this exists to prevent, each of which is silent:

  * a symlinked file            -> the packer skips symlinks without following
                                   them, so the trial ships without its trace.
                                   Everything here is hard-linked or written.
  * agent/trajectory.json.gz    -> maps to no ingest slot, so the trial lands
                                   with an empty trace. Decompressed on the way in.
  * a [REDACTED] token in JSON  -> not valid JSON; a broad except drops the
                                   trial. Repaired on read.

Usage:
  compress_job.py --out JOB_DIR --trial DIR [--trial DIR ...]
  compress_job.py --out JOB_DIR --from-list paths.txt --dry-run
"""
from __future__ import annotations

import argparse
import gzip
import json
import os
import pathlib
import shutil
import sys
import uuid

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import jobspec  # noqa: E402
import trajectory as traj_mod  # noqa: E402

LOG_CLIP_MARKER = "\n... [{n:,} characters clipped to fit the upload budget] ...\n"


def read_json(path: pathlib.Path):
    """Repairing read. Returns None when the file is absent or unparseable."""
    if not path.is_file():
        return None
    try:
        return traj_mod.loads(path.read_text(errors="replace"))
    except (json.JSONDecodeError, UnicodeDecodeError):
        return None


def source_of(trial: pathlib.Path, rel: str) -> pathlib.Path | None:
    """The real file for an ingest slot, accepting a .gz twin.

    Symlinks are resolved here rather than linked through: the packer skips a
    symlink silently, so one that survives into the job dir is a file that
    quietly does not upload.
    """
    for cand in (trial / rel, trial / (rel + ".gz")):
        real = cand.resolve() if cand.is_symlink() else cand
        if real.is_file():
            return real
    return None


def read_bytes(path: pathlib.Path) -> bytes:
    if path.suffix == ".gz":
        with gzip.open(path, "rb") as fh:
            return fh.read()
    return path.read_bytes()


def uncompressed_size(path: pathlib.Path) -> int:
    """Size of a file's content — for a .gz, what it expands to.

    gzip records ISIZE (mod 2^32) in its last four bytes; every file here is
    far under 4 GiB, so the trailer is exact and costs one seek instead of a
    full decompression.
    """
    if path.suffix != ".gz":
        return path.stat().st_size
    try:
        with path.open("rb") as fh:
            fh.seek(-4, os.SEEK_END)
            return int.from_bytes(fh.read(4), "little")
    except OSError:
        return path.stat().st_size


def place(src: pathlib.Path, dst: pathlib.Path) -> None:
    """Hard-link when possible (free on one volume), copy across devices."""
    dst.parent.mkdir(parents=True, exist_ok=True)
    if dst.exists():
        dst.unlink()
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def clip_text(data: bytes, budget: int) -> tuple[bytes, bool]:
    if len(data) <= budget:
        return data, False
    text = data.decode(errors="replace")
    head = budget * 2 // 3
    out = text[:head] + LOG_CLIP_MARKER.format(n=len(text) - budget) + text[-(budget - head):]
    return out.encode(), True


def trial_name(trial: pathlib.Path, result: dict | None) -> str:
    if result:
        if result.get("trial_name"):
            return str(result["trial_name"])
        task = str(result.get("task_name") or "").split("/")[-1]
        if task:
            return f"{task}__{trial.name[:8]}"
    return trial.name


def build_trial(trial: pathlib.Path, dest: pathlib.Path, args) -> dict:
    """Materialise one trial into the job dir. Returns its report."""
    result = read_json(trial / "result.json")
    rep = {
        "source": str(trial),
        "name": dest.name,
        "kept": [],
        "dropped": [],
        "bytes_in": 0,
        "bytes_out": 0,
    }

    # Record files. Required by ingest; both are small by contract, and a
    # record over the record cap is a refusal, so it is reported not clipped.
    for rel in jobspec.RECORD_FILES:
        src = source_of(trial, rel)
        if src is None:
            rep["dropped"].append({"path": rel, "why": "missing"})
            continue
        data = read_bytes(src)
        rep["bytes_in"] += len(data)
        if len(data) > jobspec.MAX_RECORD_FILE_BYTES:
            rep["dropped"].append(
                {"path": rel, "why": "over the 8 MiB record cap", "bytes": len(data)})
            continue
        if src.suffix == ".gz":
            (dest / rel).parent.mkdir(parents=True, exist_ok=True)
            (dest / rel).write_bytes(data)
        else:
            place(src, dest / rel)
        rep["bytes_out"] += len(data)
        rep["kept"].append(rel)

    have_stdout = source_of(trial, "agent/stdout.log") is not None

    for rel in jobspec.TRIAL_ARTIFACT_FILES:
        src = source_of(trial, rel)
        if src is None:
            continue
        data = read_bytes(src)
        rep["bytes_in"] += len(data)

        if rel == "agent/trajectory.json":
            out, treport = traj_mod.compress(data.decode(errors="replace"),
                                             args.target_bytes)
            rep["trajectory"] = treport
        else:
            out, clipped = clip_text(data, args.target_bytes)
            if clipped:
                rep.setdefault("clipped_logs", []).append(rel)

        (dest / rel).parent.mkdir(parents=True, exist_ok=True)
        if len(out) == len(data) and src.suffix != ".gz" and rel != "agent/trajectory.json":
            place(src, dest / rel)      # untouched: link it, do not rewrite
        else:
            (dest / rel).write_bytes(out)
        rep["bytes_out"] += len(out)
        rep["kept"].append(rel)

    # The stdout slot's fallback, used only when agent/stdout.log is absent.
    if not have_stdout and not args.no_harness_log:
        agent_dir = trial / "agent"
        if agent_dir.is_dir():
            for cand in sorted(agent_dir.glob(f"*{jobspec.HARNESS_LOG_SUFFIX}")):
                if not cand.is_file():
                    continue
                data = read_bytes(cand)
                rep["bytes_in"] += len(data)
                out, clipped = clip_text(data, args.target_bytes)
                (dest / "agent" / cand.name).write_bytes(out)
                rep["bytes_out"] += len(out)
                rep["kept"].append(f"agent/{cand.name}")
                if clipped:
                    rep.setdefault("clipped_logs", []).append(f"agent/{cand.name}")
                break

    if args.keep_sessions:
        sess = trial / "agent" / "sessions"
        total = 0
        for cur, _dirs, files in os.walk(sess):
            for f in files:
                s = pathlib.Path(cur) / f
                real = s.resolve() if s.is_symlink() else s
                if not real.is_file() or real.stat().st_size > jobspec.MAX_TRIAL_FILE_BYTES:
                    rep["dropped"].append({"path": str(s.relative_to(trial)),
                                           "why": "over the per-file cap"})
                    continue
                total += real.stat().st_size
                place(real, dest / s.relative_to(trial))
        if total:
            rep["session_bytes"] = total
            rep["bytes_in"] += total
            rep["bytes_out"] += total

    if args.keep_artifacts:
        for cur, _dirs, files in os.walk(trial / "artifacts"):
            for f in files:
                s = pathlib.Path(cur) / f
                real = s.resolve() if s.is_symlink() else s
                if not real.is_file() or real.stat().st_size > jobspec.MAX_TRIAL_FILE_BYTES:
                    continue
                place(real, dest / s.relative_to(trial))

    # The honest denominator: everything the trial dir holds, not just the
    # slots we ship. Without it a report can claim "1% removed" for a trial
    # whose artifacts/ tree was the actual 90%.
    #
    # A .gz member is counted at its DECOMPRESSED size. The comparison has to
    # be content against content: our output is plain JSON that the uploader
    # gzips on the way out, so measuring a gzipped input against it makes
    # decompressing a trajectory look like a 300% regression.
    rep["source_dir_bytes"] = sum(
        uncompressed_size(p) for p in trial.rglob("*")
        if p.is_file() and not p.is_symlink())
    rep["result"] = result
    return rep


def write_job_meta(job: pathlib.Path, reports: list[dict], args) -> str:
    """The job-level result.json + config.json the client and server require.

    The id is content-addressed over the trial set: the server dedupes on it,
    so keying it on a label alone lets a smoke run collide with the real job
    and lets a re-run create a twin.
    """
    names = sorted(r["name"] for r in reports)
    results = [r.get("result") or {} for r in reports]
    seed = args.job_id_seed or (args.name + "/" + ",".join(names))
    job_id = str(uuid.uuid5(uuid.NAMESPACE_URL, seed))

    rewards, tasks, agents = [], set(), {}
    for res in results:
        rw = ((res.get("verifier_result") or {}).get("rewards") or {}).get("reward")
        rewards.append(rw)
        task = str(res.get("task_name") or "").split("/")[-1]
        if task:
            tasks.add(task)
        ag = (res.get("config") or {}).get("agent") or {}
        if ag.get("name"):
            agents[(ag["name"], ag.get("model_name"))] = True

    if args.agent or args.model:
        agents = {(args.agent or "unknown", args.model): True}
    if not agents:
        agents = {("unknown", None): True}

    (job / "result.json").write_text(json.dumps({
        "id": job_id,
        "n_total_trials": len(reports),
        "stats": {
            "n_trials": len(reports),
            "n_errors": 0,
            "n_resolved": sum(1 for r in rewards if r and r > 0),
            "n_unresolved": sum(1 for r in rewards if not r),
        },
        "source": args.source,
        "provenance": {
            "note": "Assembled by the harbor-job-upload skill",
            "job_name": args.name,
            "trials": len(reports),
        },
    }, indent=1))

    (job / "config.json").write_text(json.dumps({
        "job_name": args.name,
        "jobs_dir": "jobs",
        "n_attempts": 1,
        "timeout_multiplier": 1.0,
        "debug": False,
        "agents": [{"name": n, "import_path": None, "model_name": m}
                   for (n, m) in agents],
        "datasets": [{"name": args.dataset_name, "version": args.dataset_version,
                      "task_names": sorted(tasks)}],
        "tasks": [],
        "metrics": [],
    }, indent=1))
    return job_id


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", required=True, help="job directory to create")
    ap.add_argument("--trial", action="append", default=[],
                    help="a trial directory; repeatable")
    ap.add_argument("--from-list", help="file of trial directory paths, one per line")
    ap.add_argument("--target-bytes", type=int, default=jobspec.ANALYZER_FILE_BYTES,
                    help="per-file budget (default: the 24 MiB analyzer ceiling, "
                         "NOT the 32 MiB upload cap)")
    ap.add_argument("--keep-sessions", action="store_true",
                    help="keep agent/sessions/ (ingested and served, but the "
                         "analyzer never reads it)")
    ap.add_argument("--keep-artifacts", action="store_true",
                    help="keep artifacts/ (never ingested; for local parity only)")
    ap.add_argument("--no-harness-log", action="store_true",
                    help="drop agent/<harness>.txt, the stdout-slot fallback")
    ap.add_argument("--name", help="job name (default: the --out basename)")
    ap.add_argument("--job-id-seed", help="override the content-addressed id seed")
    ap.add_argument("--agent", help="override the agent name in config.json")
    ap.add_argument("--model", help="override the model name in config.json")
    ap.add_argument("--source", default="harbor-job-upload")
    ap.add_argument("--dataset-name", default="terminal-bench")
    ap.add_argument("--dataset-version", default="4.0.0")
    ap.add_argument("--report", help="write the JSON report here")
    ap.add_argument("--dry-run", action="store_true",
                    help="report only; write nothing")
    args = ap.parse_args()

    trials = [pathlib.Path(t) for t in args.trial]
    if args.from_list:
        trials += [pathlib.Path(l.strip())
                   for l in pathlib.Path(args.from_list).read_text().splitlines()
                   if l.strip() and not l.startswith("#")]
    missing = [t for t in trials if not t.is_dir()]
    if missing:
        print("not a directory:\n  " + "\n  ".join(map(str, missing)), file=sys.stderr)
        return 2
    if not trials:
        print("no trials given (--trial / --from-list)", file=sys.stderr)
        return 2

    job = pathlib.Path(args.out)
    args.name = args.name or job.name
    stage = job.with_name(job.name + ".building") if not args.dry_run else None

    if args.dry_run:
        import tempfile
        tmp = tempfile.mkdtemp(prefix="harbor-job-dry-")
        stage = pathlib.Path(tmp) / job.name

    if stage.exists():
        shutil.rmtree(stage)
    stage.mkdir(parents=True)

    reports = []
    for t in trials:
        res = read_json(t / "result.json")
        name = trial_name(t, res)
        reports.append(build_trial(t, stage / name, args))
        reports[-1]["name"] = name

    job_id = write_job_meta(stage, reports, args)

    bytes_in = sum(r["bytes_in"] for r in reports)
    bytes_out = sum(r["bytes_out"] for r in reports)
    src_bytes = sum(r["source_dir_bytes"] for r in reports)
    report = {
        "job": args.name,
        "job_id": job_id,
        "trials": len(reports),
        "target_bytes": args.target_bytes,
        "source_dir_bytes": src_bytes,
        "bytes_in": bytes_in,
        "bytes_out": bytes_out,
        "reduction_pct": round(100 * (1 - bytes_out / bytes_in), 1) if bytes_in else 0.0,
        "reduction_vs_source_dir_pct": (
            round(100 * (1 - bytes_out / src_bytes), 1) if src_bytes else 0.0),
        "lossy_trials": [r["name"] for r in reports
                         if (r.get("trajectory") or {}).get("lossy")],
        "per_trial": [{k: v for k, v in r.items() if k != "result"} for r in reports],
    }

    if args.dry_run:
        shutil.rmtree(stage.parent)
    else:
        if job.exists():
            shutil.rmtree(job)
        stage.rename(job)

    print(f"{args.name}: {len(reports)} trials  id={job_id}")
    print(f"  ingested slots  {jobspec.human(bytes_in)} -> {jobspec.human(bytes_out)}"
          f"  ({report['reduction_pct']}% removed by compression)")
    print(f"  whole trial dirs {jobspec.human(src_bytes)} -> {jobspec.human(bytes_out)}"
          f"  ({report['reduction_vs_source_dir_pct']}% removed overall, "
          f"content-for-content)")
    if report["lossy_trials"]:
        print(f"  lossy (observation clipping fired): {len(report['lossy_trials'])} "
              f"of {len(reports)}")
    if args.dry_run:
        print("  dry run — nothing written")

    if args.report:
        pathlib.Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        pathlib.Path(args.report).write_text(json.dumps(report, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
