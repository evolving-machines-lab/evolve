---
title: "HTTP API"
description: "Submit and inspect evaluations from any language."
---

The CLI and SDKs call the same HTTP API. Use it directly when you need another language or an operation without an SDK method.

## Connect

Use `https://dashboard.evolvingmachines.ai` as the origin. Send your [API key](/getting-started/installation#connect-your-account) in the `Authorization` header. Writes require a full-access key.

```bash
curl -sS https://dashboard.evolvingmachines.ai/api/auth/status \
  -H "Authorization: Bearer $EVOLVE_API_KEY"
```

`GET /api/meta` needs no key. It lists the current harnesses, models, limits, and error codes.

## Start one evaluation

Save the request as `job.json`:

```json job.json
{
  "datasets": [{
    "name": "harbor-examples",
    "version": "1.0",
    "task_names": ["hello-world"]
  }],
  "agents": [{
    "name": "codex",
    "model_name": "gpt-5.6-luna"
  }],
  "max_trial_spend_usd": 1,
  "retry": {"max_retries": 0}
}
```

```bash
curl -sS https://dashboard.evolvingmachines.ai/api/jobs \
  -H "Authorization: Bearer $EVOLVE_API_KEY" \
  -H "Content-Type: application/json" \
  --data-binary @job.json
```

Success returns `202` and the accepted job. Set `$JOB_ID` to its `id`. Closing the HTTP connection does not cancel the evaluation.

The JSON fields match the [SDK job inputs](/sdk-reference/jobs#required-inputs). Add `org` to create the job in a team. Attach stored secrets through the request's [secret references](/sdk-reference/secrets#attach-it-to-a-job).

**Note:**

To retry the same submission safely after a transport failure, send an `Idempotency-Key` header with a unique value for that intended job. Reuse it only for retries of that submission. A new intended run needs a new key.

## Follow the result

### Read status

```bash
curl -sS "https://dashboard.evolvingmachines.ai/api/jobs/$JOB_ID" \
  -H "Authorization: Bearer $EVOLVE_API_KEY"
```

### Read trials

```bash
curl -sS "https://dashboard.evolvingmachines.ai/api/jobs/$JOB_ID/trials" \
  -H "Authorization: Bearer $EVOLVE_API_KEY"
```

### Stream progress

```bash
curl -N "https://dashboard.evolvingmachines.ai/api/jobs/$JOB_ID/events" \
  -H "Authorization: Bearer $EVOLVE_API_KEY"
```

This endpoint returns server-sent events. The SDK watchers handle reconnection for you; `curl` does not.

## Page through collections

Collections use `{ items, nextCursor, hasMore }`. Pass the returned `nextCursor` as `cursor` on the next request, keeping the same filters. Treat it as an opaque string.

```bash
curl -sS --get https://dashboard.evolvingmachines.ai/api/jobs \
  -H "Authorization: Bearer $EVOLVE_API_KEY" \
  --data-urlencode "limit=20" \
  --data-urlencode "cursor=$NEXT_CURSOR"
```

## Handle an error

An API refusal returns a non-success HTTP status and an `error` object:

| Field | Use |
| --- | --- |
| `code` | Choose how your client handles the failure |
| `message` | Explain the problem to the caller |
| `param`, `details` | Locate invalid input or read failure context, when present |
| `request_id` | Identify the request when reporting a problem |
| `retryAfterSec` | Requested delay, when present; also sent as `Retry-After` |

The response also includes `X-Request-Id`. See [error handling](/sdk-reference/errors) for common codes and the difference between retrying an HTTP request and retrying a trial.

## Operations beyond the SDK methods

| Need | Reference |
| --- | --- |
| List or revoke API keys | [Key management](/sdk-reference/auth#manage-api-keys-over-http) |
| Manage team names, roles, and invitations | [Team management](/sdk-reference/auth#manage-teams-over-http) |
| Filter or sort the dataset catalog | [Dataset filters](/sdk-reference/datasets#browse-the-catalog) |
