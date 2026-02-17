# Evolve TypeScript SDK (v3)

A reorganized, code-first version of the TypeScript SDK docs.

## Read Path

1. [Quickstart](./01-quickstart.md)
2. [Configuration](./02-configuration.md)
3. [Runtime Core](./03-runtime-core.md)
4. [Streaming Events](./04-streaming-events.md)
5. [Session Lifecycle](./05-session-lifecycle.md)
6. [Storage and Checkpointing](./06-storage-checkpointing.md)
7. [Swarm](./07-swarm.md)
8. [Appendix: Types](./appendix-types.md)

## Coverage Notes

- Source of truth remains `../typescript-sdk.md`.
- This v3 track keeps all core capabilities while reducing repetition and improving order.
- Streaming (`content`, `lifecycle`, session update types, UI handling) is now isolated in [Streaming Events](./04-streaming-events.md).

## Fast Decision Tree

- Want first run working in 3 minutes: [Quickstart](./01-quickstart.md)
- Need provider/agent/skills/composio setup: [Configuration](./02-configuration.md)
- Need run/command/files/schema flow: [Runtime Core](./03-runtime-core.md)
- Building UI/event parser: [Streaming Events](./04-streaming-events.md)
- Need pause/resume/interrupt/reconnect/logging: [Session Lifecycle](./05-session-lifecycle.md)
- Need persistent state and restore: [Storage and Checkpointing](./06-storage-checkpointing.md)
- Need parallel multi-agent pipelines: [Swarm](./07-swarm.md)
