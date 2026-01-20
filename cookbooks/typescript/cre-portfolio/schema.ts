/**
 * Structured output schemas for CRE rent roll analysis.
 */

import { z } from "zod";

// === EXTRACT SCHEMA ===

const TenantSchema = z.object({
    tenant_name: z.string().describe("Tenant/company name"),
    unit: z.string().describe("Unit or suite number"),
    sf: z.number().describe("Leased square feet"),
    lease_start: z.string().describe("Lease start date (YYYY-MM-DD or empty if vacant)"),
    lease_end: z.string().describe("Lease end date (YYYY-MM-DD or empty if vacant)"),
    monthly_rent: z.number().describe("Monthly base rent in dollars"),
    annual_rent: z.number().describe("Annual base rent (monthly * 12)"),
    rent_psf: z.number().describe("Annual rent per square foot"),
    status: z.string().describe("'occupied' or 'vacant'"),
});

const BuildingSchema = z.object({
    building_name: z.string().nullable().describe("Building name (null if single-building property)"),
    tenants: z.array(TenantSchema).describe("List of tenants and vacant units in this building"),
});

export const RentRollExtractSchema = z.object({
    property_name: z.string().describe("Property name derived from PDF filename (e.g., 'Harborview_Retail_Center.pdf' → 'Harborview Retail Center')"),
    as_of_date: z.string().describe("Rent roll as-of date (YYYY-MM-DD)"),
    total_units: z.number().describe("Total number of units/suites"),
    total_sf: z.number().describe("Total rentable square feet"),
    buildings: z.array(BuildingSchema).describe("List of buildings (single-building properties have one entry with building_name=null)"),
});

// === ANALYZE SCHEMA ===

const LeaseExpirationSchema = z.object({
    tenant_name: z.string().describe("Tenant name"),
    sf: z.number().describe("Square feet expiring"),
    annual_rent: z.number().describe("Annual rent expiring"),
    expiration_date: z.string().describe("Lease expiration date"),
});

export const PropertyAnalysisSchema = z.object({
    property_name: z.string().describe("Property/building name"),
    as_of_date: z.string().describe("Analysis as-of date (YYYY-MM-DD)"),
    total_sf: z.number().describe("Total rentable square feet"),
    occupied_sf: z.number().describe("Occupied square feet"),
    vacant_sf: z.number().describe("Vacant square feet"),
    occupancy_rate: z.number().describe("Occupancy rate as decimal (0.85 = 85%)"),
    tenant_count: z.number().describe("Number of occupied tenants"),
    annual_base_rent: z.number().describe("Total annual base rent (occupied)"),
    avg_rent_psf: z.number().describe("Average rent per SF (occupied)"),
    walt_years: z.number().describe("Weighted average lease term remaining (years), weighted by annual rent"),
    largest_tenant: z.string().describe("Name of largest tenant by rent"),
    largest_tenant_pct: z.number().describe("Largest tenant as % of total rent (0.25 = 25%)"),
    rollover_12mo_sf: z.number().describe("SF expiring in next 12 months from as-of date"),
    rollover_12mo_pct: z.number().describe("SF expiring in 12mo as % of occupied SF (0.15 = 15%)"),
    rollover_24mo_sf: z.number().describe("SF expiring in next 24 months from as-of date"),
    rollover_24mo_pct: z.number().describe("SF expiring in 24mo as % of occupied SF (0.30 = 30%)"),
    near_term_expirations: z.array(LeaseExpirationSchema).describe("Leases expiring within 24 months"),
    risk_flags: z.array(z.string()).describe("Risk factors identified (high vacancy, concentration, rollover)"),
});
