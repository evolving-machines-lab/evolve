---
title: "Uploaded skills: methods"
description: "Upload, read, and delete skill content used by evaluation agents."
---

Use `skills()` or `hosted().skills`. These are skill folders mounted into runs; `evolve skills` separately serves documentation. Examples use a configured `client`. Python examples run inside an async function.

## upload

Store one skill folder or a root containing child skill folders.

```ts TypeScript
const uploaded = await client.upload(
  "./my-skill",
  {
    org: "my-team",
  },
);
```

```python Python
uploaded = await client.upload(
    "./my-skill",
    org="my-team",
)
```

**Returns:** An array/list of `SkillUpload`, one per discovered skill.

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| `directory` | Required local path. Contains `SKILL.md`, or immediate child folders that contain it. |
| `org?` | Organization slug or id. Overrides the client default; otherwise uses your personal organization. |

Identical content under the same name reuses a record. Different content creates a new immutable `upload:<id>` reference and moves `name:<skill-name>` to that record. Existing jobs keep their locked content.

## list

Read one page or iterate all visible uploaded skills.

```ts TypeScript
const page = await client.list({
  scope: "org",
  limit: 20,
});
```

```python Python
page = await client.list(
    scope="org",
    limit=20,
)
```

**Returns:** `SkillUploadPage` when awaited; a `SkillUpload` per iteration.

### Parameters and behavior

| Parameter | Type and meaning |
| --- | --- |
| `scope?` | `my` (default), `shared` (other members’ uploads in your organizations), or `org` (all uploads in your organizations). |
| `limit?`, `cursor?` | Collection pagination; default 50, maximum 200. `for await` / `async for` follows pages. |

Page fields are `items`, `nextCursor`, `hasMore` in TypeScript; `items`, `next_cursor`, `has_more` in Python.

## get

Read uploaded metadata and its `SKILL.md` content.

```ts TypeScript
const skill = await client.get("name:my-skill");
console.log(skill.skill_md);
```

```python Python
skill = await client.get("name:my-skill")
print(skill.skill_md)
```

**Returns:** TypeScript `SkillUpload & { skill_md: string | null }`; Python `SkillUpload` with `skill_md` populated.

### Parameters and behavior

Pass a record id or `name:<skill-name>` as the required argument (`id` in TypeScript, `skill_id` in Python). A name reference resolves only your own current upload. Use a record id for an upload shared through your organization. An unknown name returns `skill_name_not_found`.

## delete

Delete an uploaded record you own.

```ts TypeScript
await client.delete(skillId);
```

```python Python
await client.delete(skill_id)
```

**Returns:** No value (`void` / `None`).

### Parameters and behavior

Pass the record id, not a `name:` reference. A non-terminal job using the record prevents deletion. Completed jobs retain their recorded skill locks.

## Skill fields

### SkillUpload response

`digest` is `sha256:<hex>`. `ref` is the immutable `upload:<id>` handle used by job agent arms. `description` is extracted from `SKILL.md`.

Python returns these fields as dataclass attributes and adds `skill_md: Optional[str]`, defaulting to `None` for list/upload results. TypeScript adds `skill_md` only to the `get` result.

```ts Fields
interface SkillUpload {
  id: string;
  name: string;
  org: string | null;
  digest: string;
  size_bytes: number;
  description: string | null;
  ref: string;
  created_at: string;
}
```
