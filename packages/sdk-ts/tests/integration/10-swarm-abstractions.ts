#!/usr/bin/env tsx
/**
 * Integration Test 10: Swarm Abstractions
 *
 * Tests map (with bestOf), filter, and reduce using rent roll PDFs.
 * - map: Extract units from 3 rent rolls using bestOf(2)
 * - filter: AI assesses risk profile → local condition flags high-risk (score >= 7)
 * - reduce: Generate portfolio risk summary from flagged properties
 */

import { Swarm, type FileMap } from "../../dist/index.js";
import { readFileSync } from "fs";
import { createE2BProvider } from "../../../e2b/src/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { z } from "zod";
import { getDefaultAgentConfig, getTestEnv } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

// =============================================================================
// CONFIG
// =============================================================================

// Set TEST_AGENT_TYPE in .env to switch agents (if empty, Evolve resolves from env)
const agentConfig = getDefaultAgentConfig();

const LOGS_DIR = resolve(__dirname, "../test-logs/10-swarm-abstractions");
const FIXTURES_DIR = resolve(__dirname, "../fixtures/test_data");

const env = getTestEnv();

const RISK_THRESHOLD = 7; // Score >= 7 = high risk

// =============================================================================
// SCHEMAS (Zod)
// =============================================================================

const UnitSchema = z.object({
  unitNumber: z.string(),
  tenantName: z.string().nullable(),  // null or "VACANT" if no tenant
  leaseStart: z.string().nullable(),
  leaseEnd: z.string().nullable(),
  squareFootage: z.number().nullable(),
  monthlyRent: z.number().nullable(),
});

const RentRollSchema = z.object({
  propertyName: z.string(),
  units: z.array(UnitSchema),
});

const PortfolioSummarySchema = z.object({
  totalPropertiesAnalyzed: z.number(),
  totalUnits: z.number(),
  totalUnitsExpiring: z.number(),
  totalMonthlyRentAtRisk: z.number(),
  annualizedExposure: z.number(),
  avgRolloverPct: z.number(),
  highestRiskProperty: z.string(),
  priorityActions: z.array(z.string()),
});

const RiskAssessmentSchema = z.object({
  propertyName: z.string(),
  tenantConcentrationRisk: z.enum(["low", "medium", "high"]),
  leaseRolloverRisk: z.enum(["low", "medium", "high"]),
  rentCollectionRisk: z.enum(["low", "medium", "high"]),
  overallRiskScore: z.number().min(1).max(10),
  reasoning: z.string(),
});

type RentRoll = z.infer<typeof RentRollSchema>;
type PortfolioSummary = z.infer<typeof PortfolioSummarySchema>;
type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

// =============================================================================
// PROMPTS
// =============================================================================

const EXTRACT_PROMPT = `
Extract all units from this rent roll PDF.
For each unit: unit number, tenant name, lease start/end dates (YYYY-MM-DD), square footage, monthly rent.
- For vacant units with no tenant, use "VACANT" for tenantName.

IMPORTANT:
You have built-in vision capabilities to see PDF pages as images.
Use the read tool on PDF files directly - they will render visually for you.
Do not install or use external OCR/PDF libraries.
`;

const JUDGE_CRITERIA = `
Select the extraction with:
1. Most complete unit data (fewest nulls)
2. Correct date formats (YYYY-MM-DD)
3. Accurate rent figures
`;

const FILTER_PROMPT = `
You are a CRE risk analyst. Analyze the rent roll data and assess the property's risk profile.

Consider:
- Tenant concentration: Is rent dominated by few tenants?
- Lease rollover: What % of leases expire within 12 months?
- Rent collection: Are there signs of delinquency or below-market rents?

Score overall risk from 1 (minimal) to 10 (severe).
`;

const REDUCE_PROMPT = `
You are a CRE analyst. These properties were flagged as high-risk (risk score >= 7/10).

Analyze all properties in context/ and provide a portfolio-level risk summary:
- Total exposure (units, rent at risk)
- Which property needs most urgent attention
- Priority actions for the asset manager
`;

// =============================================================================
// HELPERS
// =============================================================================

function save(subdir: string, name: string, content: unknown) {
  const dir = resolve(LOGS_DIR, subdir);
  mkdirSync(dir, { recursive: true });
  const data = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  writeFileSync(resolve(dir, name), data);
}

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  console.log("=".repeat(60));
  console.log("Swarm Abstractions Integration Test");
  console.log(`Agent: ${agentConfig ? `${agentConfig.type} (${agentConfig.model})` : "from env"}`);
  console.log("=".repeat(60));

  const swarm = new Swarm({
    agent: agentConfig,
    sandbox: createE2BProvider({
      apiKey: env.E2B_API_KEY,
      defaultTimeoutMs: 30 * 60 * 1000, // 30 min sandbox lifetime
    }),
    tag: "rentroll",
    concurrency: 4,
    timeoutMs: 10 * 60 * 1000, // 10 min per agent
  });

  // -------------------------------------------------------------------------
  // 1. MAP with bestOf(2)
  // -------------------------------------------------------------------------
  console.log("\n[1] map + bestOf(2): Extracting from 3 rent rolls...");

  const inputs: FileMap[] = [
    { "Sample1.pdf": readFileSync(resolve(FIXTURES_DIR, "Sample1.pdf")) },
    { "Sample2.pdf": readFileSync(resolve(FIXTURES_DIR, "Sample2.pdf")) },
    { "Sample3.pdf": readFileSync(resolve(FIXTURES_DIR, "Sample3.pdf")) },
  ];

  const mapResults = await swarm.map<RentRoll>({
    items: inputs,
    prompt: EXTRACT_PROMPT,
    schema: RentRollSchema,
    bestOf: {
      n: 2,
      judgeCriteria: JUDGE_CRITERIA,
      judgeAgent: agentConfig ? { type: agentConfig.type, model: agentConfig.model } : undefined,
    },
    retry: { maxAttempts: 2, backoffMs: 5000 },
  });

  for (const r of mapResults) {
    const idx = r.meta.itemIndex;
    save(`map/item-${idx}`, "winner.json", r.data);
    save(`map/item-${idx}`, "meta.json", r.meta);
    if (r.error) save(`map/item-${idx}`, "error.txt", r.error);
    if (r.rawData) save(`map/item-${idx}`, "rawData.json", r.rawData);
    if (r.bestOf) {
      save(`map/item-${idx}`, "judge.json", {
        winnerIndex: r.bestOf.winnerIndex,
        reasoning: r.bestOf.judgeReasoning,
        judgeMeta: r.bestOf.judgeMeta,
      });
      r.bestOf.candidates.forEach((c, i) => {
        save(`map/item-${idx}/candidate-${i}`, "data.json", c.data);
        save(`map/item-${idx}/candidate-${i}`, "meta.json", c.meta);
        if (c.error) save(`map/item-${idx}/candidate-${i}`, "error.txt", c.error);
        if (c.rawData) save(`map/item-${idx}/candidate-${i}`, "rawData.json", c.rawData);
      });
    }
  }

  console.log(`    Success: ${mapResults.success.length}, Errors: ${mapResults.error.length}`);

  // -------------------------------------------------------------------------
  // 2. FILTER: AI assesses risk → local condition flags high-risk (score >= 7)
  // -------------------------------------------------------------------------
  console.log(`\n[2] filter: AI risk assessment → flagging score >= ${RISK_THRESHOLD}...`);

  const filterResults = await swarm.filter<RiskAssessment>({
    items: mapResults.success,
    prompt: FILTER_PROMPT,
    schema: RiskAssessmentSchema,
    condition: (data) => data.overallRiskScore >= RISK_THRESHOLD,
    agent: agentConfig ? { type: agentConfig.type, model: agentConfig.model } : undefined,
    retry: { maxAttempts: 2, backoffMs: 5000 },
  });

  for (const r of filterResults) {
    const idx = r.meta.itemIndex;
    save(`filter/item-${idx}`, "assessment.json", r.data);
    save(`filter/item-${idx}`, "status.txt", r.status);
    if (r.error) save(`filter/item-${idx}`, "error.txt", r.error);
    if (r.rawData) save(`filter/item-${idx}`, "rawData.json", r.rawData);
    if (r.data) {
      console.log(`    [${idx}] ${r.data.propertyName}: score=${r.data.overallRiskScore} → ${r.status}`);
    }
  }

  console.log(`    High-risk (success): ${filterResults.success.length}`);
  console.log(`    Lower-risk (filtered): ${filterResults.filtered.length}`);
  console.log(`    Errors: ${filterResults.error.length}`);

  // -------------------------------------------------------------------------
  // 3. REDUCE: Portfolio risk summary
  // -------------------------------------------------------------------------
  console.log("\n[3] reduce: Generating portfolio risk summary...");

  if (filterResults.success.length === 0) {
    console.log("    No high-risk properties to reduce. Skipping.");
    save("reduce", "skipped.txt", `No properties exceeded risk threshold (score >= ${RISK_THRESHOLD}).`);
  } else {
    const reduceResult = await swarm.reduce<PortfolioSummary>({
      items: filterResults.success,
      prompt: REDUCE_PROMPT,
      schema: PortfolioSummarySchema,
      retry: { maxAttempts: 2, backoffMs: 5000 },
    });

    save("reduce", "result.json", reduceResult.data);
    save("reduce", "meta.json", reduceResult.meta);
    if (reduceResult.error) save("reduce", "error.txt", reduceResult.error);
    if (reduceResult.rawData) save("reduce", "rawData.json", reduceResult.rawData);

    console.log(`    Status: ${reduceResult.status}`);
    if (reduceResult.data) {
      console.log(`    Properties at risk: ${reduceResult.data.totalPropertiesAnalyzed}`);
      console.log(`    Annualized exposure: $${reduceResult.data.annualizedExposure.toLocaleString()}`);
    }
  }

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log("Test complete. Results saved to test-logs/10-swarm-abstractions/");
  console.log("=".repeat(60));
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
