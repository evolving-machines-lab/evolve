"""
01 - Hello Agent
Sandboxed AI agent.
"""
import asyncio
from dotenv import load_dotenv
from evolve import Evolve

load_dotenv()

async def main():
    # Auto-resolves EVOLVE_API_KEY from environment
    agent = Evolve()

    await agent.run(
        prompt="""
            Research the latest developments in AI agents.
            Generate a brief report summarizing the top 3 findings.
        """
    )

    # Retrieve files from sandbox output/ folder
    output = await agent.get_output_files()
    print(list(output.files.keys()))

    await agent.kill()

if __name__ == "__main__":
    asyncio.run(main())
