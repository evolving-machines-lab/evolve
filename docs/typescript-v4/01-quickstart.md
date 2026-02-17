# Quickstart

## At a Glance

- Fastest path is Gateway mode (`EVOLVE_API_KEY`).
- `browser-use` is included by default in Gateway mode.
- First `run()` boots sandbox and applies setup (`context`, `files`, prompt, MCP).

## Minimal Working Example

```bash
# .env
EVOLVE_API_KEY=sk-...
COMPOSIO_API_KEY=...
```

```ts
import { Evolve } from "@evolvingmachines/sdk";

const evolve = new Evolve()
  .withAgent({ apiKey: process.env.EVOLVE_API_KEY! })
  .withSessionTagPrefix("my-app")
  .withSystemPrompt("You are a powerful AI coding agent.")
  .withSkills(["pdf", "docx", "pptx"])
  .withComposio("user_123", { toolkits: ["gmail", "notion", "exa"] });

const result = await evolve.run({
  prompt: "Analyze Hacker News top posts and summarize trends.",
});

console.log(result.stdout);

const output = await evolve.getOutputFiles();
for (const name of Object.keys(output.files)) {
  console.log(name);
}

await evolve.kill();
```

## Gateway Features

With `EVOLVE_API_KEY`:
- tracing and replay in `dashboard.evolvingmachines.ai`
- browser automation via `browser-use` out of the box
- managed checkpoint storage via `.withStorage()` (no S3 credentials)

## Next

- Auth modes and sandbox providers: [02 Setup, Auth, Providers](./02-setup-auth-providers.md)
- Runtime methods and file flow: [03 Runtime Core](./03-runtime-core.md)
