# TypeScript SDK: Workspace, Storage, and Observability

> Part 4 of 5

## 4. Workspace Setup & Structured Output

Calling `run` or `executeCommand` for the first time provisions a sandbox with the following filesystem:

```
/home/user/workspace/
├── context/     # Input files (read-only) provided by the user
├── scripts/     # Your code goes here
├── temp/        # Scratch space
├── output/      # Final deliverables
└── CLAUDE.md    # System prompt (or AGENT.md, GEMINI.md, QWEN.md depending on agent)
```

Files passed to `context` are uploaded to `context/`. Files passed to `files` are uploaded relative to the working directory.

## Filesystem Instructions
Evolve writes a default filesystem instructions to the agent's config file in the workspace (`CLAUDE.md`, `AGENT.md`, `GEMINI.md`, or `QWEN.md`):

```
## FILESYSTEM INSTRUCTIONS

You are running in a sandbox environment.

Present working directory: /home/user/workspace/

IMPORTANT - Directory structure:
/home/user/workspace/
├── context/   # Input files (read-only) provided by the user
├── scripts/   # Your code goes here
├── temp/      # Scratch space
└── output/    # Final deliverables

## OUTPUT RESULTS (DELIVERABLES) MUST BE SAVED to `output/` as files.
```

Any string passed to `systemPrompt` is automatically appended to the agent's config file in the workspace (`CLAUDE.md`, `AGENT.md`, `GEMINI.md`, or `QWEN.md`) after this default.

## Structured Output

When you provide a `schema`, Evolve instructs the agent to write structured JSON output.

```ts
import { z } from "zod";

const CREDataSchema = z.object({
    property_name: z.string(),
    units: z.number(),
    total_rent: z.number(),
    occupancy_rate: z.number(),
});

const evolve = new Evolve()
    .withSchema(CREDataSchema)
    .withContext({
        "rent_roll.pdf": fs.readFileSync("rent_roll.pdf"),
    });

await evolve.run({ prompt: "Extract CRE data from the rent roll" });

const output = await evolve.getOutputFiles();
console.log(output.data);  // { property_name: '...', units: 120, ... }
```

When a schema is provided, `getOutputFiles()` automatically validates `output/result.json` and returns `OutputResult<T>` (see [Download (runtime section 3.5)](./03-runtime-methods.md#35-download-sandbox--local)).

```ts
// Type-safe access to validated data
if (output.data) {
    console.log(output.data.property_name);  // TypeScript knows the shape
} else {
    console.error(output.error);             // "Schema validation failed: ..."
    console.log(output.rawData);             // Raw JSON for debugging
}
```

The SDK automatically appends the following to the agent's config file in the workspace (`CLAUDE.md`, `AGENT.md`, `GEMINI.md`, or `QWEN.md`):

~~~
## STRUCTURED OUTPUT

Your final result MUST be saved to `output/result.json` following this schema:

```json
{
  "type": "object",
  "properties": {
    "property_name": { "type": "string" },
    "units": { "type": "integer" },
    "total_rent": { "type": "number" },
    "occupancy_rate": { "type": "number" }
  },
  "required": ["property_name", "units", "total_rent", "occupancy_rate"]
}
```

You are free to:
- Reason through the problem step by step
- Read and analyze context files
- Use any available tools
- Process incrementally
- Create intermediate files in `temp/` or `scripts/`

But your final `output/result.json` MUST conform to the schema above.

### OUTPUT RESULTS (DELIVERABLES) MUST BE WRITTEN to `output/result.json` as files.
### Never just state results as text.
~~~

---

## 5. Cleaning up and session management

**Multi-turn conversations** (most common):

```ts
const evolve = new Evolve()
  .withAgent({...});

await evolve.run({ prompt: 'Analyze data.csv' });
const output1 = await evolve.getOutputFiles();

// Still same session, automatically maintains context / history
await evolve.run({ prompt: 'Now create visualization' });
const output2 = await evolve.getOutputFiles();

// Still same session, automatically maintains context / history
await evolve.run({ prompt: 'Export to PDF' });
const output3 = await evolve.getOutputFiles();

await evolve.kill();  // When done
```

**Pause and resume** (same instance):

```ts
const evolve = new Evolve()
  .withAgent({...});

await evolve.run({ prompt: 'Start analysis' });
await evolve.pause();  // Suspend billing, keep state
// Do other work...
await evolve.resume();  // Reactivate same sandbox
await evolve.run({ prompt: 'Continue analysis' });  // Session intact

await evolve.kill();  // Kill the Sandbox when done
```

**Save and reconnect** (different script/session):

```ts
// Script 1: Save session for later
const evolve = new Evolve()
  .withAgent({...});

await evolve.run({ prompt: 'Start analysis' });

const sessionId = evolve.getSession();
// Save to file, database, environment variable, etc.
fs.writeFileSync('session.txt', sessionId);

// Script 2: Reconnect to saved session
const savedId = fs.readFileSync('session.txt', 'utf-8');

const evolve2 = new Evolve()
  .withAgent({...})
  .withSession(savedId);  // Reconnect

await evolve2.run({ prompt: 'Continue analysis' });  // Session continues from Script 1
```

**Switch between sandboxes** (same instance):

```ts
const evolve = new Evolve()
  .withAgent({...});

// Work with first sandbox
await evolve.run({ prompt: 'Analyze dataset A' });
const sessionA = evolve.getSession();

// Switch to different sandbox
await evolve.setSession('existing-sandbox-b-id');
await evolve.run({ prompt: 'Analyze dataset B' });  // Now working with sandbox B

// Switch back to first sandbox
await evolve.setSession(sessionA);
await evolve.run({ prompt: 'Compare results' });  // Back to sandbox A
```

---

## 5.1 Storage & Checkpointing

Persist sandbox state beyond sandbox lifetime. Checkpoints archive specific directories under `/home/user/` to S3-compatible storage and can be restored into a fresh sandbox.

**What gets checkpointed:**
- `/home/user/workspace/` — your project files
- `/home/user/.<agent>/` — agent settings and session history (e.g. `.claude/`, `.codex/`, `.gemini/`, `.qwen/`, `.kimi/`)
- For OpenCode: XDG directories (`~/.local/share/opencode/`, `~/.config/opencode/`, `~/.local/state/opencode/`)

- **Auto-checkpoint:** Every successful `run()` with `.withStorage()` creates a checkpoint automatically.
- **Content-addressed dedup:** Archives are hashed (SHA-256). Same content = skip upload.
- **Lineage tracking:** Each checkpoint records its `parentId`, forming a chain across runs and restores.

### Modes

| | BYOK | Gateway |
|---|------|---------|
| Setup | `.withStorage({ url: "s3://..." })` + AWS credentials | `.withStorage()` + `EVOLVE_API_KEY` |
| Storage | Your S3/R2/MinIO bucket | Evolve-managed |
| Metadata | JSON files in S3 | Dashboard database |

### Configuration

```ts
// BYOK — your own S3 bucket
const evolve = new Evolve()
    .withAgent({ type: "claude" })
    .withStorage({
        url: "s3://my-bucket/agent-snapshots/",  // S3 URL (bucket + prefix)
        region: "us-west-2",                      // (optional) Default: AWS_REGION env or us-east-1
    });

// BYOK — Cloudflare R2 / MinIO / custom endpoint
const evolve = new Evolve()
    .withAgent({ type: "claude" })
    .withStorage({
        url: "s3://my-bucket/prefix/",
        endpoint: "https://acct.r2.cloudflarestorage.com",
    });

// Gateway — Evolve-managed storage (no S3 credentials needed)
const evolve = new Evolve()
    .withAgent({ type: "claude" })
    .withStorage();  // Reads EVOLVE_API_KEY from env
```

**BYOK prerequisites:**

```bash
# Install AWS SDK (peer dependency — not bundled with the SDK)
npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner

# Set credentials (or use any method supported by the AWS SDK credential chain)
export AWS_ACCESS_KEY_ID=...
export AWS_SECRET_ACCESS_KEY=...
```

> The AWS SDK packages are loaded dynamically at runtime. If they are not installed, the SDK throws a clear error with install instructions.

**StorageConfig:**

```ts
interface StorageConfig {
    url?: string;         // "s3://bucket/prefix" or "https://endpoint/bucket/prefix"
    bucket?: string;      // Explicit bucket (overrides URL parsing)
    prefix?: string;      // Key prefix (overrides URL parsing)
    region?: string;      // AWS region (default: AWS_REGION env or "us-east-1")
    endpoint?: string;    // Custom S3 endpoint (R2, MinIO, GCS)
    credentials?: {       // Explicit credentials (default: AWS SDK credential chain)
        accessKeyId: string;
        secretAccessKey: string;
    };
}
```

### Auto-Checkpoint (via `run()`)

Every successful foreground `run()` auto-creates a checkpoint:

```ts
const evolve = new Evolve()
    .withAgent({ type: "claude" })
    .withStorage({ url: "s3://my-bucket/snapshots/" });

const result = await evolve.run({
    prompt: "Build the report",
    checkpointComment: "initial draft",  // (optional) Label
});

console.log(result.checkpoint?.id);       // "ckpt_m5abc_xyz123"
console.log(result.checkpoint?.hash);     // SHA-256 of archive
console.log(result.checkpoint?.comment);  // "initial draft"
```

**Behavior notes:**

- **Non-fatal:** Auto-checkpoint failures are logged but never cause `run()` to throw. The run result will have `checkpoint: undefined`.
- **Foreground only:** Background runs (via `run({ background: true })`) skip auto-checkpointing entirely.
- **Exclusions:** The archive excludes `node_modules/`, `__pycache__/`, `*.pyc`, `.cache/`, `.npm/`, `.pip/`, `.venv/`, `venv/`, and `{workspace}/temp/` to keep snapshots lean.
- **Dedup:** Archives are content-addressed by SHA-256 hash. If the hash matches an existing archive in storage, the upload is skipped—only the metadata entry is written.
- **`from: "latest"` edge case:** If no checkpoints exist globally (across all sessions/tags), `from: "latest"` throws an error. Note that `"latest"` resolves to the globally newest checkpoint, not scoped to the current session tag. Use `listCheckpoints()` first to check availability.

### Explicit Checkpoint

Snapshot at any point (between runs, after manual setup, etc.):

```ts
const ckpt = await evolve.checkpoint({ comment: "before refactor" });
console.log(ckpt.id);  // "ckpt_m5def_abc456"
```

Requires an active sandbox (`run()` must have been called first).

### Restore from Checkpoint

Pass `from` to `run()` to restore a checkpoint into a fresh sandbox before running:

```ts
// Restore by checkpoint ID
const result = await evolve.run({
    prompt: "Continue where we left off",
    from: "ckpt_m5abc_xyz123",
});

// Restore the most recent checkpoint
const result = await evolve.run({
    prompt: "Pick up from latest state",
    from: "latest",
});
```

- `from` creates a fresh sandbox, downloads the archive, verifies hash integrity, and extracts it.
- Cannot be used with `.withSession()` (restore requires a fresh sandbox).
- The restored checkpoint becomes the `parentId` for the next checkpoint, maintaining lineage.
- Agent type and workspace mode must match the checkpoint (model changes are fine).

### Listing Checkpoints

**Instance method** (uses storage config from `.withStorage()`):

```ts
const checkpoints = await evolve.listCheckpoints({
    limit: 10,   // (optional) Max results (default: 100, max: 500)
    tag: "my-session-tag",  // (optional) Filter by session tag
});

for (const ckpt of checkpoints) {
    console.log(ckpt.id, ckpt.comment, ckpt.timestamp);
}
```

**Standalone function** (no Evolve instance needed):

```ts
import { listCheckpoints } from "@evolvingmachines/sdk";

// BYOK — same { limit?, tag? } options as evolve.listCheckpoints()
const all = await listCheckpoints(
    { url: "s3://my-bucket/snapshots/" },
    { limit: 10, tag: "my-session" },
);

// Gateway (reads EVOLVE_API_KEY from env)
const recent = await listCheckpoints({}, { limit: 5 });
```

Results are sorted newest first.

### Checkpoint Lineage

Each checkpoint records `parentId`—the checkpoint it was created from. Consecutive runs build a chain:

```ts
const r1 = await evolve.run({ prompt: "Step 1" });
// r1.checkpoint.parentId → undefined (first checkpoint)

const r2 = await evolve.run({ prompt: "Step 2" });
// r2.checkpoint.parentId → r1.checkpoint.id

const r3 = await evolve.run({ prompt: "Step 3" });
// r3.checkpoint.parentId → r2.checkpoint.id
```

Restoring from a checkpoint sets that checkpoint as the parent for subsequent checkpoints:

```ts
// Later: restore from r1 and branch
const r4 = await evolve.run({ prompt: "Branch from step 1", from: r1.checkpoint.id });
// r4.checkpoint.parentId → r1.checkpoint.id (not r3)
```

### CheckpointInfo

```ts
interface CheckpointInfo {
    id: string;              // Checkpoint ID — pass as `from` to restore
    hash: string;            // SHA-256 of tar.gz archive
    tag: string;             // Session tag at checkpoint time
    timestamp: string;       // ISO 8601
    sizeBytes?: number;      // Archive size in bytes
    agentType?: string;      // "claude" | "codex" | "gemini" | "qwen" | "kimi" | "opencode"
    model?: string;          // Model used
    workspaceMode?: string;  // "knowledge" | "swe"
    parentId?: string;       // Parent checkpoint ID (lineage)
    comment?: string;        // User-provided label
}
```

### End-to-End Example

```ts
import { Evolve, listCheckpoints } from "@evolvingmachines/sdk";

// 1. Create and checkpoint
const evolve = new Evolve()
    .withAgent({ type: "claude" })
    .withStorage({ url: "s3://my-bucket/project/" });

const r1 = await evolve.run({
    prompt: "Create a file called report.txt with 'Draft v1'",
    checkpointComment: "initial draft",
});
console.log("Checkpoint 1:", r1.checkpoint?.id);

// 2. Second run — auto-chains parentId
const r2 = await evolve.run({
    prompt: "Append ' - reviewed' to report.txt",
    checkpointComment: "reviewed",
});
console.log("Checkpoint 2:", r2.checkpoint?.id);
console.log("Parent:", r2.checkpoint?.parentId);  // → r1.checkpoint.id

await evolve.kill();

// 3. Restore into fresh sandbox
const evolve2 = new Evolve()
    .withAgent({ type: "claude" })
    .withStorage({ url: "s3://my-bucket/project/" });

const r3 = await evolve2.run({
    prompt: "Read report.txt — what does it say?",
    from: r1.checkpoint!.id,  // Restore from checkpoint 1
});
// Agent sees "Draft v1" (not the reviewed version)

await evolve2.kill();

// 4. List all checkpoints
const all = await listCheckpoints({ url: "s3://my-bucket/project/" });
console.log(`${all.length} checkpoints (newest first)`);
```

---

## 6. Observability

Full execution traces—including tool calls, file operations (read/write/edit), text responses, and reasoning chunks—are logged to your Evolve dashboard at **https://dashboard.evolvingmachines.ai/traces** for debugging and replay.

Additionally, every run and command is logged locally to structured JSON lines under `~/.evolve-sdk/observability/sessions`. File name format:

```
{tag}_{provider}_{sandboxId}_{agent}_{timestamp}.jsonl
```

- `{tag}` – `my-prefix-` + 16 random hex characters (e.g. `my-prefix-a1b2c3d4e5f6g7h8`)
- `{provider}` – the sandbox provider (e.g. `e2b`)
- `{sandboxId}` – the active sandbox ID
- `{agent}` – the agent type (`codex`, `claude`, `gemini`, `qwen`, `kimi`, `opencode`)
- `{timestamp}` – ISO timestamp with `:` and `.` replaced by `-`

Each file contains three entry types:

```json
{"_meta":{"tag":"my-prefix-a1b2c3d4","provider":"e2b","agent":"qwen","model":"qwen-coder-plus-latest","sandbox_id":"sbx_123","timestamp":"2025-10-26T20:15:17.984Z"}}
{"_prompt":{"text":"hello how are you?"}}
{"jsonrpc":"2.0","method":"session/update", ...}
```

- `_meta` – exactly one line per file (sandbox, agent, timestamp)
- `_prompt` – one line per `run()` call with the prompt text
- Raw JSON – every streamed payload (ACP notifications, stdout, etc.)

Attach your own prefix to make logs easy to search:

```ts
const evolve = new Evolve()
  .withAgent({...})
  .withSessionTagPrefix("my-project");

await evolve.run({ prompt: "Kick off analysis" });

console.log(evolve.getSessionTag());        // "my-project-ab12cd34"
console.log(evolve.getSessionTimestamp()); // Timestamp for first log file

await evolve.kill();                              // Flushes log file for sandbox A

await evolve.run({ prompt: "Start fresh" });      // New sandbox → new log file

console.log(evolve.getSessionTag());        // "my-project-f56789cd"
console.log(evolve.getSessionTimestamp()); // Timestamp for second log file
```

- `kill()` or `setSession()` flushes the current log; the next `run()` starts a
  fresh file with the new sandbox id.
- Long-running sessions (pause/resume or ACP auto-resume) keep appending to the
  current file, so you always have the full timeline.
- Logging is buffered inside the SDK, so it never blocks streaming output.

Use the tag together with the sandbox id to correlate logs with files saved in
`/output/`.

---

