---
title: "Sharing"
description: "Give someone read access to a job, check, or managed-agent session."
---

Share a run you created by email or by an unlisted link. Both can be enabled at the same time.

| Method | Who can open it? | Sign-in |
| --- | --- | --- |
| Email | The account using that address. | Required. |
| Link | Anyone holding the link. | Not required. |

### By email

```bash
evolve job share "$JOB_ID" --email teammate@example.org
```

This sends an email with the run's address. An eligible new recipient also receives a signup link. The run appears under their shared work after sign-in.

### By link

```bash
evolve job share "$JOB_ID" --link
```

The command prints an unlisted URL. Keep using that URL until you revoke it.

Only the creator can share or revoke a share. Read access does not grant cancellation, retry, analysis, or deletion permission. A recipient who is already a team member retains their separate membership permissions.

## Inspect or revoke access

```bash
evolve job shares "$JOB_ID"
evolve job unshare "$JOB_ID" --email teammate@example.org
evolve job unshare "$JOB_ID" --link
```

Revoking a link disables it immediately. Enabling link sharing later produces a new link.

The same commands apply to other run types:

| Run | Commands |
| --- | --- |
| Job | `evolve job share`, `unshare`, `shares` |
| Check | `evolve check share`, `unshare`, `shares` |
| Managed-agent session | `evolve session share`, `unshare`, `shares` |

## What a link shows

| Run | Readable content |
| --- | --- |
| Job | Summary, trials, traces, and available permitted logs and files. |
| Check | Report, task-check results, and downloadable check archive. |
| Session | Transcript and trace download. Browser replay and session filesystem are not included. |

Sharing a run does not make its dataset public. Task-file access still follows the underlying dataset rules.

## In the dashboard

### 1. Open a run you created

Open the job, check, or session, then choose **Share**.

### 2. Choose the audience

Enter an email address and invite, or enable **Anyone with the link**.

### 3. Review access later

Return to the same dialog to inspect recipients or disable the link.

Email-shared runs appear in **Shared with me** under your personal workspace's Traces page.

**[Share commands](/cli-reference/job)**

Exact flags and share-state output.

**[Teams](/core-concepts/teams)**

Access through workspace membership.
