"""Structured output schemas for CRE rent roll analysis."""

from typing import Optional
from pydantic import BaseModel, Field


# === EXTRACT SCHEMA ===

class Tenant(BaseModel):
    tenant_name: str = Field(description="Tenant/company name")
    unit: str = Field(description="Unit or suite number")
    sf: float = Field(description="Leased square feet")
    lease_start: str = Field(description="Lease start date (YYYY-MM-DD or empty if vacant)")
    lease_end: str = Field(description="Lease end date (YYYY-MM-DD or empty if vacant)")
    monthly_rent: float = Field(description="Monthly base rent in dollars")
    annual_rent: float = Field(description="Annual base rent (monthly * 12)")
    rent_psf: float = Field(description="Annual rent per square foot")
    status: str = Field(description="'occupied' or 'vacant'")


class Building(BaseModel):
    building_name: Optional[str] = Field(default=None, description="Building name (null if single-building property)")
    tenants: list[Tenant] = Field(description="List of tenants and vacant units in this building")


class RentRollExtract(BaseModel):
    property_name: str = Field(description="Property name derived from PDF filename (e.g., 'Harborview_Retail_Center.pdf' → 'Harborview Retail Center')")
    as_of_date: str = Field(description="Rent roll as-of date (YYYY-MM-DD)")
    total_units: int = Field(description="Total number of units/suites")
    total_sf: float = Field(description="Total rentable square feet")
    buildings: list[Building] = Field(description="List of buildings (single-building properties have one entry with building_name=null)")


# === ANALYZE SCHEMA ===

class LeaseExpiration(BaseModel):
    tenant_name: str = Field(description="Tenant name")
    sf: float = Field(description="Square feet expiring")
    annual_rent: float = Field(description="Annual rent expiring")
    expiration_date: str = Field(description="Lease expiration date")


class PropertyAnalysis(BaseModel):
    property_name: str = Field(description="Property/building name")
    as_of_date: str = Field(description="Analysis as-of date (YYYY-MM-DD)")
    total_sf: float = Field(description="Total rentable square feet")
    occupied_sf: float = Field(description="Occupied square feet")
    vacant_sf: float = Field(description="Vacant square feet")
    occupancy_rate: float = Field(description="Occupancy rate as decimal (0.85 = 85%)")
    tenant_count: int = Field(description="Number of occupied tenants")
    annual_base_rent: float = Field(description="Total annual base rent (occupied)")
    avg_rent_psf: float = Field(description="Average rent per SF (occupied)")
    walt_years: float = Field(description="Weighted average lease term remaining (years), weighted by annual rent")
    largest_tenant: str = Field(description="Name of largest tenant by rent")
    largest_tenant_pct: float = Field(description="Largest tenant as % of total rent (0.25 = 25%)")
    rollover_12mo_sf: float = Field(description="SF expiring in next 12 months from as-of date")
    rollover_12mo_pct: float = Field(description="SF expiring in 12mo as % of occupied SF (0.15 = 15%)")
    rollover_24mo_sf: float = Field(description="SF expiring in next 24 months from as-of date")
    rollover_24mo_pct: float = Field(description="SF expiring in 24mo as % of occupied SF (0.30 = 30%)")
    near_term_expirations: list[LeaseExpiration] = Field(description="Leases expiring within 24 months")
    risk_flags: list[str] = Field(description="Risk factors identified (high vacancy, concentration, rollover)")
