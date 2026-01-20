#!/usr/bin/env python3
"""
Integration Test 10: Swarm Abstractions

Tests map (with bestOf), filter, and reduce using rent roll PDFs.
- map: Extract units from 3 rent rolls using bestOf(2)
- filter: AI assesses risk profile → local condition flags high-risk (score >= 7)
- reduce: Generate portfolio risk summary from flagged properties
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
    BestOfConfig,
    RetryConfig,
)
from tests.utils.test_helpers import log_section, log_result, log_info
from tests.utils.agent_config import get_agent_config

# =============================================================================
# CONFIG
# =============================================================================

LOGS_DIR = Path(__file__).parent.parent / "test-logs" / "10-swarm-abstractions"
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
    overall_risk_score: float = Field(ge=1, le=10, alias="overallRiskScore")
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
# PROMPTS
# =============================================================================

EXTRACT_PROMPT = """
Extract all units from this rent roll PDF.
For each unit: unit number, tenant name, lease start/end dates (YYYY-MM-DD), square footage, monthly rent.
- For vacant units with no tenant, use "VACANT" for tenantName.

IMPORTANT:
You have built-in vision capabilities to see PDF pages as images.
Use the read tool on PDF files directly - they will render visually for you.
Do not install or use external OCR/PDF libraries.
"""

JUDGE_CRITERIA = """
Select the extraction with:
1. Most complete unit data (fewest nulls)
2. Correct date formats (YYYY-MM-DD)
3. Accurate rent figures
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

    log_section("Swarm Abstractions Integration Test")
    log_info(f"Agent: {f'{agent_config.type} ({agent_config.model})' if agent_config else 'from env'}")

    e2b_api_key = os.getenv("E2B_API_KEY")
    if not e2b_api_key:
        raise ValueError("E2B_API_KEY not found in environment")

    swarm = Swarm(SwarmConfig(
        agent=agent_config,
        sandbox=E2BProvider(
            api_key=e2b_api_key,
            timeout_ms=30 * 60 * 1000,  # 30 min sandbox lifetime
        ),
        tag="rentroll",
        concurrency=4,
        timeout_ms=10 * 60 * 1000,  # 10 min per agent
    ))

    # -------------------------------------------------------------------------
    # 1. MAP with bestOf(2)
    # -------------------------------------------------------------------------
    log_info("[1] map + bestOf(2): Extracting from 3 rent rolls...")

    inputs = [
        {"Sample1.pdf": (FIXTURES_DIR / "Sample1.pdf").read_bytes()},
        {"Sample2.pdf": (FIXTURES_DIR / "Sample2.pdf").read_bytes()},
        {"Sample3.pdf": (FIXTURES_DIR / "Sample3.pdf").read_bytes()},
    ]

    map_results = await swarm.map(
        items=inputs,
        prompt=EXTRACT_PROMPT,
        schema=RentRoll,
        best_of=BestOfConfig(
            n=2,
            judge_criteria=JUDGE_CRITERIA,
            judge_agent=AgentConfig(type=agent_config.type, model=agent_config.model) if agent_config else None,
        ),
        retry=RetryConfig(max_attempts=2, backoff_ms=5000),
    )

    for r in map_results:
        idx = r.meta.item_index
        save(f"map/item-{idx}", "winner.json", r.data)
        save(f"map/item-{idx}", "meta.json", r.meta.__dict__)
        if r.error:
            save(f"map/item-{idx}", "error.txt", r.error)
        if r.raw_data:
            save(f"map/item-{idx}", "rawData.json", r.raw_data)
        if r.best_of:
            save(f"map/item-{idx}", "judge.json", {
                "winnerIndex": r.best_of.winner_index,
                "reasoning": r.best_of.judge_reasoning,
                "judgeMeta": r.best_of.judge_meta.__dict__,
            })
            for i, c in enumerate(r.best_of.candidates):
                save(f"map/item-{idx}/candidate-{i}", "data.json", c.data)
                save(f"map/item-{idx}/candidate-{i}", "meta.json", c.meta.__dict__)
                if c.error:
                    save(f"map/item-{idx}/candidate-{i}", "error.txt", c.error)
                if c.raw_data:
                    save(f"map/item-{idx}/candidate-{i}", "rawData.json", c.raw_data)

    log_result(True, f"Success: {len(map_results.success)}, Errors: {len(map_results.error)}")

    # -------------------------------------------------------------------------
    # 2. FILTER: AI assesses risk → local condition flags high-risk
    # -------------------------------------------------------------------------
    log_info(f"[2] filter: AI risk assessment → flagging score >= {RISK_THRESHOLD}...")

    filter_results = await swarm.filter(
        items=map_results.success,
        prompt=FILTER_PROMPT,
        schema=RiskAssessment,
        condition=lambda data: data.overall_risk_score >= RISK_THRESHOLD,
        agent=AgentConfig(type=agent_config.type, model=agent_config.model) if agent_config else None,
        retry=RetryConfig(max_attempts=2, backoff_ms=5000),
    )

    for r in filter_results:
        idx = r.meta.item_index
        save(f"filter/item-{idx}", "assessment.json", r.data)
        save(f"filter/item-{idx}", "status.txt", r.status)
        if r.error:
            save(f"filter/item-{idx}", "error.txt", r.error)
        if r.raw_data:
            save(f"filter/item-{idx}", "rawData.json", r.raw_data)
        if r.data:
            log_info(f"    [{idx}] {r.data.property_name}: score={r.data.overall_risk_score} → {r.status}")

    log_result(True, f"High-risk (success): {len(filter_results.success)}")
    log_info(f"    Lower-risk (filtered): {len(filter_results.filtered)}")
    log_info(f"    Errors: {len(filter_results.error)}")

    # -------------------------------------------------------------------------
    # 3. REDUCE: Portfolio risk summary
    # -------------------------------------------------------------------------
    log_info("[3] reduce: Generating portfolio risk summary...")

    if len(filter_results.success) == 0:
        log_info("    No high-risk properties to reduce. Skipping.")
        save("reduce", "skipped.txt", f"No properties exceeded risk threshold (score >= {RISK_THRESHOLD}).")
    else:
        reduce_result = await swarm.reduce(
            items=filter_results.success,
            prompt=REDUCE_PROMPT,
            schema=PortfolioSummary,
            retry=RetryConfig(max_attempts=2, backoff_ms=5000),
        )

        save("reduce", "result.json", reduce_result.data)
        save("reduce", "meta.json", reduce_result.meta.__dict__)
        if reduce_result.error:
            save("reduce", "error.txt", reduce_result.error)
        if reduce_result.raw_data:
            save("reduce", "rawData.json", reduce_result.raw_data)

        log_result(reduce_result.status == "success", f"Status: {reduce_result.status}")
        if reduce_result.data:
            log_info(f"    Properties at risk: {reduce_result.data.total_properties_analyzed}")
            log_info(f"    Annualized exposure: ${reduce_result.data.annualized_exposure:,.0f}")

    # -------------------------------------------------------------------------
    # SUMMARY
    # -------------------------------------------------------------------------
    log_section("Test complete")
    log_info(f"Results saved to {LOGS_DIR}")


if __name__ == "__main__":
    asyncio.run(main())
