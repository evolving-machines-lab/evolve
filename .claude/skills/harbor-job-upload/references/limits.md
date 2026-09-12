# Every cap on the job-upload path

## Read them live, do not trust this page

The caps move. The dataset door's source default is 512 MiB and production
serves **8 GiB** — raised by an environment variable with no client change. Any
document that hardcodes these numbers will eventually lie.

```bash
curl -s -H "Authorization: Bearer $EVOLVE_API_KEY" \
  https://dashboard.evolvingmachines.ai/api/meta | jq .limits.uploads
```

`check_job.py` does this for you and says which source it used; `--offline`
falls back to frozen defaults and labels them as such.

## Published caps (`limits.uploads`)

Values observed 2026-09-02. Treat as a snapshot.

| Field | Value | Refusal |
|---|---|---|
| `job_archive_bytes` | 512 MiB | `413 upload_too_large` |
| `job_trials` | 2000 | `400 job_too_large` |
| `job_trial_file_bytes` | 32 MiB | `422 invalid_trial` |
| `job_trial_session_bytes` | 128 MiB | `422 invalid_trial` |
| `dataset_archive_bytes` | 8 GiB | `413 import_too_large` |

## Unpublished server caps

Not in `/api/meta`; found by reading the ingest.

| Cap | Value | Refusal | Raisable |
|---|---|---|---|
| Decompressed footprint | 2 GiB | `413 upload_too_large` | No — hardcoded |
| Tar entries | 200,000 | `400 invalid_archive` | No |
| Record file (`result.json`/`config.json`) | 8 MiB | `400 not_a_job_dir` | No |

**The 2 GiB decompressed cap is the real ceiling.** At the ~1.8x ratio JSON
corpora compress at, a 512 MiB archive expands to roughly 920 MB — comfortably
under. But raising the compressed cap past about **1.1 GiB** buys nothing,
because the decompressed cap bites first. The two have to move together.

## Analyzer ceilings — truncate, never refuse

| Cap | Value | Behaviour |
|---|---|---|
| Per input file | 24 MiB | head-truncated with an in-band marker |
| Whole input tree | 96 MiB | typed inputs failure |

**This is the gap that catches people.** The per-file upload cap (32 MiB) sits
*above* the analyzer's ceiling (24 MiB) deliberately, so nothing accepted is
outright unusable — but a trajectory in between is stored whole and then cut at
analysis time. Compress to 24 MiB, not 32.

## Raising the job archive cap

Ranked by cost:

1. **Set `EVAL_MAX_JOB_UPLOAD_BYTES` on the web task.** An environment variable,
   no code deploy. This is exactly what was already done for the dataset door,
   which is why it serves 8 GiB against the same 512 MiB source default — so the
   mechanism is proven in production, not theoretical. Ceiling: ~1.1 GiB before
   the decompressed cap.
2. **Move `MAX_EXTRACTED_BYTES` (2 GiB) with it** for anything beyond that. A
   code change, and it needs care: ingest runs **synchronously inside one
   request** on a small web task under a 900 s load-balancer idle timeout. The
   trial-count cap exists for the same reason. Raising the byte caps without
   addressing that trades a clean 413 for a timeout partway through ingest.
3. **Just chunk the job.** Several jobs of N trials each upload fine and analyze
   independently. This needs nothing from the platform and is usually the right
   answer.

## Client-side: not the bottleneck

Worth knowing, because it used to be and the folklore persists.

The SDK **streams**. The archive is tarred and gzipped to a temp file, then sent
over raw `node:http` with per-chunk backpressure — a few MB resident regardless
of archive size. The older collect-everything-into-one-Buffer path is gone; it
is what the streaming rewrite was written to fix. If you read a note anywhere
saying job uploads are buffered in memory as one request body, it is stale.

Two client-side details that still matter:

- **A 600 s inactivity timeout**, re-armed on every flushed chunk. It measures
  stalls, not total duration.
- **Job upload is one POST.** The resumable chunked door exists in the SDK but
  only the dataset publish surface passes the threshold that switches to it, so
  a job upload that drops at 90% restarts from zero. Wiring it into job upload
  would not raise any cap; it would remove that failure mode.

## Reading a refusal

Ingest decides in this order, so the first thing that is wrong is what you hear
about: `invalid_archive` → `upload_too_large` (decompressed) → `not_a_job_dir` →
`job_already_uploaded` → dataset resolution → `job_too_large` →
`invalid_trial`.

A `413` on `Content-Length` arrives before any bytes are read, so a too-large
archive fails fast rather than after a long transfer.
