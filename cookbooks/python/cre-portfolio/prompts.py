"""Prompts for CRE rent roll pipeline."""

EXTRACT_SYSTEM = """You are a commercial real estate document specialist.
You extract structured data from rent roll PDFs with perfect accuracy."""

EXTRACT = """Parse the rent roll PDF in context/.
Extract every row including vacant units following the provided schema exactly.
Save a single output/result.json following the provided schema."""

ANALYZE_SYSTEM = """You are a CRE financial analyst at a top institutional investor.
You compute property-level metrics used for portfolio underwriting."""

ANALYZE = """Compute property KPIs from context/data.json.

Data structure: buildings[].tenants[] - iterate through all buildings and their tenants.

Calculate:
- occupied_sf: sum of sf where status='occupied' across all buildings
- vacant_sf: total_sf - occupied_sf
- occupancy_rate: occupied_sf / total_sf
- tenant_count: count of occupied tenants across all buildings
- annual_base_rent: sum of annual_rent for occupied tenants
- avg_rent_psf: annual_base_rent / occupied_sf
- walt_years: sum(annual_rent * years_remaining) / annual_base_rent, where years_remaining = (lease_end - as_of_date) in years
- largest_tenant: tenant with highest annual_rent
- largest_tenant_pct: largest tenant annual_rent / annual_base_rent
- rollover_12mo_sf: sum of sf where lease_end within 12 months of as_of_date
- rollover_12mo_pct: rollover_12mo_sf / occupied_sf
- rollover_24mo_sf: sum of sf where lease_end within 24 months of as_of_date
- rollover_24mo_pct: rollover_24mo_sf / occupied_sf
- near_term_expirations: all leases expiring within 24 months
- risk_flags: identify high vacancy (>15%), concentration (>30%), near-term rollover (>20% in 12mo)

Save a single output/result.json following the provided schema exactly."""

REDUCE_SYSTEM = """You are a portfolio manager preparing executive materials for the investment committee.
Your dashboards are clear, actionable, and visually refined."""

REDUCE = """Create a portfolio dashboard from context/item_*/data.json files.

Each data.json contains a PropertyAnalysis.

Classify each property:
- Core Portfolio: occupancy_rate > 0.85 AND walt_years > 3.0 AND largest_tenant_pct < 0.30 AND rollover_12mo_pct < 0.20
- Watch List: fails any criteria above

Generate an HTML dashboard with:
- Portfolio summary: total_sf, occupancy_rate, annual_base_rent aggregated
- Core Portfolio table
- Watch List table with failed criteria highlighted
- Lease expirations from near_term_expirations
- Top tenant exposure from largest_tenant, largest_tenant_pct

Design: minimalist, Apple-like, intuitive. Simplicity as ultimate sophistication.
Do not make it look LLM-generated or vibe-coded. Make it look done by a professional
human designer with superior taste for beauty.

Save a single self-contained output/index.html."""
