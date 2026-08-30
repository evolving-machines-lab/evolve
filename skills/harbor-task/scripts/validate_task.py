#!/usr/bin/env python3
"""Offline structural lint for a Harbor-compatible task directory.

No Docker, no network, no credentials — this catches the class of mistake that
would otherwise surface as a server-side import refusal, or worse, as a task that
imports cleanly and scores every agent 0.

    python3 validate_task.py path/to/task [path/to/another ...]

Exits 1 if any ERROR was found. Warnings never fail the run.
"""

from __future__ import annotations

import re
import sys
import tomllib
from pathlib import Path

NETWORK_MODES = {"no-network", "allowlist", "public"}
VERIFIER_MODES = {"shared", "separate"}

# Judge-credential templates the platform honors, as the ENTIRE value.
JUDGE_TEMPLATES = {
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_BASE",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_BASE",
    "OPENAI_BASE_URL",
}

# Instructions a tests/Dockerfile may use on the paths where it is NOT built.
TRIVIAL_INSTRUCTIONS = {"FROM", "COPY", "WORKDIR", "LABEL", "ARG", "ENTRYPOINT", "CMD"}

WHOLE_TEMPLATE = re.compile(r"^\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-(.*))?\}$", re.DOTALL)
ANY_TEMPLATE = re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*(?::-[^}]*)?\}")


class Report:
    def __init__(self, task: Path) -> None:
        self.task = task
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    def render(self) -> None:
        print(f"== {self.task}")
        for msg in self.errors:
            print(f"  ERROR  {msg}")
        for msg in self.warnings:
            print(f"  WARN   {msg}")
        if not self.errors and not self.warnings:
            print("  ok")


def _positive_number(value: object) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) and value > 0


def check_required_files(task: Path, cfg: dict, rep: Report) -> None:
    multi_step = bool(cfg.get("steps"))

    if not (task / "task.toml").is_file():
        rep.error("task.toml is missing (required)")

    if multi_step:
        if not (task / "steps").is_dir():
            rep.error("task.toml declares [[steps]] but there is no steps/ directory")
        for entry in cfg.get("steps", []):
            name = entry.get("name")
            if not name:
                rep.error("a [[steps]] entry has no name")
                continue
            step = task / "steps" / name
            if not step.is_dir():
                rep.error(f"step {name!r} has no directory at steps/{name}/")
            elif not (step / "instruction.md").is_file():
                rep.error(f"step {name!r} is missing steps/{name}/instruction.md")
        return

    if not (task / "instruction.md").is_file():
        rep.error("instruction.md is missing (required)")
    if not (task / "tests" / "test.sh").is_file():
        rep.error("tests/test.sh is missing (required) — import fails on this by name")
    if not (task / "solution").is_dir():
        rep.warn(
            "no solution/ — publishes with a no_solutions_archived warning, and "
            "nothing proves the task is solvable"
        )
    elif not any((task / "solution").iterdir()):
        rep.warn("solution/ is empty")


def check_environment(task: Path, cfg: dict, rep: Report) -> None:
    env = cfg.get("environment", {})
    sources = []
    if (task / "environment" / "Dockerfile").is_file():
        sources.append("environment/Dockerfile")
    if (task / "environment" / "docker-compose.yaml").is_file():
        sources.append("environment/docker-compose.yaml")
    if (task / "environment" / "docker-compose.yml").is_file():
        sources.append("environment/docker-compose.yml")
    if env.get("docker_image"):
        sources.append("[environment] docker_image")

    if not sources:
        rep.error(
            "no environment source — provide environment/Dockerfile, "
            "environment/docker-compose.yaml, or [environment] docker_image"
        )
    elif len(sources) > 1:
        rep.error(f"more than one environment source declared: {', '.join(sources)}")

    image = env.get("docker_image")
    if image:
        ref = image.rsplit("/", 1)[-1]
        if ":" not in ref:
            rep.error(f"docker_image {image!r} has no tag — pin it, never float")
        elif ref.rsplit(":", 1)[1] == "latest":
            rep.error(f"docker_image {image!r} is pinned to :latest — pin a real tag")

    mode = env.get("network_mode")
    if mode is None:
        if "allow_internet" in env:
            rep.warn(
                "[environment] allow_internet is the deprecated spelling — "
                "use network_mode"
            )
        else:
            rep.warn(
                "[environment] declares no network_mode — this means \"public\", "
                "not sealed. Declare it explicitly."
            )
    elif mode not in NETWORK_MODES:
        rep.error(
            f"[environment] network_mode {mode!r} is not one of {sorted(NETWORK_MODES)}"
        )
    elif mode == "allowlist" and not env.get("allowed_hosts"):
        rep.error("[environment] network_mode is \"allowlist\" but allowed_hosts is empty")

    multi_container = any(
        (task / "environment" / name).is_file()
        for name in ("docker-compose.yaml", "docker-compose.yml")
    )

    if multi_container and mode == "no-network":
        rep.error(
            "a multi-container task with network_mode \"no-network\" is declined on "
            "every sandbox provider today — give it \"allowlist\" or \"public\""
        )

    if env.get("gpus", 0):
        if "gpu_types" not in env or env.get("gpu_types") is None:
            rep.warn(
                "[environment] requests gpus but declares no gpu_types (any type is "
                "accepted; note a task that accepts any type has no single list price, "
                "so its GPU cost estimate stays unpriced)"
            )
        if multi_container:
            rep.error(
                "a multi-container task cannot request gpus — GPU trials run on Modal, "
                "and Modal does not run multi-container tasks today"
            )
        else:
            rep.warn(
                "[environment] requests gpus — the trial runs on Modal whichever "
                "provider the job picks (e2b has no GPUs at any tier; the current "
                "Daytona tier provisions none). Recorded as providers.<p>.degrades_to, "
                "not a silent fallback"
            )


def check_verifier(task: Path, cfg: dict, rep: Report) -> None:
    verifier = cfg.get("verifier", {})
    mode = verifier.get("environment_mode", "shared")
    if mode not in VERIFIER_MODES:
        rep.error(
            f"[verifier] environment_mode {mode!r} is not one of {sorted(VERIFIER_MODES)}"
        )

    if mode == "separate":
        artifacts = cfg.get("artifacts")
        if not artifacts:
            rep.error(
                "[verifier] environment_mode is \"separate\" but no top-level "
                "artifacts = [...] is declared — the verifier would judge a pristine "
                "environment the agent never touched, and even the gold solution "
                "scores 0"
            )
        else:
            for path in artifacts:
                if not str(path).startswith("/"):
                    rep.error(f"artifacts entry {path!r} is not an absolute path")
        if "network_mode" not in verifier.get("environment", {}):
            rep.warn(
                "a \"separate\" verifier with no [verifier.environment] network_mode "
                "inherits the agent policy — a public agent box means a public "
                "verifier box, answer keys and all"
            )
    else:
        if verifier.get("network_mode"):
            rep.error(
                "[verifier] network_mode is refused on a \"shared\" verifier — it runs "
                "in the agent's own box, so nothing would enforce it"
            )
        if cfg.get("artifacts"):
            rep.warn(
                "artifacts is declared but the verifier is \"shared\" — it already sees "
                "the agent's box, so the list does nothing"
            )

    for phase, table in (("agent", cfg.get("agent", {})), ("verifier", verifier)):
        timeout = table.get("timeout_sec")
        if timeout is not None and not _positive_number(timeout):
            rep.error(f"[{phase}] timeout_sec must be a positive number, got {timeout!r}")

    user = cfg.get("agent", {}).get("user")
    if user is not None and str(user).isdigit():
        rep.error(
            f"[agent] user {user!r} is a bare uid — declare the user by name so the "
            "agent gets its own home"
        )


def check_verifier_env(cfg: dict, rep: Report) -> None:
    for key, value in cfg.get("verifier", {}).get("env", {}).items():
        if not isinstance(value, str) or not ANY_TEMPLATE.search(value):
            continue
        whole = WHOLE_TEMPLATE.match(value)
        if not whole:
            rep.error(
                f"[verifier.env] {key} = {value!r} embeds a ${{...}} template in a larger "
                "string — templates are honored only as the entire value"
            )
            continue
        name, default = whole.group(1), whole.group(2)
        if name in JUDGE_TEMPLATES:
            continue
        if default is None:
            rep.error(
                f"[verifier.env] {key} = {value!r} is a non-judge template with no "
                "default — there is no host environment to resolve it from, so it is "
                "refused at import"
            )


def check_test_script(task: Path, rep: Report) -> None:
    scripts = [p for p in [task / "tests" / "test.sh"] if p.is_file()]
    scripts += sorted((task / "steps").glob("*/tests/test.sh")) if (task / "steps").is_dir() else []
    for script in scripts:
        body = script.read_text(encoding="utf-8", errors="replace")
        helpers = " ".join(
            p.read_text(encoding="utf-8", errors="replace")
            for p in script.parent.rglob("*")
            if p.is_file() and p != script
        )
        haystack = body + helpers
        # The reward FILENAME is fixed; the directory is routinely built from a
        # variable, so match on the filename rather than the whole path.
        if not re.search(r"reward\.(txt|json)", haystack):
            rep.error(
                f"{script.relative_to(task)} (and its helpers) never writes "
                "reward.txt or reward.json — the reward file is the verdict, never "
                "the exit code"
            )
        elif "verifier" not in haystack:
            rep.warn(
                f"{script.relative_to(task)} names a reward file but never mentions "
                "the verifier/ directory — the reward must land in "
                "/logs/verifier/reward.{txt,json}"
            )


def check_tests_dockerfile(task: Path, cfg: dict, rep: Report) -> None:
    dockerfile = task / "tests" / "Dockerfile"
    if not dockerfile.is_file():
        return

    separate = cfg.get("verifier", {}).get("environment_mode", "shared") == "separate"
    built_from_dockerfile = (task / "environment" / "Dockerfile").is_file()
    really_built = separate and built_from_dockerfile and not cfg.get(
        "environment", {}
    ).get("docker_image")
    if really_built:
        return

    for lineno, raw in enumerate(dockerfile.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        instruction = line.split(None, 1)[0].upper()
        if instruction in TRIVIAL_INSTRUCTIONS:
            continue
        if instruction == "RUN" and re.match(r"RUN\s+chmod\b", line, re.IGNORECASE):
            continue
        rep.error(
            f"tests/Dockerfile:{lineno} uses {instruction} but this task's verifier "
            "image is not built (only a \"separate\" verifier over "
            "environment/Dockerfile builds one) — the dependencies would be silently "
            "missing, so a non-trivial recipe is refused at import"
        )


def validate(task: Path) -> Report:
    rep = Report(task)
    config_path = task / "task.toml"
    if not config_path.is_file():
        rep.error("task.toml is missing (required)")
        return rep

    try:
        cfg = tomllib.loads(config_path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        rep.error(f"task.toml does not parse: {exc}")
        return rep

    if not cfg.get("schema_version"):
        rep.warn("task.toml declares no schema_version")

    check_required_files(task, cfg, rep)
    check_environment(task, cfg, rep)
    check_verifier(task, cfg, rep)
    check_verifier_env(cfg, rep)
    check_test_script(task, rep)
    check_tests_dockerfile(task, cfg, rep)
    return rep


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2

    failed = False
    for arg in argv:
        task = Path(arg)
        if not task.is_dir():
            print(f"== {task}\n  ERROR  not a directory")
            failed = True
            continue
        rep = validate(task)
        rep.render()
        failed = failed or bool(rep.errors)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
