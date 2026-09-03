# Why this skill exists

Every problem below was hit while porting the Terminal-Bench 4 leaderboard
corpus (3,300 trials across 10 rows) onto the platform. They are recorded here
because **all but one of them fail silently** — the upload returns a job id, the
job lists its trials, and the damage only surfaces later when an analysis reads
a trace that is empty, truncated, or missing.

Each entry states the symptom first, because that is what you will actually
have in front of you.

---

## 1. The upload dies with no error and no job

**Symptom.** `evolve upload` on a 4.41 GB job directory produced a zero-byte
log, no error, and no job.

**What was believed at the time.** That the SDK tarred the whole directory into
one in-memory Node buffer and was OOM-killed. The corpus was pruned by hand from
4.41 GB to 1.52 GB to get under it.

**What is actually true now.** That diagnosis is **stale**. The SDK streams:
`hosted/tar.ts` packs entries from disk into a segmented gzip writer that holds
one block at a time, and `hosted/upload.ts` posts the archive over raw
`node:http` with per-chunk backpressure — measured at ~2 MB resident for a
300 MB file. The module header records the incident it was written to fix: a
7.7 GB corpus once cost ~10x its size in RSS and crashed the machine.

**The real constraint is server-side.** `413 upload_too_large` against a
published cap. Nothing on the client bounds the archive.

**Fix.** None needed in the client. What was needed was knowing where the cap
actually lives, which is [references/limits.md](references/limits.md).

---

## 2. Trials upload "successfully" and carry an empty trace

**Symptom.** `evolve upload` returns a job id. `evolve job trials` lists every
trial. The trace viewer shows nothing.

**Cause.** The trajectory was stored gzipped as `agent/trajectory.json.gz`.
Ingest maps a fixed set of per-trial paths to native slots, and
`agent/trajectory.json.gz` matches none of them, so it is unpacked and
discarded. The trial is otherwise valid, so nothing errors.

**How common.** 12 such files had already shipped into previously built job
directories before this was noticed, and **all 20 trials** in the corpus used to
validate this skill were gzipped.

**Fix.** `compress_job.py` accepts a `.gz` twin for any ingest slot and writes
the decompressed bytes. `check_job.py` treats a surviving `.gz` under `agent/`
as an error, not a warning.

---

## 3. Some files never arrive, and nothing says so

**Symptom.** A job directory assembled by symlinking large files uploads with
`result.json` and essentially nothing else.

**Cause.** The packer skips symlinks outright — it neither follows them nor
emits them (`tar.ts`, `listFiles`). A tree built by a script that symlinks its
large files ships as a shell.

**Fix.** Everything is hard-linked (`os.link`, free on one volume, with a
`copy2` fallback across devices) or written outright; source symlinks are
resolved to their target before linking. `check_job.py` flags any symlink under
a trial.

---

## 4. A whole trial vanishes from the corpus

**Symptom.** A row's trial count silently drops. In one case 20 of a row's
trials disappeared between download and upload.

**Cause.** The hub sanitises some numeric fields to a bare `[REDACTED]` token
where a number belongs. That is not valid JSON. Any pipeline that reads
trajectories inside a broad `try/except` drops the trial rather than crashing on
it. Roughly 11% of trials in this corpus carry one.

**Fix.** Every JSON read in this skill goes through a repairing loader that
rewrites `: [REDACTED]` to `: null` before parsing. `check_job.py` reports an
unparseable trajectory as an error and names `[REDACTED]` as the likely cause.

---

## 5. The trace is mangled part-way through analysis

**Symptom.** The analyzer reasons correctly about the start of a trajectory and
then behaves as if the rest does not exist.

**Cause.** **The upload cap and the analysis cap are different numbers.** A file
is refused at 32 MiB by ingest, but the analyzer head-truncates every input at
**24 MiB** with only an in-band marker. A 30 MiB trajectory therefore uploads
clean, stores clean, and is quietly cut when analyzed. Nothing errors at any
stage.

This is the single most expensive gap on the path, because the artifact looks
healthy right up until the verdict is wrong.

**Fix.** `compress_job.py` defaults `--target-bytes` to the 24 MiB analyzer
ceiling, not the 32 MiB upload cap. `check_job.py` warns on any file in the gap
between the two and says explicitly what will happen to it.

---

## 6. Compression shrank the readable copy and left the duplicate

**Symptom.** Trajectories that had been "compressed" were still enormous, and
the observation text a reader needed had been truncated while the file stayed
large.

**Cause.** In ATIF trajectories from harnesses that emit it,
`observation.results[].extra` restates the observation's own `content`, often
twice (`tool_result_metadata.tool_use_result.stdout` and
`raw_tool_result.content`), and `tool_calls[].extra.raw_arguments` restates
`arguments`. The previous clipper truncated only `results[].content` — so it
cut the copy a human or analyzer reads and left the byte-identical duplicate at
full size.

**Fix.** A deduplication pass runs **before** any truncation, and removes a
string only when it is a **substring of the content beside it** — the proof it
carries nothing new. An unfamiliar harness therefore cannot lose data here.

**Measured on real rows** (5 trials each), which also shows why this must be
substring-proven rather than assumed:

| Row | Harness | Removed |
|---|---|---|
| `09-claude-code__sonnet-5` | claude-code | **48.0%** |
| `07-grok-build__grok-4-6` | grok-build | 2.3% |
| `09-grok-build__grok-4-5` | grok-build | 2.5% |
| `08-codex__gpt-5-6-luna` | codex | 0.9% |

The duplication is harness-shaped. **A codex row that suddenly shrinks a lot
means the deduplicator is deleting something real** — treat it as a bug.

Losslessness is asserted, not assumed: across all 20 trials, every step
`message`, every tool call, and every observation `content` is byte-identical
before and after, while the claude-code row still lost 48% of its bytes.

---

## 7. Truncation destroyed the evidence the rubric needed

**Symptom.** A uniformly truncated trace loses the end of the run, which is
exactly where a failure is adjudicated.

**Cause.** Flat truncation treats the first command and the final verification
as equally important. They are not: 703 of 738 failures in this corpus are
`agent_declared_done`, so the question a rubric asks is *why did it believe it
was done* — and the answer is in the last few observations.

**Fix.** Clipping is per-observation head+tail down a budget ladder
(20k → 400 chars), the last 8 observations get 4x budget, and a step's `message`
is never touched and no step is ever dropped. Verified at a deliberately harsh
1 MiB budget: the ladder settled at the 8,000-char rung, no head observation
exceeded its budget, all 8 tail observations came through untouched, and the
final observation ended byte-identically.

---

## 8. There was no way to know before shipping

**Symptom.** Every constraint above was discovered after a long upload, or after
an analysis produced a bad verdict.

**Cause.** `evolve upload` takes one flag (`-d/--dataset`). No dry run, no
exclude, no size preflight. The published caps are also not static — the dataset
door's source default is 512 MiB and production serves 8 GiB, so any tool that
hardcodes them eventually lies.

**Fix.** `check_job.py` runs every check before a byte moves. Archive size is
**measured** — the directory is tarred and gzipped to a temp file exactly as the
SDK does — because the compression ratio ranges from 1.0x on blobs to 5.0x on
JSON and an estimate is worthless near a cap. Caps are read live from
`GET /api/meta`, and the output states whether they came from the server or from
frozen defaults.

---

## What was verified, and what was not

Built four jobs (the bottom four TB4 leaderboard rows, 5 trials each, 20 trials
total) and uploaded them.

Confirmed:

- All 20 trials landed with **non-empty traces**, 68–630 events each, scaling
  consistently with local step counts per harness.
- All four job dirs passed every cap check, with caps read live from the API.
- Compression is byte-lossless on every analyzer-visible field across all 20.
- The truncation ladder and its tail protection behave as described.
- Three analyses completed and produced substantive, trajectory-grounded
  verdicts (13 rubric checks each) citing detail from deep inside compressed
  traces — `no_harness_error=pass` on all three.

Not confirmed:

- 7 of 10 analysis runs failed with `phase: stopped — the analyzer box was
  killed`. This is **infrastructure, not input**: the failures land in a
  6-second window spanning an unrelated job, and across 200 recent
  platform-wide analyses (118 failed) **not one failure of any kind was an
  inputs failure**. The compressed trees were never rejected. But the full
  5-of-5 analysis pass has not been observed.

---

## Open follow-ups, deliberately not in this change

- **Raising the job archive cap.** `EVAL_MAX_JOB_UPLOAD_BYTES` on the web task.
  This is a proven path, not a theoretical one — the dataset door has the same
  512 MiB source default and serves 8 GiB in production. It must move together
  with the hardcoded 2 GiB decompressed cap, which otherwise binds first at
  around 1.1 GiB compressed.
- **A resumable job upload.** `datasets().publish()` passes a resumable
  threshold and gets a chunked door that resumes from the last acknowledged
  chunk; `jobs().upload()` does not, so a link that drops at 90% restarts from
  zero. Wiring it is a one-line client change **and a server door that does not
  exist yet for jobs** — it would not raise the cap, only remove the
  restart-from-zero failure. Its own PR.
- **An `exclude` hook in the packer.** `SKIP` in `tar.ts` is a module-level
  three-name constant with no seam. An exclude option on `uploadDirectory` would
  let callers drop `artifacts/**` at pack time instead of pre-pruning the tree,
  which is what this skill does by hand.
