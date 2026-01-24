# E2B Templates

Single Evolve SDK E2B template with all AI coding CLIs pre-installed.

## Included

- Claude Code + ACP adapter
- Codex + ACP adapter
- Gemini CLI
- Qwen Code
- Google Chrome
- Skills from `skills/`

## Usage

```bash
./build.sh           # builds evolve-all (prod)
./build.sh dev       # builds evolve-all-dev
```

## Update workflow

| Change | Action |
|--------|--------|
| Update CLIs | Edit `template.ts` → `./build.sh` |
| Add skills | Add to `skills/` → `./build.sh` |
