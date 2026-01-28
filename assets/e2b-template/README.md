# E2B

Public template - **no user setup needed**. Works out of the box.

## For Maintainers Only

Rebuild the template:

```bash
cd assets && ./build.sh e2b
```

Or directly:

```bash
npx tsx build.prod.ts
```

## Template

- **Name:** `evolve-all`
- **Base:** `e2bdev/code-interpreter:latest`

## Contents

- Claude Code, Codex, Gemini CLI, Qwen Code
- ACP adapters for Claude and Codex
- Google Chrome + Playwright
- Skills from `evolving-machines-lab/evolve`
- Python 3.12 + ML packages
- Node.js + npm

## Update Workflow

| Change | Action |
|--------|--------|
| Update CLIs | Edit `template.ts` → `./build.sh e2b` |
| Add skills | Push to `skills/` in repo → `./build.sh e2b` |
