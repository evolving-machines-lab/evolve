"""
Browser-Use Cookbook
Browser automation with browser-use cloud API.

Setup:
  export EVOLVE_API_KEY=your-api-key

Gateway mode automatically includes browser-use MCP server.
"""
import asyncio
import os
from dotenv import load_dotenv

from evolve import AgentConfig, MapConfig, Pipeline, RetryConfig, Swarm, SwarmConfig, VerifyConfig

load_dotenv()

from items import build_items, save_results, setup_run_dir
from prompt import visit_post_prompt
from schema import HNPostResult

# Gateway mode: browser-use MCP is auto-configured via EVOLVE_API_KEY
# For BYOK mode, uncomment mcp_servers and add to SwarmConfig below:
#
# mcp_servers = {
#     "browser-use": {
#         "command": "npx",
#         "args": [
#             "-y", "mcp-remote", "https://api.browser-use.com/mcp",
#             "--header", f"X-Browser-Use-API-Key: {os.getenv('BROWSER_USE_API_KEY')}",
#         ],
#     }
# }

swarm = Swarm(
    SwarmConfig(
        tag="quickstart-hn-browser-use",
        concurrency=4,
        retry=RetryConfig(max_attempts=2),
        # mcp_servers=mcp_servers,  # Uncomment for BYOK mode
    )
)

pipeline = Pipeline(swarm).map(
    MapConfig(
        name="visit-post",
        prompt=visit_post_prompt,
        schema=HNPostResult,
        agent=AgentConfig(type="claude", model="haiku"),
        timeout_ms=15 * 60 * 1000,
        verify=VerifyConfig(
            criteria="""
                The result must meet ALL these requirements:
                1. Summary field must contain a meaningful markdown summary (not an error message)
                2. Summary must be at least 500 characters long with proper formatting
                3. At least 2-3 relevant screenshots must be captured and listed
                4. Title, outbound_url, and final_url must be extracted
                5. Summary must include embedded screenshot references using markdown image syntax
                6. No error field or error field must be null
            """,
            max_attempts=2,
        ),
    )
)


async def main():
    items = build_items(count=3)
    run_dir, posts_dir, started_at = setup_run_dir(items)

    print(f"Visiting top {len(items)} Hacker News posts...")
    result = await pipeline.run(items)

    save_results(result, items, posts_dir, run_dir, started_at)
    print(f"Done. Artifacts saved to: {run_dir}")


if __name__ == "__main__":
    asyncio.run(main())
