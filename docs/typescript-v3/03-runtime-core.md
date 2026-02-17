# Runtime Core

Streaming-specific details (`content` / `lifecycle` events and payload types) are in [Streaming Events](./04-streaming-events.md).

## Method Surface

- `run()` and `executeCommand()` are async and return `AgentResponse`
- `status()` is synchronous and returns `SessionStatus`
- `interrupt()` returns `Promise<boolean>`

```ts
type AgentResponse = {
  sandboxId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  checkpoint?: CheckpointInfo;
};
```

## Workspace Model

On first `run()`/`executeCommand()`, sandbox workspace is provisioned:

```text
/home/user/workspace/
├── context/     # input files (read-only user inputs)
├── scripts/     # agent-generated/support scripts
├── temp/        # scratch
├── output/      # final deliverables
└── CLAUDE.md    # or AGENT.md, GEMINI.md, QWEN.md
```

- `withContext()` and `uploadContext()` target `context/`
- `withFiles()` and `uploadFiles()` target workspace-relative paths

## Structured Output (schema)

```ts
import { Evolve } from "@evolvingmachines/sdk";
import { z } from "zod";

const CREDataSchema = z.object({
  property_name: z.string(),
  units: z.number(),
  total_rent: z.number(),
  occupancy_rate: z.number(),
});

const evolve = new Evolve()
  .withSchema(CREDataSchema)
  .withContext({ "rent_roll.pdf": fs.readFileSync("rent_roll.pdf") });

await evolve.run({ prompt: "Extract CRE data" });
const output = await evolve.getOutputFiles();

if (output.data) {
  console.log(output.data.property_name);
} else {
  console.error(output.error);
  console.log(output.rawData);
}
```

When schema is set, SDK appends structured-output instructions and validates `output/result.json` in `getOutputFiles()`.

## `run()`

```ts
const result = await evolve.run({
  prompt: "Analyze the data and create a report",
  timeoutMs: 15 * 60 * 1000,
  background: false,
  from: "ckpt_abc123",
  checkpointComment: "after analysis",
});

console.log(result.exitCode);
console.log(result.stdout);
console.log(result.checkpoint?.id);
```

Behavior:
- default timeout is `3_600_000` ms (1 hour)
- `background: true` returns a start handshake immediately (`exitCode: 0`)
- background completion is emitted via lifecycle events (`run_background_complete`, `run_background_failed`)
- `from` restores checkpoint in a fresh sandbox (requires `.withStorage()`, cannot be combined with `.withSession()`)
- `checkpointComment` labels the auto-checkpoint (when storage configured)
- concurrent active operations are rejected; interrupt or wait first

## `executeCommand()`

```ts
const result = await evolve.executeCommand("pytest", {
  timeoutMs: 10 * 60 * 1000,
  background: false,
});
```

Behavior:
- runs in sandbox working directory
- `background: true` returns start handshake (`exitCode: 0`)
- completion via lifecycle events (`command_background_complete`, `command_background_failed`)

## Upload: Local to Sandbox

Format is `{ "destination/path": content }`.

| Method | Destination |
|---|---|
| `uploadContext()` | `/home/user/workspace/context/{path}` |
| `uploadFiles()` | `/home/user/workspace/{path}` |

```ts
import { readLocalDir } from "@evolvingmachines/sdk";

await evolve.uploadContext({ "spec.json": JSON.stringify(data) });

await evolve.uploadFiles({
  "scripts/setup.sh": "#!/bin/bash\necho hello",
  "data/input.csv": csvBuffer,
});

await evolve.uploadContext(readLocalDir("./input", true));
```

## Download: Sandbox to Local

```ts
import { saveLocalDir } from "@evolvingmachines/sdk";

await evolve.run({ prompt: "Analyze and score the document" });
const output = await evolve.getOutputFiles(true);

saveLocalDir("./output", output.files);
console.log(output.data);
console.log(output.error);
```

`OutputResult<T>` fields:
- `files`: all files in `output/`
- `data`: parsed and validated `result.json` when schema exists
- `error`: validation/parse error message
- `rawData`: raw `result.json` if parse/validation fails

Files from earlier runs/commands are filtered out from each retrieval.

## `getHost(port)`

```ts
const url = await evolve.getHost(8000);
console.log(`Service available at ${url}`);
```

## Next

- Streaming and UI parsing patterns: [Streaming Events](./04-streaming-events.md)
- Session controls and observability: [Session Lifecycle](./05-session-lifecycle.md)
