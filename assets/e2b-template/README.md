# E2B Template

Evolve SDK E2B template with all AI coding CLIs pre-installed.

## Base Image

`e2bdev/code-interpreter:latest` - includes Python 3.12, Node.js, and 22+ ML/science packages.

## Included

- Claude Code + ACP adapter
- Codex + ACP adapter
- Gemini CLI + Nano Banana extension
- Qwen Code
- Google Chrome + Playwright
- mcp-remote, agent-browser
- UV package manager
- Skills from `evolving-machines-lab/evolve`

## Usage

```bash
./build.sh           # builds evolve-all (prod)
./build.sh dev       # builds evolve-all-dev
```

## Update workflow

| Change | Action |
|--------|--------|
| Update CLIs | Edit `template.ts` → `./build.sh` |
| Add skills | Push to `skills/` in repo → `./build.sh` |
