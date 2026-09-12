"""The platform's job-upload contract, in one place.

Every constant here is a published server limit or a documented ingest rule.
Sources are cited so a reader can re-verify rather than trust this file:

  - Caps are published live at `GET /api/meta` under `limits.uploads`. Read
    them with `evolve_limits()` rather than trusting the frozen defaults; the
    defaults exist only so the tools still run offline.
  - The per-trial ingest whitelist is the server's own `TRIAL_ARTIFACT_FILES`
    plus the two record files.
  - The analyzer's input ceiling is NOT an upload cap. A file between the
    analyzer ceiling and the upload cap is accepted, stored, and then
    head-truncated at analysis time with only an in-band marker. That is why
    the compressor targets the analyzer ceiling, not the upload cap.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

MiB = 1024 * 1024
GiB = 1024 * MiB

# --- Published upload caps (defaults; prefer evolve_limits() at runtime) -----
MAX_JOB_ARCHIVE_BYTES = 512 * MiB       # limits.uploads.job_archive_bytes
MAX_JOB_TRIALS = 2000                   # limits.uploads.job_trials
MAX_TRIAL_FILE_BYTES = 32 * MiB         # limits.uploads.job_trial_file_bytes
MAX_TRIAL_SESSION_BYTES = 128 * MiB     # limits.uploads.job_trial_session_bytes

# --- Server-side caps that are NOT published, and are not raisable by env ----
MAX_DECOMPRESSED_BYTES = 2 * GiB        # the real wall behind the 512 MiB one
MAX_ARCHIVE_ENTRIES = 200_000
MAX_RECORD_FILE_BYTES = 8 * MiB         # result.json / config.json per trial

# --- The analyzer's own ceilings (truncate silently; never refuse) -----------
ANALYZER_FILE_BYTES = 24 * MiB
ANALYZER_TREE_BYTES = 96 * MiB

# --- What ingest stores, per trial ------------------------------------------
# The server's TRIAL_ARTIFACT_FILES, verbatim.
TRIAL_ARTIFACT_FILES = (
    "agent/trajectory.json",
    "agent/stdout.log",
    "agent/stderr.log",
    "verifier/test-stdout.txt",
    "verifier/reward.txt",
)
# Required at the root of a trial dir, and at the root of the job dir. The
# client refuses before packing if either is missing from the JOB root.
RECORD_FILES = ("result.json", "config.json")

# Ingested as a tree, under its own cap. Dead weight for rubric analysis (the
# analyzer never reads it), but it is what the trace viewer serves as the
# native session home — hence a flag, not an unconditional drop.
SESSION_PREFIX = "agent/sessions/"

# The stdout slot's fallback: a harness CLI log directly under agent/, used
# only when agent/stdout.log is absent. Hub archives carry these.
HARNESS_LOG_SUFFIX = ".txt"

# Never ingested. Listed so tools can explain a drop rather than just do it.
NEVER_INGESTED = (
    "artifacts/**", "steps/**", "lock.json", "trial.log",
    "analysis.json", "analysis.md", "verifier/reward.json",
    "verifier/ctrf.json", "evolve.json",
)

DEFAULT_DASHBOARD_URL = "https://dashboard.evolvingmachines.ai"


def evolve_limits(base_url: str | None = None, api_key: str | None = None,
                  timeout: float = 20.0) -> dict | None:
    """Live `limits.uploads` from GET /api/meta, or None if unreachable.

    The caps move — the dataset door was raised 16x above its source default
    without any client change — so a tool that hardcodes them will eventually
    lie. Falling back to the frozen defaults is fine; silently reporting a
    stale cap as if it were live is not, so the caller is told which it got.
    """
    base = (base_url or os.environ.get("EVOLVE_DASHBOARD_URL")
            or DEFAULT_DASHBOARD_URL).rstrip("/")
    key = api_key or os.environ.get("EVOLVE_API_KEY")
    req = urllib.request.Request(f"{base}/api/meta")
    if key:
        req.add_header("Authorization", f"Bearer {key}")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return (json.load(r).get("limits") or {}).get("uploads")
    except (urllib.error.URLError, OSError, ValueError, json.JSONDecodeError):
        return None


def resolve_caps(base_url: str | None = None, api_key: str | None = None,
                 offline: bool = False) -> tuple[dict, bool]:
    """(caps, live) — published caps, preferring the server's own numbers."""
    caps = {
        "job_archive_bytes": MAX_JOB_ARCHIVE_BYTES,
        "job_trials": MAX_JOB_TRIALS,
        "job_trial_file_bytes": MAX_TRIAL_FILE_BYTES,
        "job_trial_session_bytes": MAX_TRIAL_SESSION_BYTES,
    }
    if offline:
        return caps, False
    live = evolve_limits(base_url, api_key)
    if not live:
        return caps, False
    for k in caps:
        if isinstance(live.get(k), int):
            caps[k] = live[k]
    return caps, True


def human(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB"):
        if abs(n) < 1024 or unit == "GiB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{int(n)} B"
        n /= 1024
    return f"{n:.1f} GiB"
