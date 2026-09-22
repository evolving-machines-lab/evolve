---
title: "Identity and teams"
description: "Read your identity, choose a team, and manage invitations."
---

[Method reference: calls, parameters, and response fields](/sdk-reference/methods/auth).

Import `auth` for identity and `orgs` for teams. `hosted().orgs` is also available; `hosted().auth` is not.

## Check your identity

```ts TypeScript
import { auth, orgs } from "@evolvingmachines/evolve";

const identity = await auth().status();
console.log(identity.user_id, identity.email, identity.key.label);
```

```python Python
from evolve import auth, orgs

identity = await auth().status()
print(identity.user_id, identity.email, identity.key.label)
```

The response includes user id, email, and metadata for the API key used. It does not return the key's secret value. `status()` is the auth client's only method.

## Manage API keys over HTTP

Create keys in the [dashboard](https://dashboard.evolvingmachines.ai/api-keys). Choose **Full access** to submit or change work, or **Read-only** to inspect it. Write requests with a read-only key return `403 read_only_key`; full access still respects your account's permissions.

Key listing and revocation are HTTP operations, without corresponding methods in either SDK. These examples use the same `EVOLVE_API_KEY` as the clients:

```bash
EVOLVE_URL="https://dashboard.evolvingmachines.ai"
```

### List your keys

```bash
curl -sS "$EVOLVE_URL/api/auth/keys?limit=50" \
  -H "Authorization: Bearer $EVOLVE_API_KEY"
```

Returns `{ items, nextCursor, hasMore }`, newest first. `limit` defaults to `50`, with a maximum of `200`; pass `nextCursor` as the next request's `cursor`.

Each item has `id`, `label`, `created_at`, and `last_used_at`. Secret values are never returned; `last_used_at` is currently null. Only your own account keys are listed, excluding credentials created for individual runs.

### Revoke a key

Set `$KEY_ID` to an `id` from the list, not the secret key value. Use a full-access key belonging to the same account.

```bash
curl -sS -X DELETE \
  "$EVOLVE_URL/api/auth/keys/$KEY_ID" \
  -H "Authorization: Bearer $EVOLVE_API_KEY"
```

Success returns `204` with no body. An unknown key, another account's key, or a run credential returns `404 invalid_api_key`.

Revocation removes the key, but API servers can continue accepting a cached credential for up to 5 minutes.

## Choose a team

```ts TypeScript
const teams = await orgs().list();
for (const team of teams) console.log(team.slug, team.role);
const team = await orgs().get("my-team");
console.log(team.quota, team.usage);
```

```python Python
teams = await orgs().list()
for team in teams:
    print(team.slug, team.role)
team = await orgs().get("my-team")
print(team.quota, team.usage)
```

`list()` returns an array/list, not a paginated handle. `get` accepts an organization slug or id. Detail includes membership count, quotas, and usage.

Pass `org` in [client configuration](/sdk-reference/index#configure-once) or a supported create call to make that team own the resource.

## Team methods

| Action | TypeScript | Python | Returns |
| --- | --- | --- | --- |
| List your teams | `list()` | `list()` | Organizations |
| Read one team | `get(org)` | `get(org)` | Organization detail |
| Create a team | `create(name, { displayName })` | `create(name, display_name=...)` | Organization |
| Create invite token | `invite(org)` | `invite(org)` | Invite metadata and token |
| Join with token | `join(token)` | `join(token)` | Organization and `already_member` |
| Read members | `members(org)` | `members(org)` | Member list |

`name` in `create` is the slug; display name is optional. Creating an invite requires an organization owner. `invite` uses the server's defaults and takes no expiry/use-limit options in these SDKs.

Team membership enables shared access to team-owned work. It does not grant every creator-only action, such as managing a job's external shares or deleting its record. See [teams](/core-concepts/teams) and [sharing](/core-concepts/sharing).

## Manage teams over HTTP

The operations below are not methods on either SDK client. Prefix each path with `https://dashboard.evolvingmachines.ai` and send `Authorization: Bearer $EVOLVE_API_KEY`. Writes require a full-access key. Send JSON bodies with `Content-Type: application/json`.

Replace `{org}` with the team's slug or id. Get `{userId}` from `orgs().members(org)`; use the `user_id` returned by `auth().status()` when leaving your own membership. Get `{inviteId}` from an invitation's `invite_id`.

### Rename or delete a team

An owner can update the slug, display name, or both:

**`PATCH`** `/api/orgs/{org}`

```json
{
  "display_name": "Acme Lab"
}
```

Optional `slug`: 1–48 lowercase letters, digits, or hyphens; no leading/trailing hyphen or reserved name. `display_name`: 1–120 characters after trimming. Success returns the updated organization; a taken slug returns `409 org_slug_taken`.

`DELETE /api/orgs/{org}` deletes the team and returns `{ deleted: true, org_id }`. It requires an owner and returns `409 org_in_use` while jobs or datasets remain, with their counts in `details`.

### Change a role, remove a member, or leave

An owner can set a member's role to `owner` or `member`:

**`PATCH`** `/api/orgs/{org}/members/{userId}`

```json
{
  "role": "owner"
}
```

Success returns the updated member. `DELETE` on the same path removes that member and returns `{ removed: true, user_id, role }`. Owners can remove others; members can remove themselves to leave.

Demoting or removing the last owner returns `409 org_last_owner`. Promote another owner first. A missing member returns `404 org_member_not_found`.

### Set invitation limits

An owner can create a token with a chosen lifetime and use limit:

**`POST`** `/api/orgs/{org}/invites`

```json
{
  "expires_in_sec": 86400,
  "max_uses": 1
}
```

| Field | Values and default |
| --- | --- |
| `expires_in_sec` | Integer from `60` to `7776000` (90 days), or `null` for no expiry. Omitted: 7 days. |
| `max_uses` | Positive integer, or `null` for unlimited uses. Omitted: unlimited. |

Success returns `201` with invitation metadata and `token`. The token is returned only at creation. CLI and SDK `invite` calls expose neither option and use these defaults.

Joining an existing membership returns `already_member: true` without consuming a use. For a new member, an expired, revoked, or exhausted token returns `410 invite_invalid`; an unknown token returns `404 invite_not_found`.

### List or revoke invitations

Both operations require an owner:

**`GET`** `/api/orgs/{org}/invites`

Returns `{ items }`, newest first. Items contain `invite_id`, `expires_at`, `max_uses`, `uses`, `revoked_at`, and `created_at`; tokens are not included.

**`DELETE`** `/api/orgs/{org}/invites/{inviteId}`

Returns the invitation metadata with `revoked_at` set. Repeating the request leaves it revoked. This prevents new joins without removing existing members. An unknown invitation returns `404 invite_not_found`.

Personal organizations cannot be renamed or deleted, have their membership changed, or issue invitations. These actions return `403 org_personal_immutable`.
