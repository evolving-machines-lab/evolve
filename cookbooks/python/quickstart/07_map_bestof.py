"""
07 - Map + BestOf
Parallel processing with N candidates per item, judge picks best.
"""
import asyncio
from typing import Literal
from dotenv import load_dotenv
from pydantic import BaseModel
from evolve import Swarm, BestOfConfig, RetryConfig

load_dotenv()

class AnalysisSchema(BaseModel):
    sentiment: Literal["positive", "neutral", "negative"]
    confidence: float
    reasoning: str

async def main():
    swarm = Swarm()

    reviews = [
        {"review.txt": "This product exceeded my expectations! Fast shipping and great quality."},
        {"review.txt": "Okay product, nothing special. Arrived on time but packaging was damaged."},
        {"review.txt": "Terrible experience. Product broke after 2 days, no response from support."},
    ]

    results = await swarm.map(
        items=reviews,
        prompt="""
            Analyze the sentiment of this customer review.
            Provide sentiment, confidence score (0-1), and reasoning.
        """,
        schema=AnalysisSchema,
        # Run N candidates per item, judge picks best result
        best_of=BestOfConfig(
            n=3,
            judge_criteria="Most accurate sentiment classification with well-reasoned explanation",
        ),
        # Auto-retry on error
        retry=RetryConfig(
            max_attempts=2,
        ),
    )

    # Each result contains the winning candidate
    for r in results.success:
        if r.data and r.best_of:
            print(r.data.sentiment, f"({r.data.confidence})", "-", r.best_of.judge_reasoning)

if __name__ == "__main__":
    asyncio.run(main())
