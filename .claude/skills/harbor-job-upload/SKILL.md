---
name: harbor-job-upload
description: "Prepare and upload a Harbor job directory to the Evolve platform with `evolve upload`. Use when a job directory is too large to upload, when an upload is refused (413 upload_too_large, 422 invalid_trial, 400 not_a_job_dir, 400 invalid_archive, 409 job_already_uploaded), when trials upload successfully but their traces are empty or truncated in the trace viewer or analyzer, or when compressing / pruning / shrinking agent trajectories before shipping a trial corpus."
---

# Uploading a Harbor job to Evolve

`evolve upload <job_dir> -d <dataset>` ports a Harbor job to the platform;
`evolve analyze <job-id> -r <rubric>` then runs a rubric server-side. Uploading
is where corpora go wrong, and **the expensive failures are silent** — a job
that lands with an empty trace looks exactly like a job that worked.

## The one thing to get right

Ship **only what ingest stores**, and size the trajectory against the
**analyzer's** ceiling, not the upload cap.

The upload cap and the analysis cap are different numbers, and the gap between
them is a trap: a 30 MiB trajectory is under the 32 MiB per-file upload cap, so
it uploads clean — and is then **head-truncated at 24 MiB when analyzed**, with
only an in-band marker to say so. Nothing errors. Target 24 MiB.

See [references/ingest-contract.md](references/ingest-contract.md) for the exact
keep/drop map and [references/limits.md](references/limits.md) for every cap and
which of them can be raised. [ISSUES.md](ISSUES.md) records each failure this
skill exists to prevent, how it was diagnosed, and what was measured.

## Workflow

```bash
S=<this-skill>/scripts

# 1. Build a compressed job dir from trial dirs. --dry-run reports and writes nothing.
python3 $S/compress_job.py --out jobs/my-job --trial path/to/trial1 --trial path/to/trial2 \
        --report out/compress_my-job.json --dry-run

# 2. Build it for real, then check it against every cap before shipping.
python3 $S/compress_job.py --out jobs/my-job --from-list trials.txt --report out/compress_my-job.json
python3 $S/check_job.py jobs/my-job          # exit 1 on any violation

# 3. Upload, then verify the trace actually landed.
evolve upload jobs/my-job -d my-dataset@1.0 --json
evolve trial trace <trial-id> --limit 1000 | head
```

**Never skip step 3's trace check.** `evolve upload` returning a job id proves
the archive was accepted, not that the trials carry a readable trace.

## The silent failures, and what handles each

| Symptom | Cause | Handled by |
|---|---|---|
| Trial uploads, trace is empty | `agent/trajectory.json.gz` — the `.gz` name maps to no ingest slot | `compress_job.py` decompresses on the way in; `check_job.py` refuses any surviving `.gz` |
| Some trials missing entirely, no error | a symlinked file — the packer skips symlinks and never follows them | everything is hard-linked or written; `check_job.py` flags symlinks |
| A whole trial vanishes from the corpus | a `[REDACTED]` token where a number belongs — not valid JSON, so a broad `except` drops it | repaired on every read |
| Trace is mangled mid-way through analysis | trajectory between 24 and 32 MiB — accepted, then head-truncated by the analyzer | the default `--target-bytes` is the 24 MiB analyzer ceiling |
| `413 upload_too_large` | archive over the published cap | chunk the trials across several jobs; see limits.md before asking for a raise |
| `409 job_already_uploaded` | the job id is content-addressed over the trial set; re-uploading the same trials is refused | change the trial set, or pass `--job-id-seed` |

## How the trajectory shrinks

Three transforms, in order. The first two are **lossless** for anything that
reads the trace and run unconditionally; the third is the only lossy one and
runs only if the file is still over budget.

1. **Deduplicate.** `observation.results[].extra` restates the observation's own
   `content`, and `tool_calls[].extra.raw_arguments` restates `arguments`. A
   string is removed only when it is a **substring of the content beside it** —
   that is the proof it carries nothing new, so an unfamiliar harness cannot
   lose data here.
2. **Strip base64.** Inline image payloads, replaced by a byte count.
3. **Clip observations.** Per-observation head+tail truncation down a budget
   ladder, with the last 8 observations at 4x budget. It never touches a step's
   `message` and never drops a step, so the reasoning and the action sequence
   survive intact; a failure's evidence is concentrated in the final
   verification command and its output, which is why the tail is protected.

**Expect wildly different yields by harness.** The duplication in step 1 is
claude-code-shaped. Measured on real TB4 rows: **48% removed** on a
claude-code row, **~1%** on a codex row, **~2-5%** on grok-build. A codex row
that suddenly shrinks a lot means the deduplicator is removing something real —
treat it as a bug, not a win.

## Reading the report

`--report` writes per-trial numbers: bytes in and out, how many duplicate
strings and base64 fields went, which ladder rung fired, what was dropped and
why. Two fields matter most:

- `lossy_trials` — the trials where clipping fired. Empty is the good case.
- `reduction_vs_source_dir_pct` — against the **whole** trial directory with
  `.gz` members counted decompressed. Content against content: measuring a
  gzipped input against plain-JSON output makes decompressing a trajectory look
  like a 300% regression.

## Ordering constraint

If you also blind a job (stripping verdicts for an unbiased analysis), **compress
first, then blind.** A blinding pass that hard-links trajectories through will
carry an uncompressed trace into the blind job.
