#!/usr/bin/env tsx
/**
 * Swarm Abstractions Example
 *
 * Clean SDK usage: map → filter → reduce pipeline for rent roll analysis.
 */

import { Swarm } from "../../dist/index.js";
import { createE2BProvider } from "../../../e2b/src/index.js";
import { readFileSync } from "fs";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { z } from "zod";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

// =============================================================================
// SCHEMAS
// =============================================================================

const RentRollSchema = z.object({
  propertyName: z.string(),
  units: z.array(z.object({
    unitNumber: z.string(),
    tenantName: z.string(),
    leaseStart: z.string().nullable(),
    leaseEnd: z.string().nullable(),
    monthlyRent: z.number(),
  })),
});

const RiskAssessmentSchema = z.object({
  propertyName: z.string(),
  overallRiskScore: z.number().min(1).max(10),
  reasoning: z.string(),
});

const PortfolioSummarySchema = z.object({
  totalUnits: z.number(),
  annualizedExposure: z.number(),
  priorityActions: z.array(z.string()),
});

// =============================================================================
// MAIN
// =============================================================================

async function main() {

  // 0. Create a new swarm instance
  const swarm = new Swarm({
    agent: { type: "claude", apiKey: process.env.ANTHROPIC_API_KEY! },
    sandbox: createE2BProvider({ apiKey: process.env.E2B_API_KEY! }),
  });

  const fixturesDir = resolve(__dirname, "../fixtures/test_data");

  // 1. Map: Extract from PDFs (with bestOf)
  const extractions = await swarm.map({
    items: [
      { "rent-roll.pdf": readFileSync(resolve(fixturesDir, "Sample1.pdf")) },
      { "rent-roll.pdf": readFileSync(resolve(fixturesDir, "Sample2.pdf")) },
      { "rent-roll.pdf": readFileSync(resolve(fixturesDir, "Sample3.pdf")) },
    ],
    prompt: "Extract all units from this rent roll PDF.",
    schema: RentRollSchema,
    bestOf: { n: 2, judgeCriteria: "Most complete extraction with fewest nulls" },
  });

  console.log(`Extracted: ${extractions.success.length} success, ${extractions.error.length} errors`);

  // 2. Filter: Flag high-risk properties
  const highRisk = await swarm.filter({
    items: extractions.success,
    prompt: "Assess risk profile based on tenant concentration and lease rollover. Score 1-10.",
    schema: RiskAssessmentSchema,
    condition: (r) => r.overallRiskScore >= 7,
  });

  console.log(`High-risk: ${highRisk.success.length}, Lower-risk: ${highRisk.filtered.length}`);

  // 3. Reduce: Synthesize portfolio summary
  if (highRisk.success.length > 0) {
    const summary = await swarm.reduce({
      items: highRisk.success,
      prompt: "Generate portfolio risk summary with priority actions.",
      schema: PortfolioSummarySchema,
    });

    console.log("Summary:", summary.data);
  } else {
    console.log("No high-risk properties to summarize.");
  }
}

main().catch(console.error);
