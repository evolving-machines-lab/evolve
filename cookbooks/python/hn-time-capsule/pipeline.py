"""
HN Time Capsule - Evolve Edition

Karpathy's 1,486 lines → 50 lines
"""

import json
import shutil
from pathlib import Path
from dotenv import load_dotenv
from evolve import Swarm, SwarmConfig, Pipeline, MapConfig, ReduceConfig, RetryConfig, AgentConfig
from prompts import FETCH, ANALYZE, RENDER
from schema import Analysis
from utils import save_intermediate

load_dotenv()


swarm = Swarm(SwarmConfig(
    tag='hn-time-capsule',
    concurrency=1000,
    retry=RetryConfig(max_attempts=2),
))

pipeline = (
    Pipeline(swarm)
    .map(MapConfig(
        name='fetch',
        prompt=FETCH,
        agent=AgentConfig(type='claude', model='haiku'),
    ))
    .map(MapConfig(
        name='analyze',
        prompt=ANALYZE,
        schema=Analysis,
        agent=AgentConfig(type='claude', model='haiku'),
    ))
    .reduce(ReduceConfig(
        name='render',
        prompt=RENDER,
    ))
)


async def main():
    # Clean previous run
    shutil.rmtree("intermediate", ignore_errors=True)
    shutil.rmtree("output", ignore_errors=True)

    date = "2015-12-01"
    limit = 30

    items = [{"config.json": json.dumps({"rank": i, "date": date})} for i in range(1, limit + 1)]

    print(f"Processing {len(items)} articles from {date}...")
    result = await pipeline.run(items)

    save_intermediate(result.steps[0].results, "fetch")
    save_intermediate(result.steps[1].results, "analyze")

    Path("output").mkdir(exist_ok=True)
    for name, content in result.output.files.items():
        Path(f"output/{name}").write_text(content)
    print(f"Done! Output saved to ./output/")


if __name__ == "__main__":
    import asyncio
    asyncio.run(main())
