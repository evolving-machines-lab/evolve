"""
03 - MCP Chrome DevTools
Browser automation with Chrome DevTools MCP server.
"""
import asyncio
from dotenv import load_dotenv
from evolve import Evolve

load_dotenv()

async def main():
    # MCP servers extend agent capabilities with external tools
    agent = Evolve(
        mcp_servers={
            "chrome-devtools": {
                "command": "npx",
                "args": [
                    "chrome-devtools-mcp@latest",
                    "--headless=true",
                    "--isolated=true",
                    "--chromeArg=--no-sandbox",
                    "--chromeArg=--disable-setuid-sandbox",
                    "--chromeArg=--disable-dev-shm-usage",
                ],
                "env": {},
            },
        }
    )

    await agent.run(
        prompt="""
            Use Chrome DevTools to:
            1. Navigate to https://news.ycombinator.com
            2. Take a screenshot and save it to a file
        """
    )

    output = await agent.get_output_files()
    print(list(output.files.keys()))

    await agent.kill()

if __name__ == "__main__":
    asyncio.run(main())
