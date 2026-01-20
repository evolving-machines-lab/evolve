"""
04 - Multi-Turn (Automated Memory)
Multiple .run() calls maintain context and history.
"""
import asyncio
from dotenv import load_dotenv
from evolve import Evolve

load_dotenv()

async def main():
    agent = Evolve()

    # Turn 1: Create initial data
    await agent.run(
        prompt="Create a JSON file with 5 random users (name, email, age)"
    )
    output1 = await agent.get_output_files()
    print("Turn 1:", list(output1.files.keys()))

    # Turn 2: Agent remembers the file it created
    await agent.run(
        prompt="Filter the users to only include those over 25"
    )
    output2 = await agent.get_output_files()
    print("Turn 2:", list(output2.files.keys()))

    # Turn 3: Agent has full conversation history
    await agent.run(
        prompt="Create a summary report of the filtered users"
    )
    output3 = await agent.get_output_files()
    print("Turn 3:", list(output3.files.keys()))

    await agent.kill()

if __name__ == "__main__":
    asyncio.run(main())
