# Daytona Snapshot

Single Evolve SDK Daytona snapshot with all AI coding CLIs pre-installed.

## Included

- Claude Code + ACP adapter
- Codex + ACP adapter
- Gemini CLI
- Qwen Code
- Google Chrome
- Skills from `skills/`

## Usage

```bash
./build.sh           # builds evolve-all snapshot
```

## Update workflow

| Change | Action |
|--------|--------|
| Update CLIs | Edit `template.ts` → `./build.sh` |
| Add skills | Add to `skills/` → `./build.sh` |

## Prerequisites

- Daytona API key (`DAYTONA_API_KEY` environment variable)
- Node.js 18+
