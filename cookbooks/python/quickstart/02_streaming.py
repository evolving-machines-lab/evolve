"""
02 - Streaming
Real-time output with all content event types.
"""
import asyncio
import sys
from dotenv import load_dotenv
from evolve import Evolve

load_dotenv()

def handle_content(event):
    update = event.get("update", {})
    event_type = update.get("sessionUpdate")

    if event_type == "agent_message_chunk":
        # Text output from agent
        content = update.get("content", {})
        if content.get("type") == "text":
            sys.stdout.write(content.get("text", ""))
            sys.stdout.flush()

    elif event_type == "agent_thought_chunk":
        # Reasoning/thinking
        content = update.get("content", {})
        if content.get("type") == "text":
            sys.stdout.write(f"[thinking] {content.get('text', '')}")
            sys.stdout.flush()

    elif event_type == "tool_call":
        # Tool execution started
        print(f"\n[tool] {update.get('title')} ({update.get('kind')})")

    elif event_type == "tool_call_update":
        # Tool execution finished
        print(f"[tool] {update.get('toolCallId')} -> {update.get('status')}")

    elif event_type == "plan":
        # Agent todo list updates
        for entry in update.get("entries", []):
            icons = {"completed": "✓", "in_progress": "→", "pending": "○"}
            icon = icons.get(entry.get("status"), "○")
            print(f"{icon} {entry.get('content')}")

async def main():
    agent = Evolve()

    # Listen to parsed content events (recommended over raw stdout)
    agent.on("content", handle_content)

    await agent.run(
        prompt="Explain quantum computing in 3 sentences"
    )

    await agent.kill()

if __name__ == "__main__":
    asyncio.run(main())
