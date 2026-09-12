# What the platform actually stores, and what it reads

Two different questions with two different answers, and conflating them is how
job directories end up 50x larger than they need to be.

1. **Ingest** reads the uploaded archive and stores a fixed set of per-trial
   files. Anything outside that set is uploaded, unpacked, and discarded.
2. **The analyzer never reads your archive at all.** It rebuilds a tree from the
   database and the trace store. So a file that ingest does not store cannot
   reach analysis no matter how it is named.

Verify both against the server's own source before trusting this page:
`lib/evaluations/job-upload.ts` (the ingest, and its deviation ledger in the
module header) and `lib/evaluations/worker/analysis-inputs.ts` (the analyzer's
input tree).

## Per-trial: what ingest stores

| Path | Notes |
|---|---|
| `result.json` | **Required.** A record file, capped at 8 MiB. Carries the verdict, `agent_info`, and `config.agent.{name,model_name}`. |
| `config.json` | **Required.** Record file, same 8 MiB cap. |
| `agent/trajectory.json` | The trace. The one file worth compressing. |
| `agent/stdout.log` | Skipped if empty. |
| `agent/stderr.log` | Skipped if empty. |
| `verifier/test-stdout.txt` | Skipped if empty. |
| `verifier/reward.txt` | Two bytes. Free. |
| `agent/sessions/**` | Ingested **complete**, under a 128 MiB per-trial cap. Served as the native session home by the trace viewer. The **analyzer never reads it** — dead weight for a rubric run, which is why it is opt-in behind `--keep-sessions`. |
| `agent/<harness>.txt` | The stdout slot's **fallback**, used only when `agent/stdout.log` is absent. Hub archives carry these (`claude-code.txt`, `codex.txt`). |

The job directory also needs `result.json` **and** `config.json` at its **root**.
A job dir is not merely a directory of trial dirs; the client refuses before
packing if either is missing, with the same sentence Harbor's CLI uses.

The root `result.json`'s `id` is the server's **dedup key**. Content-address it
over the trial set — keying it on a label alone lets a smoke test collide with
the real job, and lets a re-run create a twin instead of being refused.

## Per-trial: what is never ingested

`artifacts/**` · `steps/**` · `lock.json` · `trial.log` ·
`verifier/reward.json` · `verifier/ctrf.json` · `evolve.json` ·
any prior `analysis.json` / `analysis.md` · any other file under `agent/`
mapping to no native slot.

Two of these are worth calling out:

- **`artifacts/`** is agent *output* — model weights, database dumps, tarballs.
  On a raw Harbor corpus it is routinely the majority of the bytes and it
  carries no reasoning signal. Dropping it is free.
- **A prior analysis is never imported.** This is deliberate: the analyzer must
  not read its own previous verdict.

## What the analyzer reads

Rebuilt server-side from the database, not from your archive:

`result.json` (synthesized lean, from DB rows) · `exception.txt` (only when the
trial recorded an exception) · `agent/trajectory.json` · `agent/stdout.log` ·
`agent/stderr.log` · `verifier/test-stdout.txt` · plus the task's byte-sacred
content from the retained dataset package.

**Every one of those is head-truncated at 24 MiB** with an in-band marker. It is
not a refusal, so nothing tells you it happened except the marker inside the
file. This is the number to compress against.

If the task content cannot be resolved from a dataset package, analysis still
runs — it takes the "task definition is not available" branch, which is Harbor's
own fallback. Passing `-d <dataset>@<version>` at upload is what avoids that.

## The label leak

`verifier/test-stdout.txt` is ingested and handed to the analyzer whole, and
`result.json` carries `verifier_result` and the score. If you are inducing or
validating a rubric, the analyzer is **not blind** — its length alone is a strong
predictor of the verdict. Strip the verdict fields and drop `verifier/` for a
blind run, and do that **after** compression, not before.
