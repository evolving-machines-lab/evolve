# Quickstart Examples

Minimal examples showing Evolve's power.

## Setup

```bash
npm install
cp .env.example .env
# Add your API keys to .env
```

## Examples

| # | Script | What it shows |
|---|--------|---------------|
| 01 | `01-hello-agent.ts` | Minimal sandboxed agent |
| 02 | `02-streaming.ts` | All content event types |
| 03 | `03-mcp-chrome.ts` | Chrome DevTools browser automation |
| 04 | `04-multi-turn.ts` | Multi-turn with persistent memory |
| 05 | `05-structured-output.ts` | Data extraction with Zod schema |
| 06 | `06-map-verify.ts` | Swarm map + retry + LLM verification |
| 07 | `07-map-bestof.ts` | Swarm map + bestOf (N candidates) |
| 08 | `08-map-filter-reduce.ts` | Full pipeline: map → filter → reduce |

## Run

```bash
npm run 01  # Hello agent
npm run 02  # Streaming
npm run 03  # MCP Chrome
npm run 04  # Multi-turn
npm run 05  # Structured output
npm run 06  # Map + verify
npm run 07  # Map + bestOf
npm run 08  # Map → filter → reduce
```
