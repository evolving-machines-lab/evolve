---
title: "Compatibility"
description: "Supported Harbor-format task features and the boundaries of managed evaluation jobs."
---

Evolve imports Harbor-format task packages and exports Harbor-format results. Managed jobs use Evolve's own CLI and API contract. A local runner's configuration is not passed through automatically.

Use the [task field reference](/core-concepts/task-reference) for exact accepted fields and defaults. Before publishing an existing task package, validate it:

```bash
evolve dataset check ./my-dataset
```

Validation checks declarations. Image builds, provider compatibility, and task execution still need their own checks.

## Tasks and execution

| Area | Managed Evolve support |
| --- | --- |
| Task packages | Instructions, `task.toml`, Dockerfiles or public pinned images, tests, optional solutions, skills, MCP, healthchecks, and supported [Compose](/core-concepts/compose) declarations. Unknown task fields are rejected. Windows, Apptainer, TPU configuration, and managed GUI desktop sessions are not provided. |
| Dataset sources | [Publish](/core-concepts/datasets) local files, pinned Git sources, public HTTPS archives, or public Harbor Hub packages, then select the published dataset in a job. Arbitrary JSON task registries and direct local/repository task paths are not managed run sources. |
| Job configuration | Use the documented [run flags](/cli-reference/run) or [SDK job fields](/sdk-reference/jobs). Host plugin classes, install-only runs, runtime mounts, extra Compose overlays, run-level artifact declarations, and per-arm concurrency groups are not accepted job options. |
| Agent harnesses | Use a [built-in harness or registered agent](/core-concepts/agents). Registration takes an install script or uploaded files plus a headless run command. Python `BaseAgent` classes, `acp:<registry-id>` lookup, and `harbor-agent.json` manifests are not registration formats. Managed ACP simulated-user/persona configuration is not provided. |
| Sandbox providers | [E2B, Daytona, and Modal](/core-concepts/sandboxes), subject to each task's resource and network requirements. A local sandbox runner or custom provider plugin cannot be selected for a managed job. |
| Saved conversations | A task-level ATIF file can seed Claude Code or Codex. See [saved conversations](/core-concepts/task-config#start-from-a-saved-conversation). Run-level trajectory loading and a managed trial-to-local-CLI handoff operation are not provided. |
| Multi-step tasks | Ordered steps share a filesystem, with per-step instructions, setup, checks, timeouts, and reward thresholds. [Multi-step tasks](/core-concepts/multi-step) use shared verification; Compose, separate verification, between-step conversation resume, and per-step artifact snapshots are not supported. |

## Verification and records

| Area | Managed Evolve support |
| --- | --- |
| Verifiers | Task `tests/test.sh` runs in a shared or separate sandbox and writes reward files. [Verifier scripts and supported judges](/core-concepts/task-verifiers) can implement custom grading; a host-side `BaseVerifier` class is not a managed input. |
| Regrade | Eligible separate-mode trials can rerun their **recorded verifier** against retained inputs. Regrade does not select a replacement verifier and excludes shared-mode, multi-step, and judge-enabled trials. See [jobs](/core-concepts/jobs). |
| Rewards and metrics | Tasks can produce named rewards, and jobs expose platform aggregates and pass@k. Dataset-level `metric.py` scripts are rejected. Compute additional aggregates from exported results. |
| Artifacts | Root task declarations transfer files for separate verification and export retained payloads in the job archive. Shared verification uses the existing filesystem; inspect live or captured files through the filesystem API. See [trial outputs](/core-concepts/trial-outputs#declared-artifacts-in-the-job-archive). |
| Credentials and images | [Job-attached secrets](/core-concepts/secrets) supply supported agent variables; managed judge credentials use the verifier contract. Task images must be publicly readable. User-managed private image-registry credential storage or selection is not exposed. |
| Sharing and leaderboards | [Share jobs, task checks, and sessions](/core-concepts/sharing), or use team ownership. Public dataset visibility is platform-managed. Job comparison and exported results are available; a user-managed leaderboard object or ranking API is not provided. |

These boundaries describe the managed evaluation service. Custom agent and verifier code still runs within the documented sandbox and credential contracts.
