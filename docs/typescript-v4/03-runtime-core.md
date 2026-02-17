# Runtime Core

## At a Glance

- `run()` and `executeCommand()` return `AgentResponse`.
- First run provisions sandbox and workspace.
- `withSchema()` + `getOutputFiles()` gives validated structured output.

## Method Surface

```ts
type AgentResponse = {
  sandboxId: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  checkpoint?: CheckpointInfo;
};
```

- `run()` async
- `executeCommand()` async
- `status()` sync
- `interrupt()` async (`Promise<boolean>`)
- `getHost(port)` async

## Workspace Layout

First `run()`/`executeCommand()` creates:

```text
/home/user/workspace/
├── context/     # user input files (read-only inputs)
├── scripts/     # generated scripts and helpers
├── temp/        # scratch
├── output/      # deliverables
└── CLAUDE.md    # or AGENT.md / GEMINI.md / QWEN.md
```

Routing rules:
- `withContext()` and `uploadContext()` -> `context/`
- `withFiles()` and `uploadFiles()` -> workspace-relative paths

## `run()`

```ts
const result = await evolve.run({
  prompt: "Analyze data and create report",
  timeoutMs: 15 * 60 * 1000,
  background: false,
  from: "ckpt_abc123",
  checkpointComment: "after analysis",
});

console.log(result.exitCode, result.stdout, result.checkpoint?.id);
```

Behavior notes:
- default timeout: `3_600_000` ms (1 hour)
- `background: true` returns immediately with start handshake (`exitCode: 0`)
- background completion/failure arrives via lifecycle events
- `from` restores checkpoint in a fresh sandbox (requires `.withStorage()`, not compatible with `.withSession()`)
- `checkpointComment` labels auto-checkpoint (when storage is configured)
- active operation conflicts throw immediately; interrupt or wait first

## `executeCommand()`

```ts
const result = await evolve.executeCommand("pytest", {
  timeoutMs: 10 * 60 * 1000,
  background: false,
});
```

Behavior notes:
- runs in sandbox working directory
- `background: true` returns start handshake; completion via lifecycle events

## Structured Output (`withSchema`)

```ts
import { Evolve } from "@evolvingmachines/sdk";
import { z } from "zod";

const Schema = z.object({
  summary: z.string(),
  score: z.number(),
});

const evolve = new Evolve()
  .withSchema(Schema)
  .withContext({ "input.txt": "..." });

await evolve.run({ prompt: "Analyze and score" });
const output = await evolve.getOutputFiles();

if (output.data) {
  console.log(output.data.summary, output.data.score);
} else {
  console.error(output.error);
  console.log(output.rawData);
}
```

`getOutputFiles()` validates `output/result.json` when schema is present.

## Upload: Local -> Sandbox

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

`withContext()`/`withFiles()` use the same shape, but apply on first run.

## Download: Sandbox -> Local

```ts
import { saveLocalDir } from "@evolvingmachines/sdk";

await evolve.run({ prompt: "Generate output" });
const output = await evolve.getOutputFiles(true); // recursive

saveLocalDir("./output", output.files);
console.log(output.data, output.error, output.rawData);
```

`OutputResult<T>`:
- `files`: all files from `output/`
- `data`: parsed+validated `result.json` when schema exists
- `error`: validation/parse message when failed
- `rawData`: raw `result.json` string on parse/validation failure

Files created before the last run/command are filtered out.

## `getHost(port)`

```ts
const url = await evolve.getHost(8000);
console.log(url);
```

## Next

- Streaming events and payload model: [04 Streaming](./04-streaming.md)
- Session controls and runtime lifecycle: [05 Session Lifecycle](./05-session-lifecycle.md)
