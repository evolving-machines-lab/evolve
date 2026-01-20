#!/usr/bin/env python3
"""
Integration Test 12: Swarm Verify

Tests map with verify option using rent roll PDFs.
- map + verify: Extract units from 3 rent rolls with quality verification
- Verifier checks extraction quality and retries with feedback if needed
"""

import asyncio
import json
import os
import shutil
from pathlib import Path
from typing import List, Optional

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
)
from tests.utils.test_helpers import log_section, log_result, log_info
from tests.utils.agent_config import get_agent_config

# =============================================================================
# CONFIG
# =============================================================================

LOGS_DIR = Path(__file__).parent.parent / "test-logs" / "12-swarm-verify"
FIXTURES_DIR = Path(__file__).parent.parent.parent.parent / "sdk-ts" / "tests" / "fixtures" / "test_data"

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


# =============================================================================
# PROMPTS
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

VERIFY_CRITERIA = """Check for any data extraction inaccuracies."""


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

    log_section("Swarm Verify Integration Test")
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
    ))

    # -------------------------------------------------------------------------
    # MAP with verify
    # -------------------------------------------------------------------------
    log_info("[1] map + verify: Extracting from 3 rent rolls with verification...")

    inputs = [
        {"Sample1.pdf": (FIXTURES_DIR / "Sample1.pdf").read_bytes()},
        {"Sample2.pdf": (FIXTURES_DIR / "Sample2.pdf").read_bytes()},
        {"Sample3.pdf": (FIXTURES_DIR / "Sample3.pdf").read_bytes()},
    ]

    map_results = await swarm.map(
        items=inputs,
        prompt=EXTRACT_PROMPT,
        system_prompt=SYSTEM_PROMPT,
        schema=RentRoll,
        verify=VerifyConfig(
            criteria=VERIFY_CRITERIA,
            max_attempts=2,
            verifier_agent=AgentConfig(type=agent_config.type, model=agent_config.model) if agent_config else None,
        ),
        retry=RetryConfig(max_attempts=2, backoff_ms=1000),
    )

    for r in map_results:
        idx = r.meta.item_index
        save(f"map/item-{idx}", "result.json", r.data)
        save(f"map/item-{idx}", "meta.json", r.meta.__dict__)
        save(f"map/item-{idx}", "status.txt", r.status)
        if r.error:
            save(f"map/item-{idx}", "error.txt", r.error)
        if r.raw_data:
            save(f"map/item-{idx}", "rawData.json", r.raw_data)

        # Save verify info
        if r.verify:
            save(f"map/item-{idx}", "verify.json", {
                "passed": r.verify.passed,
                "reasoning": r.verify.reasoning,
                "attempts": r.verify.attempts,
                "verifyMeta": r.verify.verify_meta.__dict__,
            })
            property_name = r.data.property_name if r.data else "unknown"
            status = "PASS" if r.verify.passed else "FAIL"
            log_info(f"    [{idx}] {property_name}: verify={status} ({r.verify.attempts} attempt(s))")
        else:
            property_name = r.data.property_name if r.data else "unknown"
            log_info(f"    [{idx}] {property_name}: no verify info")

    log_result(True, f"Success: {len(map_results.success)}, Errors: {len(map_results.error)}")

    # -------------------------------------------------------------------------
    # SUMMARY
    # -------------------------------------------------------------------------
    log_section("Test complete")
    log_info(f"Results saved to {LOGS_DIR}")


if __name__ == "__main__":
    asyncio.run(main())
