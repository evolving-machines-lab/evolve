# Evolve TypeScript SDK (v4)

A reorganized, scan-first version of the TypeScript SDK docs.

Source of truth for content: `../typescript-sdk.md`.

## Read by Task

1. First successful run in minutes: [01 Quickstart](./01-quickstart.md)
2. Auth mode + sandbox provider selection: [02 Setup, Auth, Providers](./02-setup-auth-providers.md)
3. `run()` / `executeCommand()` / files / schema: [03 Runtime Core](./03-runtime-core.md)
4. Real-time event streaming and UI parsing: [04 Streaming](./04-streaming.md)
5. pause/resume/interrupt/reconnect/logs: [05 Session Lifecycle](./05-session-lifecycle.md)
6. persistent state and restore: [06 Storage and Checkpointing](./06-storage-checkpointing.md)
7. skills, Composio, MCP servers: [07 Integrations](./07-integrations.md)
8. parallel multi-agent transforms: [08 Swarm](./08-swarm.md)
9. fluent orchestration steps/events: [09 Pipeline](./09-pipeline.md)
10. exhaustive interfaces/defaults/contracts: [10 Reference](./10-reference.md)

## At a Glance

- Human-first: short decision tables and copy-paste examples per page.
- Agent-first: normalized type and behavior contracts in one place ([10 Reference](./10-reference.md)).
- Streaming is first-class and isolated from runtime basics.

## Suggested Reading Order

- App developer: `01 -> 02 -> 03 -> 04 -> 05`
- Infra/platform engineer: `02 -> 05 -> 06 -> 10`
- Agent orchestration engineer: `08 -> 09 -> 10`
