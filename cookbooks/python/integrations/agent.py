#!/usr/bin/env python3
"""
Swarm CLI Agent + Managed Integrations

AI agent with access to external services via Evolve-managed integrations.
Can send emails, post to Slack, create GitHub issues, update Notion, and more.

Run: python agent.py
"""
import asyncio
from pathlib import Path

from dotenv import load_dotenv

from evolve import Evolve, AgentConfig, IntegrationsSetup, read_local_dir, save_local_dir
from ui import console, make_renderer, read_prompt

load_dotenv()

# ─────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────

USER_ID = "swarm-user-002"
ENABLED_APPS = ["gmail"]

SYSTEM_PROMPT = """Your name is Manus Evolve, a powerful autonomous AI agent.
You can execute code, manage files, and take actions across external services via managed integrations.
"""

# ─────────────────────────────────────────────────────────────
# Evolve Agent
# ─────────────────────────────────────────────────────────────

agent = Evolve(
    config=AgentConfig(type="claude", model="sonnet"),
    system_prompt=SYSTEM_PROMPT,
    integrations=IntegrationsSetup(user_id=USER_ID, apps=ENABLED_APPS),
    session_tag_prefix="swarm-integrations-py",
)

# ─────────────────────────────────────────────────────────────


async def main():
    # Pre-authenticate managed services.
    for app in ENABLED_APPS:
        accounts = await Evolve.integrations.accounts.list(
            user_ids=[USER_ID],
            app=app,
            statuses=["ACTIVE"],
        )
        if accounts:
            continue

        result = await Evolve.integrations.auth(user_id=USER_ID, app=app)
        console.print(f"\n[cyan]{app}[/cyan]: {result.url}")
        console.print("[dim]Press Enter after authenticating...[/dim]")
        await asyncio.to_thread(input)

    renderer = make_renderer()
    agent.on("content", lambda event: renderer.handle_event(event))

    console.print()
    console.print("[bold cyan]Swarm[/bold cyan] + [bold magenta]Integrations[/bold magenta]")
    console.print("[dim]AI Agent with external integrations[/dim]")
    console.print()

    while True:
        prompt = await read_prompt()
        if not prompt:
            continue
        if prompt in ("/quit", "/exit", "/q"):
            await agent.kill()
            console.print()
            console.print("[dim]Goodbye[/dim]")
            break

        renderer.reset()
        renderer.start_live()

        # Upload input files to agent's context
        input_dir = Path("input")
        if input_dir.exists():
            input_files = read_local_dir(str(input_dir))
            if input_files:
                await agent.upload_context(input_files)

        await agent.run(prompt=prompt)
        renderer.stop_live()

        # Download output files
        output = await agent.get_output_files(recursive=True)
        if output.files:
            save_local_dir("output", output.files)
            console.print()
            for name in output.files:
                console.print(f"[green]Saved: output/{name}[/green]")

        console.print()


async def shutdown():
    await agent.kill()
    console.print()
    console.print("[dim]Goodbye[/dim]")


# ─────────────────────────────────────────────────────────────

if __name__ == "__main__":
    Path("input").mkdir(exist_ok=True)
    Path("output").mkdir(exist_ok=True)

    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        asyncio.run(shutdown())
