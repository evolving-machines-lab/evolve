# Runtime

## Methods

`run()` and `executeCommand()` are async and return `AgentResponse`. `status()` is synchronous and returns `SessionStatus`. `interrupt()` returns `Promise<boolean>`.

```ts
type AgentResponse = {
  sandboxId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  checkpoint?: CheckpointInfo;  // Present when .withStorage() configured and run succeeded
};
```

### run

Runs the agent with a given prompt.

```ts
const result = await evolve.run({
    prompt: "Analyze the data and create a report",
    timeoutMs: 15 * 60 * 1000,                // (optional) Default 1 hour
    background: false,                         // (optional) Run in background
    from: "ckpt_abc123",                       // (optional) Restore from checkpoint ID or "latest"
    checkpointComment: "after analysis",       // (optional) Label for the auto-checkpoint
});

console.log(result.exitCode);
console.log(result.stdout);
console.log(result.checkpoint?.id);            // Checkpoint ID (if .withStorage() configured)
```

- If `timeoutMs` is omitted the agent uses the TypeScript default of 3_600_000 ms (1 hour).
- If `background` is `true`, the call returns immediately with a start handshake (`exitCode: 0`), not final completion. Completion is delivered asynchronously via `lifecycle` events (`run_background_complete` or `run_background_failed`), or by polling `status()`.
- If `from` is set, the SDK restores a checkpoint into a fresh sandbox before running. Pass a checkpoint ID or `"latest"` to restore the most recent. Requires `.withStorage()`. Cannot be used with `.withSession()`.
- If `checkpointComment` is set, the auto-checkpoint created after a successful run is labeled with this string. Requires `.withStorage()`.
- Calling `run()` multiple times maintains the agent context / history.
- Calling `run()` while another run or command is active throws immediately. Call `interrupt()` first or wait for the active operation to finish.

### executeCommand

Runs a direct shell command in the sandbox working directory.

```ts
// Run shell command directly in sandbox
const result = await evolve.executeCommand("pytest", {
    timeoutMs: 10 * 60 * 1000,                // (optional) Default 1 hour
    background: false,                         // (optional) Run in background
});
```

- If `background` is `true`, returns a start handshake (`exitCode: 0`). Completion arrives via `lifecycle` events (`command_background_complete` or `command_background_failed`).

### Streaming Events

Subscribe to real-time output from `run()` and `executeCommand()`:

```typescript
evolve.on("content", (event: OutputEvent) => {
  console.log(event.update.sessionUpdate, event.update);
});

evolve.on("lifecycle", (event: LifecycleEvent) => {
  console.log(event.reason, event.sandbox, event.agent);
});
```

| Event | Type | Description |
|-------|------|-------------|
| `content` | `OutputEvent` | Parsed ACP-style events (text, tools, plans) |
| `lifecycle` | `LifecycleEvent` | Sandbox and agent state transitions |
| `stdout` | `string` | Raw JSONL output |
| `stderr` | `string` | Error output |

For full type definitions, all event interfaces, browser-use detection, and UI integration example, see [Streaming Events](./04-streaming.md).

### Upload: Local → Sandbox

**Format:** `{ "destination": content }` — directories created automatically

| Method | Destination |
|--------|-------------|
| `uploadContext()` | `/home/user/workspace/context/{path}` |
| `uploadFiles()` | `/home/user/workspace/{path}` |

```ts
// Single file
await evolve.uploadContext({ "spec.json": JSON.stringify(data) });

// Multiple files
await evolve.uploadFiles({
  "scripts/setup.sh": "#!/bin/bash\necho hello",
  "data/input.csv": csvBuffer,
});

// From local directory (helper)
import { readLocalDir } from "@evolvingmachines/sdk";
await evolve.uploadContext(readLocalDir("./input", true));
```

> **Setup alternative:** `withContext()` and `withFiles()` use the same format but upload on first `run()` instead of immediately.

### Download: Sandbox → Local

**Flow:** `getOutputFiles()` → `saveLocalDir()`

```ts
// Return type
interface OutputResult<T = unknown> {
    files: FileMap;      // All files from output/ folder
    data: T | null;      // Parsed result.json (if schema was set via withSchema())
    error?: string;      // Validation error message (if schema validation failed)
    rawData?: string;    // Raw result.json content when parse/validation failed (for debugging)
}
```

```ts
import { z } from "zod";
import { saveLocalDir } from "@evolvingmachines/sdk";

const ResultSchema = z.object({
    summary: z.string(),
    score: z.number(),
});

const evolve = new Evolve()
    .withAgent({...})
    .withSchema(ResultSchema);  // Agent will be prompted to write result.json

await evolve.run({ prompt: "Analyze and score the document" });

const output = await evolve.getOutputFiles(true);  // recursive=true for nested dirs

// Access all three fields
saveLocalDir("./output", output.files);  // Save files locally
console.log(output.data);                 // { summary: "...", score: 85 }
console.log(output.error);                // undefined (or validation error message)
```

- **`files`** — `FileMap` of all files from `output/` folder
- **`data`** — Parsed `result.json` validated against schema (null if no schema or validation failed)
- **`error`** — Validation error message if schema validation failed (undefined otherwise)

Files created before the last `run()` or `executeCommand()` are filtered out.

### Session Controls

```ts
const sessionId = evolve.getSession();  // Returns sandbox ID (string) or null (sync)

const s = evolve.status();             // Synchronous snapshot of sandbox + agent state
// s.sandbox   → "stopped" | "booting" | "ready" | "running" | "paused" | "error"
// s.agent     → "idle" | "running" | "interrupted" | "error"
// s.hasRun    → boolean (true after first run)
// s.sandboxId → string | null
// s.activeProcessId → string | null
// s.timestamp → string (ISO 8601)

const ok = await evolve.interrupt();   // Interrupts active run() or executeCommand() process; sandbox stays alive. Returns true/false.

// Steer a running task: interrupt, then reprompt in same session.
// The next run() auto-continues conversation history/context for this sandbox session.
void evolve.run({ prompt: "Do a full migration plan", background: true });
await evolve.interrupt();
await evolve.run({ prompt: "Change direction: only auth migration." });

await evolve.pause();  // Suspends sandbox (stops billing, preserves state)
await evolve.resume(); // Reactivates same sandbox

await evolve.kill();   // Destroys sandbox; next run() creates a new sandbox

await evolve.setSession("existing-sandbox-id"); // Sets sandbox ID; reconnection happens on next run()

// Checkpointing (requires .withStorage())
const checkpt = await evolve.checkpoint({ comment: "before refactor" });  // Explicit snapshot of current sandbox
const list = await evolve.listCheckpoints({ limit: 10 });              // List checkpoints, newest first
const files = await evolve.storage().downloadFiles("latest", { glob: ["workspace/**/*.ts"] }); // Download specific files
```

`withSession("sandbox-id")` is a builder method for initialization—it sets the sandbox ID before the first `run()`. `setSession()` is a runtime method that actively interrupts any running process, flushes the session log, resets checkpoint lineage, and switches to the new sandbox. They are **not** interchangeable: use `withSession()` when building, `setSession()` when switching mid-session.

**Provider caveats:**
- **E2B / Daytona** — full support for `pause()`, `resume()`, `interrupt()`.
- **Modal** — does not support `pause()`. `interrupt()` is effectively unsupported and returns `false` for active processes.

### getHost

Expose a forwarded port:

```ts
const url = await evolve.getHost(8000);
console.log(`Workspace service available at ${url}`);
```
---

## Workspace & Structured Output

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

When a schema is provided, `getOutputFiles()` automatically validates `output/result.json` and returns `OutputResult<T>` (see [Download: Sandbox → Local](#download-sandbox--local)).

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

## Session Management

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

## Storage & Checkpointing

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

console.log(result.checkpoint?.id);       // "checkpt_m5abc_xyz123"
console.log(result.checkpoint?.hash);     // SHA-256 of archive
console.log(result.checkpoint?.comment);  // "initial draft"
```

**Behavior notes:**

- **Non-fatal:** Auto-checkpoint failures are logged but never cause `run()` to throw. The run result will have `checkpoint: undefined`.
- **Foreground only:** Background runs (via `run({ background: true })`) skip auto-checkpointing entirely.
- **Exclusions:** The archive excludes `node_modules/`, `__pycache__/`, `*.pyc`, `.cache/`, `.npm/`, `.pip/`, `.venv/`, `venv/`, and `{workspace}/temp/` to keep snapshots lean.
- **Dedup:** Archives are content-addressed by SHA-256 hash. If the hash matches an existing archive in storage, the upload is skipped—only the metadata entry is written.
- **`from: "latest"` edge case:** If no checkpoints exist globally (across all sessions/tags), `from: "latest"` throws an error. Note that `"latest"` resolves to the globally newest checkpoint, not scoped to the current session tag. Use `storage().listCheckpoints()` first to check availability.

### Explicit Checkpoint

Snapshot at any point (between runs, after manual setup, etc.):

```ts
const checkpt = await evolve.checkpoint({ comment: "before refactor" });
console.log(checkpt.id);  // "checkpt_m5def_abc456"
```

Requires an active sandbox (`run()` must have been called first).

### Restore from Checkpoint

Pass `from` to `run()` to restore a checkpoint into a fresh sandbox before running:

```ts
// Restore by checkpoint ID
const result = await evolve.run({
    prompt: "Continue where we left off",
    from: "checkpt_m5abc_xyz123",
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

### Listing & Browsing Checkpoints

**Instance method** (uses storage config from `.withStorage()`):

```ts
const checkpoints = await evolve.listCheckpoints({
    limit: 10,   // (optional) Max results (default: 100, max: 500)
    tag: "my-session-tag",  // (optional) Filter by session tag
});

for (const checkpt of checkpoints) {
    console.log(checkpt.id, checkpt.comment, checkpt.timestamp);
}
```

**Standalone `storage()` client** (no Evolve instance needed):

```ts
import { storage } from "@evolvingmachines/sdk";

// BYOK
const store = storage({ url: "s3://my-bucket/snapshots/" });

// Gateway (reads EVOLVE_API_KEY from env)
const store = storage();
```

The `storage()` factory returns a `StorageClient` with four methods:

```ts
// List checkpoints (newest first)
const list = await store.listCheckpoints({ limit: 10, tag: "my-session" });

// Get a single checkpoint by ID (O(1) metadata lookup)
const info = await store.getCheckpoint("checkpt_m5abc_xyz123");

// Download full checkpoint archive to a local directory
const outputDir = await store.downloadCheckpoint("checkpt_m5abc_xyz123", {
    to: "./restored",   // (optional) Output directory (default: cwd)
    extract: true,      // (optional) Extract archive (default: true). Set false to keep raw .tar.gz
});

// Download specific files without extracting the full archive
const files = await store.downloadFiles("checkpt_m5abc_xyz123", {
    files: ["workspace/output/result.json"],  // (optional) Exact file paths to extract
    glob: ["workspace/**/*.ts"],              // (optional) Glob patterns to match files
    to: "./output",                           // (optional) Save to disk (default: in-memory only)
});
// files is a Map<string, Buffer> — relative path → file contents
```

`downloadFiles` returns a `FileMap` (`Map<string, Buffer>`) of matching files. Pass `"latest"` instead of a checkpoint ID to any method to resolve the most recent checkpoint.

**Instance-bound `storage()` accessor:**

When you already have an Evolve instance, `evolve.storage()` returns the same `StorageClient` with gateway credentials automatically bound:

```ts
const evolve = new Evolve()
    .withAgent({ type: "claude" })
    .withStorage({ url: "s3://my-bucket/snapshots/" });

const store = evolve.storage();
const files = await store.downloadFiles("latest", { glob: ["workspace/report.*"] });
```

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

### Type Reference

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

interface StorageClient {
    listCheckpoints(options?: { limit?: number; tag?: string }): Promise<CheckpointInfo[]>;
    getCheckpoint(id: string): Promise<CheckpointInfo>;
    downloadCheckpoint(idOrLatest: string, options?: DownloadCheckpointOptions): Promise<string>;
    downloadFiles(idOrLatest: string, options?: DownloadFilesOptions): Promise<FileMap>;
}

interface DownloadCheckpointOptions {
    to?: string;       // Output directory (default: cwd)
    extract?: boolean; // Extract archive (default: true)
}

interface DownloadFilesOptions {
    files?: string[];  // Exact file paths to extract
    glob?: string[];   // Glob patterns to match files
    to?: string;       // Save to disk (default: in-memory only)
}

type FileMap = Map<string, Buffer>;  // relative path → file contents
```

### End-to-End Example

```ts
import { Evolve, storage } from "@evolvingmachines/sdk";

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

// 4. Browse checkpoints and download files (no Evolve instance needed)
const store = storage({ url: "s3://my-bucket/project/" });
const all = await store.listCheckpoints();
console.log(`${all.length} checkpoints (newest first)`);

const files = await store.downloadFiles("latest", { glob: ["workspace/report.*"] });
for (const [path, content] of files) {
    console.log(`${path}: ${content.toString()}`);
}
```

---

## Observability

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

await evolve.kill();                              // Destroys sandbox A

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

## Error Handling

Common errors and how to handle them:

| Error | Cause | Fix |
|-------|-------|-----|
| `No API key configured` | No `EVOLVE_API_KEY` or provider key in env | Set `EVOLVE_API_KEY` or pass `apiKey`/`providerApiKey` to `.withAgent()` |
| `No sandbox provider configured` | No sandbox provider key in env | Set `E2B_API_KEY`, `MODAL_TOKEN_ID`+`SECRET`, or `DAYTONA_API_KEY` |
| `Operation already active` | Calling `run()` while another run is in progress | `await evolve.interrupt()` first, or wait for the active operation |
| `Cannot use 'from' with existing session` | `run({ from: "..." })` with `.withSession()` | Checkpoint restore requires a fresh sandbox — remove `.withSession()` |
| `No checkpoints found` | `run({ from: "latest" })` with no prior checkpoints | Create a checkpoint first, or use `storage().listCheckpoints()` to verify |
| `Schema validation failed: ...` | Agent's `result.json` doesn't match schema | Check `output.rawData` for the actual output; refine your prompt or schema |
| `@aws-sdk/client-s3 not installed` | `.withStorage({ url: "s3://..." })` without AWS SDK | `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner` |
| Timeout (exit code -1) | Agent exceeded `timeoutMs` | Increase `timeoutMs` or simplify the prompt |

```ts
// Handling schema validation errors
const output = await evolve.getOutputFiles();
if (output.error) {
    console.error("Validation failed:", output.error);
    console.log("Raw output:", output.rawData);  // Agent's actual JSON for debugging
}

// Handling run errors
try {
    const result = await evolve.run({ prompt: "..." });
    if (result.exitCode !== 0) {
        console.error("Agent failed:", result.stderr);
    }
} catch (err) {
    // Thrown for: no API key, no sandbox, operation conflict, restore failure
    console.error(err.message);
}
```

---
