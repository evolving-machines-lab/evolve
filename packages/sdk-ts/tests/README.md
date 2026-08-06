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
- `EVOLVE_TEST_CHECKPOINT_BUCKET` - Required for the storage integration tests (20-23, 26) in BYOK mode: the name of an S3 bucket you own, used for checkpoint upload/restore. The default is a non-existent placeholder, so these tests fail without it.
