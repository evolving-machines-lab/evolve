---
title: "Error codes"
description: "Every known code, what it means, and what to do next."
---

Use `code` to identify a failure. Read `param` for the input to fix and `details` for the full context. See [Errors](/sdk-reference/errors) for TypeScript and Python handlers.

This catalog covers all 122 codes known to the SDK. A newer server can add codes; [Meta](/sdk-reference/meta) lists the deployment's vocabulary.

**Info:**

An API refusal raises an SDK exception. An accepted import can fail later and return a `failure` record instead. A skipped trial appears in `skipped_trials`. The [job import section](#job-imports) separates these cases.

## Keys, credits, and quotas

| Code | Meaning and next step |
| --- | --- |
| `missing_authorization` | The request has no usable authorization. Supply an Evolve API key. |
| `invalid_api_key` | The key is invalid, or a key lookup found no matching key. Check the key or key ID used by the request. |
| `read_only_key` | This operation changes data. Use a key with write access. |
| `credential_service_unavailable` | The credential service could not complete an authentication, key, credit, or organization-budget operation. Retry after the supplied delay. |
| `rate_limited` | The request rate exceeded its limit. Wait for `retryAfterSec` / `retry_after_sec`. |
| `insufficient_credits` | The account has no remaining credits. Add credits before starting more work. |
| `quota_exceeded` | The request would exceed the organization's queued-trial limit. Read `details` for the limit, usage, and requested count. No fixed retry delay is supplied. |

## Request inputs

| Code | Meaning and next step |
| --- | --- |
| `invalid_json` | The JSON body or JSON form part could not be parsed, or a required object was not an object. Correct its structure. |
| `invalid_input` | An input failed validation or exceeded a limit. Read `message`, `param`, and `details`; this code covers several input rules. |
| `invalid_limit` | `limit` is not an integer within the endpoint's allowed range. Use the range named in the message. |
| `invalid_status` | A status filter is not supported. Choose one of the values named in the response. |
| `invalid_visibility` | Visibility is neither `public` nor `private`. |
| `invalid_cursor` | The collection cursor is invalid for this request. Use a `nextCursor` returned by the same collection and sort order. |
| `invalid_after` | The stream resume position is invalid. Use an event ID from that stream; its format depends on the stream. |
| `invalid_format` | The requested output format is not supported. Use a format named in the message, or omit it for the default. |
| `invalid_ids` | A stop request has an invalid trial-ID list: it must contain 1–100 nonempty IDs. |
| `invalid_multipart` | The upload is not valid `multipart/form-data`. Correct the content type and form parts. |
| `idempotency_key_reused` | This idempotency key belongs to a different request. Repeat the original request exactly, or use a new key for new work. |

## Datasets and tasks

| Code | Meaning and next step |
| --- | --- |
| `dataset_not_found` | The dataset does not exist or is not visible to you. Check its name and your access. |
| `dataset_version_not_found` | The requested dataset version was not found. List the dataset's versions and use an existing one. |
| `dataset_name_taken` | The dataset name is already in use and unavailable to this publish. Choose another name. |
| `dataset_in_use` | Jobs still reference the dataset, so it cannot be deleted. Read `details.job_count` and `details.sample_job_ids`. |
| `dataset_not_owned` | You cannot perform this dataset operation with the current ownership or credentials. Read the message for the required owner or administrator access. |
| `dataset_import_in_progress` | Visibility cannot change while an import is queued or running. Wait for the import to finish. |
| `upstream_not_watchable` | Auto-import was requested for a dataset with no moving Git ref to follow. It has no watchable upstream. |
| `no_active_version` | A dataset was selected without a version, but it has no active version. Pin a ready version or activate one. |
| `version_not_ready` | The operation requires a `READY` dataset version. Inspect the version's state and import progress. |
| `version_not_activatable` | A `FAILED` or `ARCHIVED` version cannot become active. Choose a ready version. |
| `unknown_task_names` | Requested task names are missing from the version. `details.unknown_task_names` contains the complete list. |
| `no_tasks` | The dataset or selection has no runnable tasks. Check the filters and any failed task builds. |
| `task_not_found` | The named task or its build record was not found in the version. Check the task name and version. |
| `task_failed_to_build` | An explicitly selected task failed to build. Read `details.failed_tasks`; fix and publish a new version, or change the selection. |

## Dataset imports and packages

| Code | Meaning and next step |
| --- | --- |
| `import_not_found` | The dataset import was not found or is not visible to you. Check the import ID and account. |
| `import_too_large` | The dataset archive exceeds a receiving or storage limit. Read the stated bound and reduce the archive. |
| `invalid_archive` | The archive cannot be read or contains unsafe entries. Correct the archive before submitting it again. |
| `unpinned_git_ref` | The Git ref is neither a full 40-character commit SHA nor a remote tag. Pin the full commit or a tag. |
| `hub_package_not_found` | The Harbor Hub package does not exist or is private. Check the reference; authenticated Hub sources are not supported. |
| `hub_unreachable` | Evolve could not reach Harbor Hub to resolve the package. Retry the publish when the Hub is reachable. |
| `package_not_retained` | This version has no retained original package. Import the corpus as a new version to retain one. |
| `package_corrupt` | The stored package failed its checksum check and was not served. Keep the request ID when reporting it. |
| `package_missing` | The recorded package is no longer in storage. Import the corpus as a new version to restore a downloadable package. |

## Resumable uploads

These codes apply to chunked dataset and job uploads. They describe the transfer, before an accepted import finishes processing.

| Code | Meaning and next step |
| --- | --- |
| `upload_session_not_found` | The upload session does not exist or belongs to another caller. Check the upload ID and account. |
| `upload_offset_mismatch` | The chunk offset differs from the session's next byte. Probe the offset with `HEAD` and resume there; complete the session if all bytes arrived. |
| `upload_chunk_digest_mismatch` | The chunk failed its checksum check; none of that chunk was stored. Send the correct chunk again. |
| `upload_incomplete` | Completion was requested before all declared bytes arrived. Send the remaining chunks, then complete. |
| `upload_archive_digest_mismatch` | The assembled archive failed its checksum check. The assembled object was deleted; start a new upload. |
| `upload_session_failed` | The session already failed. Read `details.failure` and start a new upload after addressing the cause. |

## Harness settings

| Code | Meaning and next step |
| --- | --- |
| `agent_version_not_found` | The pinned harness version is not published. Choose an available version. |
| `agent_version_unresolvable` | Evolve could not resolve the latest unpinned harness version. Retry after the supplied delay. |
| `agent_kwarg_unsupported` | A harness argument is unsupported. Compare `details.unsupported_kwargs` with `details.supported_kwargs`. |
| `agent_config_unsupported` | This harness does not support a native config. Omit it or choose a harness listed in `details.config_supporting_agents`. |
| `agent_config_key_refused` | Native config contains settings that Evolve controls, such as routing or credentials. Remove the keys named in `details.refused_keys`. |
| `agent_preset_unsupported` | This harness cannot apply the requested preset. Choose a supported harness or remove the preset. |
| `agent_retired` | The harness is retired. Use the harness in `details.retired_agents[].replaced_by`; its past runs stay readable. |

## Registered agents

| Code | Meaning and next step |
| --- | --- |
| `agent_not_found` | No registered agent with this name is available to you. Check the name and organization. |
| `agent_name_taken` | You already have an agent registered with this name. Update that registration or choose another name. |
| `agent_name_reserved` | The name belongs to a built-in harness. Choose another name. |
| `agent_invalid_name` | The name does not match the allowed pattern or length. Follow the pattern in the message. |
| `agent_source_required` | Registration has no source. Supply an install script or a source archive. |
| `agent_source_conflict` | Both source forms were supplied. Choose either an install script or an archive. |
| `agent_invalid_env` | The environment map is malformed, too large, overrides a reserved variable, or contains a credential-like name. Correct the entry named in the message. |
| `agent_too_large` | The agent archive exceeds its upload limit. Reduce it to the bound in the response. |
| `agent_limit_reached` | The account reached its registered-agent limit. Remove an unused registration before adding another. |

## Skills

| Code | Meaning and next step |
| --- | --- |
| `skill_not_found` | The uploaded skill ID was not found or is unavailable to you. Check the ID and access. |
| `skill_name_not_found` | `name:<skill-name>` has no current upload for this caller. List your skills and check the name. |
| `skill_ref_invalid` | The skill reference list is malformed, exceeds its count limit, or contains an unsupported reference. Read the message; local folders must be uploaded first. |
| `skill_unresolvable` | Evolve could not resolve a skill source to a pinned reference. Read the cause and check that the source can be fetched. |
| `skill_invalid` | The uploaded archive is not a valid skill. Fix the archive or skill content named in the message. |
| `skill_in_use` | An unfinished job references this skill upload. Wait for that job before deleting the skill. |
| `skill_too_large` | The skill archive exceeds its upload limit. Reduce it to the bound in the response. |
| `skill_limit_reached` | The account reached its uploaded-skill limit. Remove unused uploads before adding another. |

## Job secrets

These codes describe secret attachment during job creation. The [managed-secrets client](/sdk-reference/secrets) uses separate error handling.

| Code | Meaning and next step |
| --- | --- |
| `secret_not_found` | No enabled secret matches the requested name and label. Check the stored secret and its label. |
| `secret_ambiguous` | Several labels match the name, with no default to select. Supply an explicit label. |
| `secret_brokered_unsupported` | Jobs cannot attach a secret that uses brokered delivery. Choose a secret intended for direct delivery. |
| `secret_exists` | An inline secret conflicts with an existing stored identity; Evolve will not overwrite it. Attach the stored secret by reference or choose another label. |
| `secret_not_attached` | A task requires a secret with no fallback, and the job did not attach it under the required environment name. Add the attachment. |

## Jobs and trials

| Code | Meaning and next step |
| --- | --- |
| `provider_unsupported` | Selected tasks cannot run on the chosen sandbox provider. Read every reason in `details.refused_tasks` and adjust the provider or selection. |
| `job_not_found` | The job was not found or is not visible to you. Check its ID and your access. |
| `job_not_terminal` | The operation requires a finished job. Wait for it to settle; deletion can also be blocked by a running regrade named in `details`. |
| `no_failed_trials` | Resume or retry found no trials matching its selection. Scored trials, including reward `0`, are not failures. Check the operation's selection rules. |
| `trial_not_found` | The trial or requested run artifact was not found or is unavailable to you. Check the ID, parent job, and artifact. |
| `trial_not_settled` | A retry selected a live trial. Wait until it leaves `QUEUED`, `RUNNING`, or `SCORING`. |
| `concurrent_update` | Cancellation could not be committed because the job changed concurrently. Read the current job state, then retry if needed. |
| `job_uploaded` | Resume, retry, and regrade require a job Evolve executed. Uploaded jobs can still be analyzed. |

## Regrades

| Code | Meaning and next step |
| --- | --- |
| `regrade_source_ineligible` | The trial lacks usable verifier inputs or uses an unsupported regrade setup, such as a multi-step task or LLM judge. Read the recorded reason. |
| `no_regradable_trials` | No selected trial is eligible for regrade. Inspect the original trials and their verifier inputs. |

## Analysis and task checks

| Code | Meaning and next step |
| --- | --- |
| `invalid_rubric` | The analysis or check configuration is invalid. Correct the unknown keys, criteria, or bounds named in the message. |
| `analysis_already_running` | The job already has queued or running analysis. Wait for it to finish before another analysis or job deletion. |
| `analysis_not_found` | The analysis was not found or is not visible to you. Check the analysis ID and access. |
| `analysis_not_terminal` | The analysis download requires a finished run. Wait for `COMPLETED` or `FAILED`. |
| `no_analyzable_trials` | No trial matches the analysis selection: it is empty, only cancelled trials remain, or the reward filter excludes every trial. Adjust the selection. |
| `check_not_found` | The check or task-check ID was not found or is not visible to you. Check the ID and access. |
| `check_not_terminal` | The check download requires a finished check or task check. Wait for `COMPLETED` or `FAILED`. |
| `no_checkable_tasks` | No valid task directories were found, or the filters selected none. Check the source task structure and selection. |

## Job imports

Job upload returns an import record before validation finishes. A later failure is returned as `status: FAILED` with `failure.code`, `failure.message`, and optional `failure.details`. Reading that record can succeed over HTTP.

| Code | Meaning and next step |
| --- | --- |
| `not_a_job_dir` | **Import failure.** Root `result.json` or `config.json` is missing, invalid, or too large to parse. Fix the file and limit named in the failure; see the [job directory format](/core-concepts/upload). |
| `invalid_trial` | **Import failure.** A trial record, lock file, or trace could not be read or accepted. Fix the file and cause named in the failure. |
| `job_already_uploaded` | **Import failure.** You already uploaded the source job ID in this archive. Use `details.existing_job_id` to open the existing record. |
| `trial_too_large` | **Skipped trial.** An artifact exceeds a storage or parsing bound. Read `skipped_trials` for the file and limit; other trials can still import. |
| `upload_too_large` | A job or check upload exceeds a transfer, extraction, or storage bound. It can be an HTTP refusal or a job import failure. Read the file and limit named in the response. |
| `job_import_not_found` | **API refusal.** The job import does not exist or belongs to another caller. Check the import ID and account. |

Job import failures can also use shared codes such as `invalid_archive`, `dataset_not_found`, `dataset_version_not_found`, `no_active_version`, and `version_not_ready`. Preserve an unfamiliar failure code: import failures can include values outside this API vocabulary, such as `import_failed`.

## Filesystems and sessions

| Code | Meaning and next step |
| --- | --- |
| `not_found` | The filesystem path or capture record was not found. Check the path, source, and capture named in the response. |
| `not_captured` | The file is listed, but its bytes were not saved: it was unchanged from the image or omitted during capture. Read `details.reason` when present. |
| `filesystem_state` | The requested live or captured filesystem is unavailable. Read `details.state`; a capture may still be running or no source may remain. |
| `feature_unsupported` | This provider or run does not support the requested filesystem feature. Read `details.feature` and `details.cause`. |
| `provider_unreachable` | The sandbox provider did not answer. Retry after the supplied delay. |
| `task_package_not_retained` | The dataset version has no retained task package, so its task files cannot be served. |
| `session_not_found` | The managed-agent session was not found or is not visible to you. Check the session ID and access. |

## Organizations and invites

| Code | Meaning and next step |
| --- | --- |
| `org_not_found` | The organization does not exist or you are not a member. Check the organization and account. |
| `org_slug_taken` | Another organization already uses this slug. Choose another slug. |
| `org_forbidden` | Your role or credentials do not allow the operation. The message names the restriction; deleting a job requires its creator. |
| `org_personal_immutable` | Personal organizations cannot be modified or deleted, and their permanent owner cannot be changed. Use a team organization for membership changes. |
| `org_last_owner` | This change would remove the organization's last owner. Promote another owner first. |
| `org_in_use` | The organization still owns jobs or datasets and cannot be deleted. `details` provides the counts. |
| `org_member_not_found` | The named user is not a member of this organization. Check the user ID. |
| `invite_not_found` | The invite ID or token was not found. Check the invitation. |
| `invite_invalid` | The invitation is revoked, expired, or out of uses. Read `details.reason` and request a new invite. |

## Temporary server capacity

These are capacity limits, separate from request rate limits. Each response provides `details.max_concurrent`, with no fixed retry delay. Retry after an in-flight operation finishes.

| Code | Operation waiting for capacity |
| --- | --- |
| `too_many_concurrent_upload_chunks` | Receiving another upload chunk. Retry the same chunk offset. |
| `too_many_concurrent_imports` | Receiving another dataset archive. |
| `too_many_concurrent_job_uploads` | Moving another job archive into storage. |
| `too_many_concurrent_check_uploads` | Receiving another task-check archive. |
| `too_many_concurrent_skill_uploads` | Receiving and processing another skill archive. |
| `too_many_concurrent_package_downloads` | Serving another retained package download. |

## Server failures

| Code | Meaning and next step |
| --- | --- |
| `internal_error` | The server encountered an unexpected failure. Keep the request ID when reporting it. |

`unknown_error` is an SDK fallback when a response provides no usable code. It is not one of the 122 codes above. Preserve the status, message, and request ID rather than guessing a cause.
