#!/usr/bin/env python3
"""Run a task's gold/null pair — the acceptance bar for a converted task.

    gold: apply solution/, then verify  -> the reward must be 1.0
    null: verify with no solution       -> the reward must be 0.0

A task that fails either half is not converted, it is broken. A gold below 1.0
means the task is unsolvable as written (or the verifier is wrong); a null above 0
means the environment already contains the answer and every agent scores for free.

    python3 goldnull.py path/to/task [--docker]

Default is local mode: the phases run as plain subprocesses with TASK_WORKDIR and
LOGS_DIR pointed at a scratch sandbox, so no daemon is needed. It exercises the
verifier logic, not the image — use --docker for the full environment when a
daemon is available.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import tomllib
from pathlib import Path


def read_reward(logs: Path) -> float | None:
    """The reward file is the verdict — mirror the platform's own precedence."""
    as_json = logs / "verifier" / "reward.json"
    if as_json.is_file():
        try:
            payload = json.loads(as_json.read_text())
        except json.JSONDecodeError:
            return None
        if "reward" in payload:
            return float(payload["reward"])
        numbers = [v for v in payload.values() if isinstance(v, (int, float))]
        # Exactly one numeric value is the primary-reward convention. Several named
        # scores with no "reward" key is valid but has NO primary reward.
        return float(numbers[0]) if len(numbers) == 1 else None

    as_text = logs / "verifier" / "reward.txt"
    if as_text.is_file():
        try:
            return float(as_text.read_text().strip())
        except ValueError:
            return None
    return None


def workdir_of(task: Path) -> str:
    """Best-effort guess at the container workdir, for the local sandbox."""
    dockerfile = task / "environment" / "Dockerfile"
    if dockerfile.is_file():
        for line in dockerfile.read_text().splitlines():
            if line.strip().upper().startswith("WORKDIR "):
                return line.split(None, 1)[1].strip()
    return "/app"


def run_phase(script: Path, sandbox: Path, workdir: Path, label: str, quiet: bool) -> int:
    # Inherit the caller's environment and override only the task's own slots.
    # Replacing it wholesale (a hardcoded PATH) silently runs a DIFFERENT
    # interpreter than the one the caller installed the grader's dependencies
    # into — which is exactly how a venv, or a CI setup-python, gets missed.
    env = {
        **os.environ,
        "HOME": str(sandbox),
        "TASK_WORKDIR": str(workdir),
        "LOGS_DIR": str(sandbox / "logs"),
    }
    proc = subprocess.run(
        ["bash", str(script)],
        cwd=workdir,
        env=env,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0 and not quiet:
        print(f"    [{label}] exit {proc.returncode}")
    if proc.stderr.strip() and not quiet:
        for line in proc.stderr.strip().splitlines()[-8:]:
            print(f"    [{label}] {line}")
    return proc.returncode


def seed(task: Path, sandbox: Path, workdir: Path) -> None:
    """Materialize whatever environment/ ships, minus the Dockerfile itself."""
    workdir.mkdir(parents=True, exist_ok=True)
    (sandbox / "logs" / "verifier").mkdir(parents=True, exist_ok=True)
    source = task / "environment"
    if not source.is_dir():
        return
    for item in source.iterdir():
        if item.name in {"Dockerfile", "docker-compose.yaml", "docker-compose.yml"}:
            continue
        target = workdir / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
        else:
            shutil.copy2(item, target)


def local_run(task: Path, apply_solution: bool, quiet: bool) -> float | None:
    declared = workdir_of(task)
    with tempfile.TemporaryDirectory() as tmp:
        sandbox = Path(tmp)
        workdir = sandbox / declared.lstrip("/")
        seed(task, sandbox, workdir)

        if apply_solution:
            solve = task / "solution" / "solve.sh"
            if not solve.is_file():
                print("    no solution/solve.sh — nothing to apply")
                return None
            run_phase(solve, sandbox, workdir, "gold", quiet)

        run_phase(task / "tests" / "test.sh", sandbox, workdir, "verify", quiet)
        return read_reward(sandbox / "logs")


def docker_run(task: Path, apply_solution: bool, quiet: bool) -> float | None:
    cfg = tomllib.loads((task / "task.toml").read_text())
    image = cfg.get("environment", {}).get("docker_image")
    tag = image
    if not tag:
        tag = f"harbor-task-{task.name}:goldnull"
        build = subprocess.run(
            ["docker", "build", "-q", "-t", tag, str(task / "environment")],
            capture_output=True,
            text=True,
        )
        if build.returncode != 0:
            print(f"    docker build failed:\n{build.stderr.strip()[-2000:]}")
            return None

    steps = "bash /task/solution/solve.sh && " if apply_solution else ""
    script = f"{steps}bash /task/tests/test.sh; cat /logs/verifier/reward.json 2>/dev/null || cat /logs/verifier/reward.txt 2>/dev/null"
    proc = subprocess.run(
        ["docker", "run", "--rm", "-v", f"{task.resolve()}:/task:ro", tag, "bash", "-lc", script],
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0 and not quiet:
        print(f"    docker run exit {proc.returncode}: {proc.stderr.strip()[-500:]}")
    out = proc.stdout.strip()
    if not out:
        return None
    try:
        payload = json.loads(out)
    except json.JSONDecodeError:
        try:
            return float(out.splitlines()[-1].strip())
        except ValueError:
            return None
    if "reward" in payload:
        return float(payload["reward"])
    numbers = [v for v in payload.values() if isinstance(v, (int, float))]
    return float(numbers[0]) if len(numbers) == 1 else None


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("tasks", nargs="+")
    parser.add_argument("--docker", action="store_true", help="run in the real task image")
    parser.add_argument("-q", "--quiet", action="store_true")
    args = parser.parse_args()

    runner = docker_run if args.docker else local_run
    failed = False

    for arg in args.tasks:
        task = Path(arg).resolve()
        print(f"== {arg}")
        if not (task / "tests" / "test.sh").is_file():
            print("  ERROR  no tests/test.sh")
            failed = True
            continue

        null = runner(task, False, args.quiet)
        gold = runner(task, True, args.quiet)

        print(f"  null reward: {null}")
        print(f"  gold reward: {gold}")

        if gold is None or abs(gold - 1.0) > 1e-9:
            print("  ERROR  gold must be exactly 1.0 — the task is unsolvable as written, "
                  "or the verifier is wrong")
            failed = True
        if null is None or abs(null) > 1e-9:
            print("  ERROR  null must be exactly 0.0 — the environment already contains "
                  "the answer, so every agent scores for free")
            failed = True
        if not failed:
            print("  ok")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
