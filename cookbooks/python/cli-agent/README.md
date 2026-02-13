# CLI Agent

A sandboxed CLI agent that can think, execute code, automate browsers (browser-use MCP), read / edit files, and solve complex tasks.
- Put any files in the `input/` folder (auto-created on first run) — they're uploaded to the agent's context.
- Ask for anything — any files the agent creates are automatically downloaded to your local `output/` folder.
- Check traces at https://dashboard.evolvingmachines.ai/traces. Type `/quit` to exit.

## Setup

```bash
cd cookbooks/python/cli-agent
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
```

- Edit `.env` with your API key: `EVOLVE_API_KEY` ([dashboard.evolvingmachines.ai](https://dashboard.evolvingmachines.ai)), `BROWSER_USE_API_KEY` ([browser-use.com](https://browser-use.com), optional)

## Run

```bash
python agent.py
```

## What it does

- Multi-turn conversation with a sandboxed AI agent (Claude, Codex, Gemini, Qwen, Kimi, OpenCode)
- Agent can write code, create files, automate browsers (browser-use)
- Output files are saved to `output/`
- Checkpointing support via `.withStorage()` for persistent sessions
