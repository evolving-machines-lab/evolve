# Storage and Checkpointing

## At a Glance

- `.withStorage()` enables persistent checkpoints.
- foreground `run()` auto-checkpoints on success.
- `run({ from })` restores into a fresh sandbox.

## What Gets Checkpointed

- `/home/user/workspace/`
- `/home/user/.<agent>/` (for example `.claude/`, `.codex/`, `.gemini/`, `.qwen/`, `.kimi/`)
- OpenCode XDG dirs (`~/.local/share/opencode/`, `~/.config/opencode/`, `~/.local/state/opencode/`)

## Modes

| | BYOK | Gateway |
|---|---|---|
| Setup | `.withStorage({ url: "s3://..." })` + AWS credentials | `.withStorage()` + `EVOLVE_API_KEY` |
| Backend | your S3/R2/MinIO storage | Evolve-managed |
| Metadata | JSON in storage | dashboard DB |

## Configuration

```ts
import { Evolve } from "@evolvingmachines/sdk";

const byokS3 = new Evolve()
  .withAgent({ type: "claude" })
  .withStorage({
    url: "s3://my-bucket/agent-snapshots/",
    region: "us-west-2",
  });

const byokR2 = new Evolve()
  .withAgent({ type: "claude" })
  .withStorage({
    url: "s3://my-bucket/prefix/",
    endpoint: "https://acct.r2.cloudflarestorage.com",
  });

const gatewayManaged = new Evolve()
  .withAgent({ type: "claude" })
  .withStorage();
```

BYOK prerequisites:

```bash
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner

export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
```

AWS SDK packages are dynamically loaded at runtime.

## Auto-Checkpoint (`run()`)

```ts
const evolve = new Evolve()
  .withAgent({ type: "claude" })
  .withStorage({ url: "s3://my-bucket/snapshots/" });

const result = await evolve.run({
  prompt: "Build report",
  checkpointComment: "initial draft",
});

console.log(result.checkpoint?.id);
console.log(result.checkpoint?.hash);
console.log(result.checkpoint?.comment);
```

Behavior notes:
- non-fatal: checkpoint upload failures do not fail `run()`
- foreground only: background runs skip auto-checkpoint
- dedup: SHA-256 content-addressed archives
- exclusions: `node_modules/`, `__pycache__/`, `*.pyc`, `.cache/`, `.npm/`, `.pip/`, `.venv/`, `venv/`, and `{workspace}/temp/`
- `from: "latest"` resolves globally newest checkpoint (not tag-scoped)

## Explicit Checkpoint

```ts
const ckpt = await evolve.checkpoint({ comment: "before refactor" });
console.log(ckpt.id);
```

Requires active sandbox (run once first).

## Restore from Checkpoint

```ts
await evolve.run({
  prompt: "Continue where we left off",
  from: "ckpt_m5abc_xyz123",
});

await evolve.run({
  prompt: "Pick up latest",
  from: "latest",
});
```

Restore behavior:
- fresh sandbox create
- archive download + hash verification + extract
- cannot combine `from` with `.withSession()`
- restored checkpoint becomes next checkpoint `parentId`
- agent type and workspace mode must match (model may change)

## List Checkpoints

```ts
const checkpoints = await evolve.listCheckpoints({
  limit: 10, // optional: default 100, max 500
  tag: "my-session-tag",
});
```

```ts
import { listCheckpoints } from "@evolvingmachines/sdk";

const all = await listCheckpoints(
  { url: "s3://my-bucket/snapshots/" },
  { limit: 10, tag: "my-session" },
);

const recent = await listCheckpoints({}, { limit: 5 });
```

Results are newest first.

## Lineage

Each checkpoint stores `parentId`.

```ts
const r1 = await evolve.run({ prompt: "Step 1" });
const r2 = await evolve.run({ prompt: "Step 2" });
const r3 = await evolve.run({ prompt: "Step 3" });

console.log(r2.checkpoint?.parentId === r1.checkpoint?.id);
console.log(r3.checkpoint?.parentId === r2.checkpoint?.id);

const branch = await evolve.run({
  prompt: "Branch from step 1",
  from: r1.checkpoint!.id,
});
console.log(branch.checkpoint?.parentId === r1.checkpoint?.id);
```

## End-to-End Example

```ts
import { Evolve, listCheckpoints } from "@evolvingmachines/sdk";

const evolve = new Evolve()
  .withAgent({ type: "claude" })
  .withStorage({ url: "s3://my-bucket/project/" });

const r1 = await evolve.run({
  prompt: "Create report.txt with Draft v1",
  checkpointComment: "initial draft",
});

const r2 = await evolve.run({
  prompt: "Append reviewed to report.txt",
  checkpointComment: "reviewed",
});

await evolve.kill();

const evolve2 = new Evolve()
  .withAgent({ type: "claude" })
  .withStorage({ url: "s3://my-bucket/project/" });

await evolve2.run({
  prompt: "Read report.txt",
  from: r1.checkpoint!.id,
});

await evolve2.kill();

const all = await listCheckpoints({ url: "s3://my-bucket/project/" });
console.log(`${all.length} checkpoints`);
```

## Full Contracts

See [10 Reference](./10-reference.md) for `StorageConfig` and `CheckpointInfo`.
