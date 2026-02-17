# Session Lifecycle

## At a Glance

- Use one `Evolve` instance for multi-turn continuity.
- `withSession()` is builder-time reconnect.
- `setSession()` is runtime switch.

## Core Session Controls

```ts
const sessionId = evolve.getSession(); // string | null

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

## `withSession()` vs `setSession()`

- `withSession("id")`: set sandbox ID before first run.
- `setSession("id")`: switch active sandbox during runtime.

`setSession()` behavior:
- interrupts active process
- flushes current session log
- resets active lineage state
- next run reconnects/continues on the new session ID

## Multi-Turn Patterns

### Multi-turn conversation

```ts
await evolve.run({ prompt: "Analyze data.csv" });
await evolve.run({ prompt: "Now create visualization" });
await evolve.run({ prompt: "Export to PDF" });
```

### Steer background run

```ts
void evolve.run({ prompt: "Do full migration", background: true });
await evolve.interrupt();
await evolve.run({ prompt: "Change direction: auth migration only" });
```

### Save and reconnect across scripts

```ts
// script A
await evolve.run({ prompt: "Start" });
fs.writeFileSync("session.txt", evolve.getSession()!);

// script B
const savedId = fs.readFileSync("session.txt", "utf-8");
const evolve2 = new Evolve().withAgent({ type: "claude" }).withSession(savedId);
await evolve2.run({ prompt: "Continue" });
```

### Switch between sandboxes

```ts
await evolve.run({ prompt: "Analyze dataset A" });
const sessionA = evolve.getSession();

await evolve.setSession("existing-sandbox-b-id");
await evolve.run({ prompt: "Analyze dataset B" });

await evolve.setSession(sessionA!);
await evolve.run({ prompt: "Compare results" });
```

## Provider Caveats

- E2B and Daytona: support `pause()`, `resume()`, `interrupt()`.
- Modal: `pause()` unsupported; active-process `interrupt()` effectively unsupported (`false`).

## Observability

Dashboard traces:
- `https://dashboard.evolvingmachines.ai/traces`

Local session logs:
- path: `~/.evolve-sdk/observability/sessions`
- format: `{tag}_{provider}_{sandboxId}_{agent}_{timestamp}.jsonl`
- `{tag}`: prefix + 16 random hex chars
- `{timestamp}`: ISO timestamp with `:` and `.` replaced by `-`

Each file contains:
- one `_meta` line
- one `_prompt` line per `run()`
- raw streamed payload lines

```json
{"_meta":{"tag":"my-prefix-a1b2c3d4","provider":"e2b","agent":"qwen","model":"qwen-coder-plus-latest","sandbox_id":"sbx_123","timestamp":"2025-10-26T20:15:17.984Z"}}
{"_prompt":{"text":"hello how are you?"}}
{"jsonrpc":"2.0","method":"session/update"}
```

```ts
const evolve = new Evolve()
  .withAgent({ type: "claude" })
  .withSessionTagPrefix("my-project");

await evolve.run({ prompt: "Kick off analysis" });
console.log(evolve.getSessionTag());
console.log(evolve.getSessionTimestamp());
```

Log lifecycle:
- `kill()` or `setSession()` flushes current file
- next run on new sandbox creates new file
- pause/resume keeps appending to same file

## Next

- Checkpoint persistence and restore: [06 Storage and Checkpointing](./06-storage-checkpointing.md)
- Event payload model: [04 Streaming](./04-streaming.md)
