#!/usr/bin/env python3
"""
Integration Test 13: Pipeline Abstractions

Replicates test 10 using Pipeline instead of Swarm directly.
Uses prompts from test 12. Demonstrates all 8 pipeline events.
Uses Swarm-level retry defaults (inherited by all operations).

- map: Extract units from 3 rent rolls with verify (2 max attempts)
- filter: AI assesses risk profile -> local condition flags high-risk (score >= 7)
- reduce: Generate portfolio risk summary from flagged properties

Events logged: stepStart, stepComplete, stepError, itemRetry,
               workerComplete, verifierComplete, candidateComplete, judgeComplete
"""

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import List, Literal, Optional

from pydantic import BaseModel, ConfigDict, Field

# Add parent to path for imports
import sys
sys.path.insert(0, str(Path(__file__).parent.parent.parent))

from evolve import (
    Swarm,
    SwarmConfig,
    AgentConfig,
    E2BProvider,
    VerifyConfig,
    RetryConfig,
    Pipeline,
    MapConfig,
    FilterConfig,
    ReduceConfig,
)
from tests.utils.test_helpers import log_section, log_result, log_info
from tests.utils.agent_config import get_agent_config

# =============================================================================
# CONFIG
# =============================================================================

LOGS_DIR = Path(__file__).parent.parent / "test-logs" / "13-pipeline-abstractions"
FIXTURES_DIR = Path(__file__).parent.parent.parent.parent / "sdk-ts" / "tests" / "fixtures" / "test_data"

RISK_THRESHOLD = 7  # Score >= 7 = high risk

# =============================================================================
# PYDANTIC SCHEMAS
# =============================================================================

class Unit(BaseModel):
    """Single unit in a rent roll."""
    model_config = ConfigDict(populate_by_name=True)

    unit_number: str = Field(alias="unitNumber")
    tenant_name: Optional[str] = Field(alias="tenantName")
    lease_start: Optional[str] = Field(alias="leaseStart")
    lease_end: Optional[str] = Field(alias="leaseEnd")
    square_footage: Optional[float] = Field(alias="squareFootage")
    monthly_rent: Optional[float] = Field(alias="monthlyRent")


class RentRoll(BaseModel):
    """Extracted rent roll data."""
    model_config = ConfigDict(populate_by_name=True)

    property_name: str = Field(alias="propertyName")
    units: List[Unit]


class RiskAssessment(BaseModel):
    """Risk assessment for a property."""
    model_config = ConfigDict(populate_by_name=True)

    property_name: str = Field(alias="propertyName")
    tenant_concentration_risk: Literal["low", "medium", "high"] = Field(alias="tenantConcentrationRisk")
    lease_rollover_risk: Literal["low", "medium", "high"] = Field(alias="leaseRolloverRisk")
    rent_collection_risk: Literal["low", "medium", "high"] = Field(alias="rentCollectionRisk")
    overall_risk_score: int = Field(alias="overallRiskScore", ge=1, le=10)
    reasoning: str


class PortfolioSummary(BaseModel):
    """Portfolio-level risk summary."""
    model_config = ConfigDict(populate_by_name=True)

    total_properties_analyzed: int = Field(alias="totalPropertiesAnalyzed")
    total_units: int = Field(alias="totalUnits")
    total_units_expiring: int = Field(alias="totalUnitsExpiring")
    total_monthly_rent_at_risk: float = Field(alias="totalMonthlyRentAtRisk")
    annualized_exposure: float = Field(alias="annualizedExposure")
    avg_rollover_pct: float = Field(alias="avgRolloverPct")
    highest_risk_property: str = Field(alias="highestRiskProperty")
    priority_actions: List[str] = Field(alias="priorityActions")


# =============================================================================
# PROMPTS (from test 12)
# =============================================================================

SYSTEM_PROMPT = """You are a precise data extraction agent specialized in real estate documents.
Your task is to extract structured data from CRE rent roll PDFs with high accuracy.
- Read PDF files directly using your built-in vision capabilities
- Do not install or use external OCR/PDF libraries
- Be thorough: extract ALL units, do not skip any rows
- Be precise: dates must be YYYY-MM-DD format, numbers must be accurate
- For each unit: unit number, tenant name, lease start/end dates (YYYY-MM-DD), square footage, monthly rent.
- For vacant units with no tenant, use "VACANT" for tenantName."""

EXTRACT_PROMPT = """Extract all units from the rent roll PDF in context/"""

VERIFY_CRITERIA = """
Check the extraction for accuracy:
1. All units from the PDF are extracted (no missing rows)
2. Dates are in YYYY-MM-DD format
3. Rent and square footage values are numeric and reasonable
"""

FILTER_PROMPT = """
You are a CRE risk analyst. Analyze the rent roll data and assess the property's risk profile.

Consider:
- Tenant concentration: Is rent dominated by few tenants?
- Lease rollover: What % of leases expire within 12 months?
- Rent collection: Are there signs of delinquency or below-market rents?

Score overall risk from 1 (minimal) to 10 (severe).
"""

REDUCE_PROMPT = """
You are a CRE analyst. These properties were flagged as high-risk (risk score >= 7/10).

Analyze all properties in context/ and provide a portfolio-level risk summary:
- Total exposure (units, rent at risk)
- Which property needs most urgent attention
- Priority actions for the asset manager
"""


# =============================================================================
# HELPERS
# =============================================================================

def save(subdir: str, name: str, content) -> None:
    """Save content to logs directory."""
    dir_path = LOGS_DIR / subdir
    dir_path.mkdir(parents=True, exist_ok=True)

    if isinstance(content, BaseModel):
        data = content.model_dump_json(indent=2, by_alias=True)
    elif isinstance(content, str):
        data = content
    else:
        data = json.dumps(content, indent=2, default=str)

    (dir_path / name).write_text(data)


# =============================================================================
# MAIN TEST
# =============================================================================

async def main():
    # Clean and create logs directory
    if LOGS_DIR.exists():
        shutil.rmtree(LOGS_DIR)
    LOGS_DIR.mkdir(parents=True, exist_ok=True)

    agent_config = get_agent_config()

    log_section("Pipeline Abstractions Integration Test")
    log_info(f"Agent: {f'{agent_config.type} ({agent_config.model})' if agent_config else 'from env'}")

    e2b_api_key = os.getenv("E2B_API_KEY")
    if not e2b_api_key:
        raise ValueError("E2B_API_KEY not found in environment")

    swarm = Swarm(SwarmConfig(
        agent=agent_config,
        sandbox=E2BProvider(
            api_key=e2b_api_key,
            timeout_ms=30 * 60 * 1000,
        ),
        tag="rentroll",
        concurrency=4,
        timeout_ms=10 * 60 * 1000,
        retry=RetryConfig(max_attempts=2, backoff_ms=5000),
    ))

    # -------------------------------------------------------------------------
    # INPUTS
    # -------------------------------------------------------------------------
    inputs = [
        {"Sample1.pdf": (FIXTURES_DIR / "Sample1.pdf").read_bytes()},
        {"Sample2.pdf": (FIXTURES_DIR / "Sample2.pdf").read_bytes()},
        {"Sample3.pdf": (FIXTURES_DIR / "Sample3.pdf").read_bytes()},
    ]

    # -------------------------------------------------------------------------
    # PIPELINE: map -> filter -> reduce
    # -------------------------------------------------------------------------
    log_info("[Pipeline] Running map -> filter -> reduce...")

    result = await (
        Pipeline(swarm)
        # Step 0: Extract with verify (2 max attempts)
        .map(MapConfig(
            name="extract",
            prompt=EXTRACT_PROMPT,
            system_prompt=SYSTEM_PROMPT,
            schema=RentRoll,
            verify=VerifyConfig(
                criteria=VERIFY_CRITERIA,
                max_attempts=2,
                verifier_agent=AgentConfig(type=agent_config.type, model=agent_config.model) if agent_config else None,
            ),
            # retry inherited from Swarm config
        ))
        # Step 1: Risk assessment filter
        .filter(FilterConfig(
            name="risk-filter",
            prompt=FILTER_PROMPT,
            schema=RiskAssessment,
            condition=lambda data: data.overall_risk_score >= RISK_THRESHOLD,
            agent=AgentConfig(type=agent_config.type, model=agent_config.model) if agent_config else None,
            # retry inherited from Swarm config
        ))
        # Step 2: Portfolio summary
        .reduce(ReduceConfig(
            name="portfolio-summary",
            prompt=REDUCE_PROMPT,
            schema=PortfolioSummary,
            # retry inherited from Swarm config
        ))
        # Event handlers - all 8 events
        .on("step_start", lambda e: print(f"\n  [Step {e.index}: {e.name}] Started with {e.item_count} items"))
        .on("step_complete", lambda e: print(f"  [Step {e.index}: {e.name}] Completed in {e.duration_ms}ms\n    Success: {e.success_count}, Errors: {e.error_count}, Filtered: {e.filtered_count}"))
        .on("step_error", lambda e: print(f"  [Step {e.index}: {e.name}] Error: {e.error}"))
        .on("item_retry", lambda e: print(f"    [{e.step_name}] Item {e.item_index} retry #{e.attempt}: {e.error}"))
        .on("worker_complete", lambda e: print(f"    [{e.step_name}] Item {e.item_index} worker attempt {e.attempt}: {e.status}"))
        .on("verifier_complete", lambda e: print(f"    [{e.step_name}] Item {e.item_index} verifier attempt {e.attempt}: {'PASS' if e.passed else 'FAIL'}{f' - {e.feedback}' if e.feedback else ''}"))
        .on("candidate_complete", lambda e: print(f"    [{e.step_name}] Item {e.item_index} candidate {e.candidate_index}: {e.status}"))
        .on("judge_complete", lambda e: print(f"    [{e.step_name}] Item {e.item_index} judge picked #{e.winner_index}"))
        .run(inputs)
    )

    # -------------------------------------------------------------------------
    # SAVE RESULTS
    # -------------------------------------------------------------------------
    save("pipeline", "result.json", {
        "pipeline_run_id": result.pipeline_run_id,
        "total_duration_ms": result.total_duration_ms,
        "steps_count": len(result.steps),
    })

    # Save each step's results
    for step in result.steps:
        step_dir = f"pipeline/step-{step.index}"
        save(step_dir, "meta.json", {
            "type": step.type,
            "index": step.index,
            "duration_ms": step.duration_ms,
        })

        if step.type == "reduce":
            # reduce returns ReduceResult
            reduce_result = step.results
            save(step_dir, "result.json", reduce_result.data)
            if reduce_result.error:
                save(step_dir, "error.txt", reduce_result.error)
        else:
            # map/filter return SwarmResult[]
            for r in step.results:
                item_dir = f"{step_dir}/item-{r.meta.item_index}"
                save(item_dir, "data.json", r.data)
                save(item_dir, "status.txt", r.status)
                if r.error:
                    save(item_dir, "error.txt", r.error)
                if r.verify:
                    save(item_dir, "verify.json", {
                        "passed": r.verify.passed,
                        "reasoning": r.verify.reasoning,
                        "attempts": r.verify.attempts,
                    })
                if r.best_of:
                    save(item_dir, "bestOf.json", {
                        "winner_index": r.best_of.winner_index,
                        "judge_reasoning": r.best_of.judge_reasoning,
                    })

    # Save final output
    if hasattr(result.output, 'status'):
        # ReduceResult
        reduce_output = result.output
        save("output", "final.json", reduce_output.data)
        if reduce_output.error:
            save("output", "error.txt", reduce_output.error)

        print(f"\n[Result] Status: {reduce_output.status}")
        if reduce_output.data:
            print(f"  Properties at risk: {reduce_output.data.total_properties_analyzed}")
            print(f"  Annualized exposure: ${reduce_output.data.annualized_exposure:,.0f}")

    # -------------------------------------------------------------------------
    # SUMMARY
    # -------------------------------------------------------------------------
    log_section("Test complete")
    print(f"Pipeline completed in {result.total_duration_ms}ms (pipelineRunId: {result.pipeline_run_id})")
    log_info(f"Results saved to {LOGS_DIR}")


if __name__ == "__main__":
    asyncio.run(main())
