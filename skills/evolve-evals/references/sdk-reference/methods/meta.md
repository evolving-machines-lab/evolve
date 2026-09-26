---
title: "Capabilities: method and fields"
description: "Read harness, model, provider, status, and limit information."
---

Read live capability values rather than storing a fixed harness, model, or provider list. No API key is needed.

Python examples run inside an async function.

## meta

Fetch the capability document from the selected API origin.

```ts TypeScript
import { meta } from "@evolvingmachines/evolve";

const capabilities = await meta();
console.log(
  capabilities.agents,
  capabilities.limits,
);
```

```python Python
from evolve import meta

capabilities = await meta()
print(
    capabilities.agents,
    capabilities.limits,
)
```

**Returns:** `CapabilityDocument`. Also available as `hosted().meta()`.

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| TypeScript `meta(config?)` | `HostedClientConfig`; optional `baseUrl` chooses the origin. |
| Python `meta(config=None)` | `HostedClientConfig`; optional `base_url` chooses the origin. |

Origin precedence: explicit config, `EVOLVE_DASHBOARD_URL`, then `https://dashboard.evolvingmachines.ai`. `apiKey` / `api_key` and `org` are not sent. `schema_version` identifies the capability schema, not the SDK release.

## Capability fields

TypeScript returns the typed object below. Python uses dataclasses for the document, agents, providers, and status vocabularies. Nested policy objects such as `limits`, `agent_registration`, `analyze`, provider `sizing`, and provider `gpus` are Python dictionaries.

### CapabilityDocument: SDK field definitions

`limits` reports current values for this deployment. `default_model` is a picker suggestion; managed evaluation jobs still require a model. Optional fields may be absent on older servers; Python maps missing `analyze` and `gpu_concurrency_cap` to `None`, and missing `retired_agents` to an empty list.

```ts Fields
interface CapabilityDocument {
  schema_version: number;
  agents: AgentCapability[];
  retired_agents?: RetiredAgent[];
  agent_registration: {
    name_pattern: string;
    max_name_length: number;
    max_run_command_length: number;
    max_install_script_length: number;
    max_env_entries: number;
    max_per_user: number;
    max_upload_bytes: number;
    reserved_names: string[];
    reserved_env_keys: string[];
  };
  sandbox_providers: ProviderCapability[];
  gpu_concurrency_cap?: number;
  managed_providers: ManagedProviderCapability[];
  platform_constraints: { capability: string; reason: string }[];
  network_modes: string[];
  statuses: {
    job: StatusVocabulary;
    trial: StatusVocabulary;
    import: StatusVocabulary;
    dataset_version: StatusVocabulary;
  };
  analyze?: {
    default_model: string;
    reasoning_efforts: string[];
    models: { alias: string; model_id: string; default_reasoning_effort: string }[];
  };
  limits: {
    job: {
      n_concurrent_trials: { default: number; max: number };
      default_max_trial_spend_usd: number;
      default_max_retries: number;
      default_sandbox_provider: string;
      default_sizing: { cpus: number; memory_mb: number; storage_mb: number };
      model_required: boolean;
      default_agent_timeout_sec: number;
      default_verifier_timeout_sec: number;
      reasoning_efforts: string[];
      default_reasoning_effort: string;
    };
    compare: { min_ids: number; max_ids: number };
    pagination: {
      collections: { default: number; max: number };
      dataset_tasks: { default: number; max: number };
      trace_events: { default: number; max: number };
    };
    uploads: {
      dataset_archive_bytes: number;
      job_archive_bytes: number;
      archive_bytes_source: string;
      agent_tarball_bytes: number;
      skill_archive_bytes: number;
      skill_uploads_per_user: number;
    };
    dataset_names: {
      pattern: string;
      max_name_length: number;
      max_version_length: number;
      max_git_url_length: number;
      max_git_ref_length: number;
      max_git_path_length: number;
    };
    max_items_named_in_error_message: number;
  };
  import_warning_codes: string[];
  error_codes: string[];
}
```

### Additional fields returned by the API

The API also returns the fields below. TypeScript keeps them in the response, although this SDK's `CapabilityDocument` type does not declare them. Python keeps the nested `limits` and `sizing` dictionaries, but its status objects omit `description`.

| Field | Meaning |
| --- | --- |
| `limits.job.default_timeout_multiplier` | Default multiplier for phase time limits. |
| `limits.job.binary_effort_values` | Accepted values for harnesses whose reasoning can only be on or off. |
| `limits.job.max_job_name_length` | Maximum job-name length. |
| `limits.stop.max_trial_ids`, `max_run_ids` | Maximum IDs in the respective stop requests. Both fields belong to `limits.stop`. |
| `limits.dataset_names.reserved_names` | Names reserved for dataset API routes. |
| `sandbox_providers[].sizing.storage_ceiling_source` | Where the storage limit came from: `live-quota`, `fallback`, or `provider-constant`. |
| `statuses.*.description` | Description of each status set; available in the HTTP response and TypeScript object. |

### Harnesses and models

`agents` lists the harnesses a new job may name; a retired harness appears only in `retired_agents`, with the harness that replaces it. `effort_support` is `level`, `binary`, or `none`. `runnable: false` includes a reason. `supports_config` controls native settings support; `presets` lists accepted named presets. Python defaults missing `supports_config` to `False` and `presets` to an empty list. `latest_version: null` means unknown, not current.

```ts Fields
interface AgentModelOption {
  alias: string;
  model_id: string;
  description: string | null;
}

interface RetiredAgent {
  agent: string;
  replaced_by: string;
}

interface AgentCapability {
  name: string;
  runnable: boolean;
  reason: string | null;
  default_model: string | null;
  models: AgentModelOption[];
  effort_support: AgentEffortSupport;
  default_effort: string | null;
  version_pinnable: boolean;
  supports_config?: boolean;
  presets?: string[];
  latest_version?: string | null;
}
```

### Evaluation sandbox providers

`sizing.storage` distinguishes chosen storage sizes from a fixed allocation. GPU support may declare a fallback through `degrades_to`. `gpus.source` distinguishes a live quota result, fallback, or provider constant. `refuses` names unsupported capabilities.

```ts Fields
interface ProviderCapability {
  name: string;
  default: boolean;
  sizing: {
    max_cpus: number;
    max_memory_mb: number;
    max_storage_mb: number;
    storage: "sized" | "fixed";
  };
  gpus?: {
    supported: boolean;
    max_gpus: number;
    degrades_to?: "modal";
    reason?: string;
    source?: "live-quota" | "fallback" | "provider-constant";
  };
  refuses: { capability: string; reason: string }[];
}
```

### Managed runtime providers and status vocabularies

`configured` checks required operator configuration; it is not a service health check. `agent_sessions` says whether the separate managed-agent runtime supports full sessions through that provider. Status vocabularies list all values and their terminal subset.

```ts Fields
interface ManagedProviderCapability {
  name: string;
  configured: boolean;
  requires_config: string[];
  missing_config: string[];
  agent_sessions: boolean;
  agent_sessions_reason: string | null;
}

interface StatusVocabulary {
  values: string[];
  terminal: string[];
}
```
