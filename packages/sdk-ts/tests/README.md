# Tests

Run from `packages/sdk-ts/`:

```bash
npm run build          # Required first - tests run against dist/
npm run test:all       # All tests sequentially
npm run test:01        # All agents parallel (~210s)
npm run test:02-09     # Individual tests
npm run test:codex     # Single agent from test 01
npm run test:claude
npm run test:gemini
npm run test:qwen
```

**Env vars** (`.env`):
- `EVOLVE_API_KEY` - Required
- `TEST_AGENT_TYPE` - Default agent (codex|claude|gemini|qwen)
- `CODEX_MODEL`, `CODEX_REASONING_EFFORT` - Codex config
