# Session Lifecycle

This page covers multi-turn sessions, control APIs, reconnection, and observability logs.

## Multi-Turn (same sandbox)

```ts
const evolve = new Evolve().withAgent({ type: "claude" });

await evolve.run({ prompt: "Analyze data.csv" });
await evolve.run({ prompt: "Create visualization" });
await evolve.run({ prompt: "Export to PDF" });

await evolve.kill();
```

Each `run()` in the same session keeps context/history.

## Core Controls

```ts
const sessionId = evolve.getSession();

const s = evolve.status();
// s.sandbox: "stopped" | "booting" | "ready" | "running" | "paused" | "error"
// s.agent: "idle" | "running" | "interrupted" | "error"
// s.hasRun: boolean
// s.sandboxId: string | null
// s.activeProcessId: string | null
// s.timestamp: ISO string

const ok = await evolve.interrupt();

await evolve.pause();
await evolve.resume();
await evolve.kill();
```

Steering pattern:

```ts
void evolve.run({ prompt: "Do full migration", background: true });
await evolve.interrupt();
await evolve.run({ prompt: "Change direction: auth migration only" });
```

## Reconnect and Switch

### Reconnect from saved session (different process)

```ts
const sessionId = fs.readFileSync("session.txt", "utf-8");

const evolve = new Evolve()
  .withAgent({ type: "claude" })
  .withSession(sessionId);

await evolve.run({ prompt: "Continue" });
```

### Switch active sandbox on same instance

```ts
await evolve.setSession("existing-sandbox-id");
await evolve.run({ prompt: "Work in this sandbox" });
```

Difference:
- `withSession("id")`: builder-time initialization before first run
- `setSession("id")`: runtime switch; interrupts active process, flushes logs, resets checkpoint lineage state in-memory

## Background Runs and Completion

`run({ background: true })` and `executeCommand(..., { background: true })` return a start handshake immediately.
Completion/failure comes from lifecycle events:

- `run_background_complete`
- `run_background_failed`
- `command_background_complete`
- `command_background_failed`

## Provider Caveats

- E2B and Daytona: full support for `pause()`, `resume()`, `interrupt()`
- Modal: `pause()` unsupported; active-process `interrupt()` is effectively unsupported and returns `false`

## Observability

Dashboard traces:
- `https://dashboard.evolvingmachines.ai/traces`

Local structured logs:
- directory: `~/.evolve-sdk/observability/sessions`
- filename format: `{tag}_{provider}_{sandboxId}_{agent}_{timestamp}.jsonl`
- `{tag}`: your prefix + 16 random hex chars (for example `my-prefix-a1b2c3d4e5f6g7h8`)
- `{timestamp}`: ISO timestamp with `:` and `.` replaced by `-`

File includes:
- one `_meta` line
- one `_prompt` line per `run()`
- all streamed raw payload lines

```json
{"_meta":{"tag":"my-prefix-a1b2c3d4","provider":"e2b","agent":"qwen","model":"qwen-coder-plus-latest","sandbox_id":"sbx_123","timestamp":"2025-10-26T20:15:17.984Z"}}
{"_prompt":{"text":"hello how are you?"}}
{"jsonrpc":"2.0","method":"session/update"}
```

Attach your own tag prefix:

```ts
const evolve = new Evolve()
  .withAgent({ type: "claude" })
  .withSessionTagPrefix("my-project");

await evolve.run({ prompt: "Kick off analysis" });

console.log(evolve.getSessionTag());
console.log(evolve.getSessionTimestamp());
```

Log lifecycle notes:
- `kill()` or `setSession()` flushes current log file
- next `run()` on a new sandbox starts a new file
- pause/resume and auto-resume continue appending to same file
- logging is buffered and does not block streaming output

## Related

- Streaming event details: [Streaming Events](./04-streaming-events.md)
- Checkpoint persistence and restore: [Storage and Checkpointing](./06-storage-checkpointing.md)
