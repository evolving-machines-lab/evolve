# Daytona Snapshot

Single Evolve SDK Daytona snapshot with all AI coding CLIs pre-installed.

## Included

- Claude Code + ACP adapter
- Codex + ACP adapter
- Gemini CLI
- Qwen Code
- Google Chrome
- Playwright (Chromium)
- Skills from `skills/`

## Usage

### Build Daytona Snapshot (for org-private use)

```bash
./build.sh           # builds evolve-all snapshot
./build.sh dev       # builds evolve-all-dev snapshot
```

### Build Docker Image (for public distribution)

```bash
# Build for AMD64 (required for Daytona)
docker build --platform=linux/amd64 -t evolvingmachines/evolve-all:latest .

# Push to Docker Hub
docker push evolvingmachines/evolve-all:latest
```

## Files

| File | Purpose |
|------|---------|
| `template.ts` | Daytona Image builder (SDK-based) |
| `Dockerfile` | Docker image (public distribution) |
| `build.sh` | Shell wrapper for snapshot builds |
| `build.dev.ts` | Dev snapshot build script |
| `build.prod.ts` | Prod snapshot build script |

## How SDK Users Get the Image

The Evolve SDK Daytona provider auto-handles images:

1. **If snapshot exists** → Uses cached snapshot (fast)
2. **If no snapshot** → Creates from public Docker image (first-run slower, then cached)

Users never need to think about images - it just works.

## Update workflow

| Change | Action |
|--------|--------|
| Update CLIs | Edit `template.ts` + `Dockerfile` → rebuild |
| Add skills | Add to `skills/` → rebuild |

## Prerequisites

- Daytona API key (`DAYTONA_API_KEY` environment variable)
- Node.js 18+
- Docker (for public image builds)
