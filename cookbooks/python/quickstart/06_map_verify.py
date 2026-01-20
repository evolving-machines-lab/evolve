"""
06 - Map + Verify
Parallel processing with LLM-as-judge verification.
"""
import asyncio
from dotenv import load_dotenv
from pydantic import BaseModel
from evolve import Swarm, VerifyConfig, RetryConfig

load_dotenv()

class SummarySchema(BaseModel):
    title: str
    key_points: list[str]
    word_count: int

async def main():
    # Swarm processes multiple items in parallel sandboxes
    swarm = Swarm()

    documents = [
        {"doc.txt": "Q1 2024: Revenue increased 15% YoY driven by new product launches..."},
        {"doc.txt": "Q2 2024: Operational costs reduced by 8% through automation..."},
        {"doc.txt": "Q3 2024: Market expansion into APAC region exceeded targets..."},
    ]

    results = await swarm.map(
        items=documents,
        prompt="""
            Summarize this quarterly report.
            Include a title, key points, and word count.
        """,
        schema=SummarySchema,
        # LLM judge verifies output, retries with feedback if failed
        verify=VerifyConfig(
            criteria="Summary must include at least 3 key points and accurate word count",
            max_attempts=2,
        ),
        # Auto-retry on error with exponential backoff
        retry=RetryConfig(
            max_attempts=3,
            backoff_ms=1000,
        ),
    )

    # Access successful results
    for r in results.success:
        if r.data:
            print(r.data.title, "-", len(r.data.key_points), "key points")

if __name__ == "__main__":
    asyncio.run(main())
