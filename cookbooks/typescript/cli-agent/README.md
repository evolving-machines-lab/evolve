# Swarm CLI Agent

A sandboxed CLI agent that can think, execute code, automate browsers (browser-use MCP), read / edit files, and solve complex tasks.
- Put any files to the `input/` folder that is automatically created upon running `npx tsx Swarm.ts`: these files will be part of the agent context.
- Ask for anything—any files the agent creates are automatically downloaded to your local `output/` folder.
- Check traces at https://dashboard.evolvingmachines.ai/traces. Type `/quit` to exit.

## Setup

```bash
cd cookbooks/typescript/cli-agent
npm install
cp .env.example .env
```

- Edit `.env` with your API key: `EVOLVE_API_KEY` ([dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai)), `BROWSER_USE_API_KEY` ([browser-use.com](https://browser-use.com), optional)

## Run

```bash
npx tsx swarm.ts
```

## What it does

- Multi-turn conversation with a sandboxed AI agent
- Agent can write code, create files, automate browsers (browser-use)
- Output files are saved to `output/`
