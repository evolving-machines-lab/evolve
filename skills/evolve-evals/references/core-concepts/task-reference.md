---
title: "Task field reference"
description: "Accepted task.toml fields, defaults, and the restrictions Evolve enforces."
---

Use [Task configuration](/core-concepts/task-config) for examples. This page lists the `task.toml` fields accepted by Evolve. Fields are optional unless marked **required**; unknown fields are rejected, except for custom `[metadata]` keys and the untyped descriptive values identified below.

```bash
evolve dataset check ./my-dataset
```

This validates configuration without building images. File layout, image contents, provider compatibility, and runtime checks also apply.

## Document fields

| Field | Accepted value and behavior |
| --- | --- |
| `schema_version` | String: `"1"`, `"1.0"`, `"1.1"`, `"1.2"`, `"1.3"`, `"1.4"`, or `"2.0"`. Omission is recorded as `"unspecified"`; that legacy value is also accepted. |
| `version` | Legacy spelling of `schema_version`. Do not declare both. This is not a dataset version. |
| `metadata`, `task` | Descriptive tables; see below. |
| `agent`, `environment`, `verifier` | Execution tables described below. |
| `solution` | Only `env` is accepted, and it must be an empty table. Solution environment variables are not supported. |
| `source` | Any TOML value. Accepted as provenance information; does not configure execution. |
| `artifacts` | Array of absolute paths or artifact tables; see **Artifacts and collection**. |
| `steps` | Nonempty array of step tables for [multi-step tasks](/core-concepts/multi-step). |
| `multi_step_reward_strategy` | `"mean"` (default) or `"final"`. Requires `steps`; rejected on single-step tasks. |

### Metadata and descriptive task fields

| Field | Accepted value and behavior |
| --- | --- |
| `metadata.task_id` | String matching the task directory name and the task-key grammar. Omit to use the directory name. |
| `metadata.base_commit_hash` | String recorded as the task's base commit; omitted means no recorded base commit. |
| `metadata.category` | String. `"computer-use"` is rejected. `"desktop"` without a Docker image, Dockerfile, or Compose environment is also rejected. |
| `metadata.tags` | Any TOML value; an array containing `"allow-agent-host"` is rejected. |
| Other `metadata.*` | Custom descriptive metadata is accepted. |
| `task.name` | Any TOML value. A nonempty string also identifies the task when matching a [dataset manifest](/core-concepts/datasets#dataset-toml-manifest). It does not replace the task directory key. |
| `task.version`, `task.description`, `task.authors` | Any TOML value; descriptive fields with no execution effect. |
| `task.keywords` | Any TOML value; an array containing `"allow-agent-host"` is rejected. |

The host-agent dependency implied by `allow-agent-host` is unsupported. Task keys are 1–128 characters, contain only letters, digits, `.`, `_`, and `-`, and must begin with a letter or digit.

## Agent

| Field | Accepted value and behavior |
| --- | --- |
| `agent.timeout_sec` | Number of seconds, rounded to the nearest integer; the result must be positive. Default: `3600`. Job timeout multipliers apply separately. |
| `agent.user` | Named POSIX account, or `"root"`, `"0"`, `0`, or an empty string for root. Omission uses the final Dockerfile `USER` when available; otherwise root. Non-root numeric UIDs and `user:group` forms are rejected. |
| `agent.network_mode` | `"public"`, `"allowlist"`, or `"no-network"`; overrides the environment baseline during the agent phase. |
| `agent.allowed_hosts` | Array of nonempty host strings, only with `agent.network_mode = "allowlist"`. An omitted list is empty. |

A named account must already exist, with a usable home directory and `su`. Only the agent runs as this user; the verifier runs as root. `agent.load_trajectory` and `agent.resume_trajectory` are rejected: use the supported task-level `trajectory.json` file described in [Task configuration](/core-concepts/task-config#start-from-a-saved-conversation).

## Environment

These fields belong under `[environment]`. They are also accepted under `[verifier.environment]`, with the different inheritance rules described in **Verifier**.

| Field | Accepted value and behavior |
| --- | --- |
| `docker_image` | Public image reference with an explicit non-`latest` tag or a digest. An untagged image is rejected. Omit to build the task's Dockerfile. |
| `cpus` | Number; default `2`. Import ceiling: `16`. |
| `memory_mb` | Number of MiB; default `8192`. Import ceiling: `32768`. |
| `storage_mb` | Number of MiB; default `10240`. Import ceiling: `524288`. |
| `memory`, `storage` | Legacy size strings such as `"8G"`, `"1024M"`, or `"1048576K"`. Converted to whole MiB; if the corresponding `_mb` field is also set, the values must agree. |
| `gpus` | Integer from `0` to `8`; default `0`. |
| `gpu_types` | Array of nonempty strings. Omitted or empty means any available type; has no effect when `gpus` is `0`. |
| `network_mode` | `"public"`, `"allowlist"`, or `"no-network"`. Default: `"public"`. |
| `allowed_hosts` | Array of nonempty host strings, only with `network_mode = "allowlist"` in the same table. Omitted means an empty list. |
| `allow_internet` | Legacy boolean: `true` means public, `false` means no network. An explicit `network_mode` takes precedence. |
| `workdir` | Absolute path. Resolution: declared path, then Dockerfile `WORKDIR`, then `/app`. A prebuilt image without a declared path uses `/app`. |
| `build_timeout_sec` | Any TOML value is accepted for compatibility, but **does not configure the build timeout**. |

Resource ceilings describe import validation, not availability on every provider. Use [Sandboxes](/core-concepts/sandboxes) and the provider catalog to choose supported CPU, memory, storage, GPU, and network settings.

### Fields specific to the agent environment

| Field | Accepted value and behavior |
| --- | --- |
| `environment.os` | Only `"linux"`. |
| `environment.env` | Table of environment variable names to strings. Names use letters, digits, and `_`, cannot start with a digit, and are at most 128 characters. |
| `environment.skills_dir` | Absolute path other than `/`, captured from the task's source files during import. See [Skills](/core-concepts/skills). |
| `environment.mcp_servers` | Array of MCP server tables below. Default: none. |
| `environment.healthcheck` | Healthcheck table below. Default: none. |

`environment.env` values are literals or whole-value references such as `"${TOKEN}"` and `"${TOKEN:-fallback}"`. References resolve against the secrets explicitly attached to the job under that environment name. They do not read the publisher's shell or unrequested vault secrets. Missing required attachments reject job creation; a declared fallback supplies the literal default.

Embedded references such as `"Bearer ${TOKEN}"` and reserved credential/routing variable names are rejected. The image's startup command receives literals; secret references are delivered to the agent and its child processes. Healthchecks do not receive secret references, and single-container healthchecks do not receive the literal table either. See [Secrets](/core-concepts/secrets).

A `skills_dir` that exists only inside an opaque prebuilt image cannot be captured. TPU fields (`tpu`, `tpu_type`, `tpu_topology`) and non-Linux operating systems are rejected.

### MCP server fields

Each `[[environment.mcp_servers]]` entry accepts:

| Field | Accepted value and behavior |
| --- | --- |
| `name` | **Required.** Unique name, 1–64 letters, digits, `.`, `_`, or `-`; first character must be a letter or digit. |
| `transport` | `"stdio"`, `"sse"` (default), or `"streamable-http"`. `"http"` is an alias for `"streamable-http"`. |
| `url` | Required for remote transports: nonempty HTTP(S) URL without username/password credentials in its authority. Forbidden for `stdio`. |
| `command` | Required nonempty command for `stdio`; forbidden for remote transports. |
| `args` | Array of strings; default `[]`. Used for `stdio` commands; accepted but unused for remote transports. |

Remote servers must be reachable under the task's agent network policy and service topology. Per-server `env` and `headers` fields are not accepted. See [Task environment](/core-concepts/task-environment) for setup examples.

### Healthcheck fields

Both `[environment.healthcheck]` and `[steps.healthcheck]` accept:

| Field | Accepted value and default |
| --- | --- |
| `command` | **Required.** Nonempty command string. |
| `interval_sec` | Positive finite number; default `5`. |
| `timeout_sec` | Positive finite number; default `30`. |
| `start_period_sec` | Nonnegative finite number; default `0`. |
| `start_interval_sec` | Positive finite number; default `5`. |
| `retries` | Integer of at least `1`; default `3`. |

The environment check runs before the agent. A step check runs after that step's workdir files and `setup.sh` are applied, before its agent call. These fields use seconds.

## Verifier

| Field | Accepted value and behavior |
| --- | --- |
| `verifier.timeout_sec` | Number of seconds, rounded to the nearest integer; the result must be positive. Default: `600`. |
| `verifier.environment_mode` | `"shared"` or `"separate"`. Omission selects separate when `verifier.environment` is declared, otherwise shared. |
| `verifier.env` | Table of environment variable names to strings. See template rules below. |
| `verifier.user` | Only `"root"` or numeric `0`; verifier commands always run as root. |
| `verifier.network_mode` | `"public"`, `"allowlist"`, or `"no-network"`. Shared mode must match the restored task environment baseline. |
| `verifier.allowed_hosts` | Array of nonempty host strings, only with `verifier.network_mode = "allowlist"`. |
| `verifier.collect` | Array of collection hook tables; see **Artifacts and collection**. |
| `verifier.environment` | Environment table used for a separate verifier; see below. |

### Verifier environment and variable rules

`[verifier.environment]` accepts the shared **Environment** fields above, plus `os = "linux"`, an empty `env` table, and an empty `mcp_servers` array. Nonempty environment variables or MCP servers are rejected here; put verifier variables under `[verifier.env]`. `skills_dir` and `healthcheck` are not accepted in the verifier environment.

With no verifier environment table, separate mode inherits the task environment configuration. With a declared table, omitted CPU, memory, and storage values inherit task sizing, but omitted GPUs mean `0`, the network baseline defaults to public, and workdir resolves from the verifier's own Dockerfile or `/app`. An explicit shared mode uses the existing agent box; it does not create or resize a verifier box.

Image selection and test delivery depend on the presence of `tests/Dockerfile` and whether the verifier uses its own image. Follow the [verifier environment rules](/core-concepts/task-verifiers); a dedicated prebuilt verifier image must already contain `/tests/test.sh`.

`verifier.env` accepts literals and whole-value judge credential references. A judge reference such as `"${ANTHROPIC_API_KEY}"` requests the managed judge credential; its fallback, if supplied, is ignored. Other references require a fallback, such as `"${JUDGE_MODEL:-my-model}"`, and resolve to that literal fallback. Embedded references and non-judge references without a fallback are rejected. Job-attached agent secrets do not satisfy verifier references. The same rules apply to `steps.verifier.env`.

Supported judge reference names are `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_BASE`, `ANTHROPIC_BASE_URL`, `OPENAI_API_BASE`, and `OPENAI_BASE_URL`.

`verifier.allow_internet` is rejected; use `network_mode` or the legacy field inside an environment table.

## Artifacts and collection

`artifacts` and `steps.artifacts` accept absolute POSIX path strings or tables with the following fields. See [saving outputs](/core-concepts/task-config#save-outputs) and [Compose](/core-concepts/compose) for complete recipes.

Root artifact declarations transfer files to a separate verifier and export retained files in the job archive. Shared verification reads the existing sandbox and does not export this artifact list; use the [sandbox files](/core-concepts/trial-outputs#sandbox-files) to inspect live or captured files. Step artifact declarations do not create per-step snapshots.

| Field | Accepted value and behavior |
| --- | --- |
| `source` | **Required**, unless `path` is supplied. Nonempty absolute POSIX path without NUL bytes. |
| `path` | Alias for `source`; if both are declared, they must agree. |
| `destination` | Optional path relative to the downloaded trial's `artifacts/` directory. No absolute paths, backslashes, NUL bytes, `..` components, bare `.`, or reserved `manifest.json`. Empty means unspecified. |
| `exclude` | Array of nonempty glob strings, applied relative to the source. |
| `service` | Compose service name; defaults to `"main"`. Another service must exist in the task's Compose file. |

Without `destination`, downloaded paths mirror the source path with its leading `/` removed. Excludes match at any path-component boundary; `*` and `?` stay within a component, while `**` crosses `/`. Matching a directory excludes its descendants. Separate verification restores transferred files to their original absolute paths, independent of download destinations.

### Collection hook fields

Each `[[verifier.collect]]` entry accepts:

| Field | Accepted value and behavior |
| --- | --- |
| `command` | **Required.** Nonempty command string. |
| `service` | Declared Compose service name; default `"main"`. Single-container tasks support only `"main"`. |
| `timeout_sec` | Positive finite number of seconds; default `60`. |
| `user` | Nonempty string or nonnegative integer. Compose only; omitted uses the container's user. Any declared value is rejected on single-container tasks, whose hooks run as root. |

Main-service hooks run before main artifacts are downloaded. Sidecar hooks then run before sidecar artifacts are downloaded. Separate verification stops the main service before sidecar hooks; shared verification keeps it running. Per-step collection hooks are not supported.

## Multi-step fields

Every `[[steps]]` entry uses the same shared environment. See [Multi-step tasks](/core-concepts/multi-step) for the directory layout, setup order, and reward calculation.

| Field | Accepted value and behavior |
| --- | --- |
| `name` | **Required.** Unique step directory name, 1–128 letters, digits, `.`, `_`, or `-`; first character must be a letter or digit. |
| `agent.timeout_sec` | Positive finite seconds for this step; otherwise inherits the task agent timeout. |
| `verifier.timeout_sec` | Positive finite seconds for this step; otherwise inherits the task verifier timeout. |
| `verifier.env` | Environment variable table with the same template rules as the task verifier. Nonempty step literals replace task literals; otherwise task literals are inherited. Judge requests inherit separately. |
| `verifier.user` | Only `"root"` or numeric `0`. |
| `min_reward` | Number that gates the `reward` metric, or a nonempty table of metric names to numeric thresholds. Every declared threshold must pass to continue. Omission adds no threshold. |
| `artifacts` | Same grammar as root artifacts. Accepted and stored, but the runner does not take per-step artifact snapshots. Declare final outputs at the task root. |
| `healthcheck` | Same healthcheck table as above, run before this step's agent call. |

Steps cannot override the agent user or either phase's network policy. Per-step verifier `environment`, `environment_mode`, and `collect` are rejected. Multi-step tasks cannot use Compose or separate verification. Every declared step needs a matching `steps/<name>/instruction.md` and an effective `tests/test.sh` from the root/step test files; undeclared step directories are rejected.
