"""
08 - Pipeline: Map -> Filter -> Reduce
Fluent API for multi-step workflows.
"""
import asyncio
from typing import Literal
from dotenv import load_dotenv
from pydantic import BaseModel
from evolve import Swarm, Pipeline, MapConfig, FilterConfig, ReduceConfig

load_dotenv()

class AnalysisSchema(BaseModel):
    summary: str
    risk_level: Literal["critical", "high", "medium", "low"]
    issues: list[str]

class FilterSchema(BaseModel):
    is_critical: bool
    justification: str

class ReportSchema(BaseModel):
    executive_summary: str
    critical_findings: list[str]
    recommendations: list[str]

async def main():
    swarm = Swarm()

    # Pipeline chains operations with fluent API
    pipeline = (
        Pipeline(swarm)
        # Step 1: Analyze each item in parallel
        .map(MapConfig(
            name="analyze",
            prompt="""
                Analyze this security report.
                Assess the risk level and list all issues found.
            """,
            schema=AnalysisSchema,
        ))
        # Step 2: Filter to critical items only
        .filter(FilterConfig(
            name="critical-only",
            prompt="Determine if this finding requires immediate attention",
            schema=FilterSchema,
            condition=lambda d: d.is_critical,
        ))
        # Step 3: Synthesize into single report
        .reduce(ReduceConfig(
            name="synthesize",
            prompt="""
                Create an executive security report.
                Summarize all critical findings and provide recommendations.
            """,
            schema=ReportSchema,
        ))
    )

    security_reports = [
        {"report.txt": "SQL injection vulnerability found in login endpoint..."},
        {"report.txt": "Minor CSS styling issue on mobile devices..."},
        {"report.txt": "Authentication bypass possible via API token reuse..."},
        {"report.txt": "Outdated library version with known CVE..."},
    ]

    # Pipeline is reusable - run with different data
    result = await pipeline.run(security_reports)

    # Pipeline ending with reduce() returns ReduceResult
    if result.output and hasattr(result.output, "data") and result.output.data:
        print("Executive Summary:", result.output.data.executive_summary)
        print("Critical Findings:", result.output.data.critical_findings)

if __name__ == "__main__":
    asyncio.run(main())
