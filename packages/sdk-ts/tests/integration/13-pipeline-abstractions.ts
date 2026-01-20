#!/usr/bin/env tsx
/**
 * Integration Test 13: Pipeline Abstractions
 *
 * Replicates test 10 using Pipeline instead of Swarm directly.
 * Uses prompts from test 12. Demonstrates all 8 pipeline events.
 * Uses Swarm-level retry defaults (inherited by all operations).
 *
 * - map: Extract units from 3 rent rolls with verify (2 max attempts)
 * - filter: AI assesses risk profile → local condition flags high-risk (score >= 7)
 * - reduce: Generate portfolio risk summary from flagged properties
 *
 * Events logged: stepStart, stepComplete, stepError, itemRetry,
 *                workerComplete, verifierComplete, candidateComplete, judgeComplete
 */

import { Swarm, Pipeline, type FileMap } from "../../dist/index.js";
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

const agentConfig = getDefaultAgentConfig();

const LOGS_DIR = resolve(__dirname, "../test-logs/13-pipeline-abstractions");
const FIXTURES_DIR = resolve(__dirname, "../fixtures/test_data");

const env = getTestEnv();

const RISK_THRESHOLD = 7; // Score >= 7 = high risk

// =============================================================================
// SCHEMAS (Zod)
// =============================================================================

const UnitSchema = z.object({
  unitNumber: z.string(),
  tenantName: z.string().nullable(),
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
// PROMPTS (from test 12)
// =============================================================================

const SYSTEM_PROMPT = `You are a precise data extraction agent specialized in real estate documents.
Your task is to extract structured data from CRE rent roll PDFs with high accuracy.
- Read PDF files directly using your built-in vision capabilities
- Do not install or use external OCR/PDF libraries
- Be thorough: extract ALL units, do not skip any rows
- Be precise: dates must be YYYY-MM-DD format, numbers must be accurate
- For each unit: unit number, tenant name, lease start/end dates (YYYY-MM-DD), square footage, monthly rent.
- For vacant units with no tenant, use "VACANT" for tenantName.`;

const EXTRACT_PROMPT = `Extract all units from the rent roll PDF in context/`;

const VERIFY_CRITERIA = `
Check the extraction for accuracy:
1. All units from the PDF are extracted (no missing rows)
2. Dates are in YYYY-MM-DD format
3. Rent and square footage values are numeric and reasonable
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
  console.log("Pipeline Abstractions Integration Test");
  console.log(`Agent: ${agentConfig ? `${agentConfig.type} (${agentConfig.model})` : "from env"}`);
  console.log("=".repeat(60));

  const swarm = new Swarm({
    agent: agentConfig,
    sandbox: createE2BProvider({
      apiKey: env.E2B_API_KEY,
      defaultTimeoutMs: 30 * 60 * 1000,
    }),
    tag: "rentroll",
    concurrency: 4,
    timeoutMs: 10 * 60 * 1000,
    retry: { maxAttempts: 2, backoffMs: 5000 },
  });

  // -------------------------------------------------------------------------
  // INPUTS
  // -------------------------------------------------------------------------
  const inputs: FileMap[] = [
    { "Sample1.pdf": readFileSync(resolve(FIXTURES_DIR, "Sample1.pdf")) },
    { "Sample2.pdf": readFileSync(resolve(FIXTURES_DIR, "Sample2.pdf")) },
    { "Sample3.pdf": readFileSync(resolve(FIXTURES_DIR, "Sample3.pdf")) },
  ];

  // -------------------------------------------------------------------------
  // PIPELINE: map → filter → reduce
  // -------------------------------------------------------------------------
  console.log("\n[Pipeline] Running map → filter → reduce...");

  const result = await new Pipeline(swarm)
    // Step 0: Extract with verify (2 max attempts)
    .map<RentRoll>({
      name: "extract",
      prompt: EXTRACT_PROMPT,
      systemPrompt: SYSTEM_PROMPT,
      schema: RentRollSchema,
      verify: {
        criteria: VERIFY_CRITERIA,
        maxAttempts: 2,
        verifierAgent: agentConfig ? { type: agentConfig.type, model: agentConfig.model } : undefined,
      },
      // retry inherited from Swarm config
    })
    // Step 1: Risk assessment filter
    .filter<RiskAssessment>({
      name: "risk-filter",
      prompt: FILTER_PROMPT,
      schema: RiskAssessmentSchema,
      condition: (data) => data.overallRiskScore >= RISK_THRESHOLD,
      agent: agentConfig ? { type: agentConfig.type, model: agentConfig.model } : undefined,
      // retry inherited from Swarm config
    })
    // Step 2: Portfolio summary
    .reduce<PortfolioSummary>({
      name: "portfolio-summary",
      prompt: REDUCE_PROMPT,
      schema: PortfolioSummarySchema,
      // retry inherited from Swarm config
    })
    // Event handlers (chainable style) - all 8 events
    .on("stepStart", (e) => {
      console.log(`\n  [Step ${e.index}: ${e.name}] Started with ${e.itemCount} items`);
    })
    .on("stepComplete", (e) => {
      console.log(`  [Step ${e.index}: ${e.name}] Completed in ${e.durationMs}ms`);
      console.log(`    Success: ${e.successCount}, Errors: ${e.errorCount}, Filtered: ${e.filteredCount}`);
    })
    .on("stepError", (e) => {
      console.error(`  [Step ${e.index}: ${e.name}] Error: ${e.error.message}`);
    })
    .on("itemRetry", (e) => {
      console.log(`    [${e.stepName}] Item ${e.itemIndex} retry #${e.attempt}: ${e.error}`);
    })
    .on("workerComplete", (e) => {
      console.log(`    [${e.stepName}] Item ${e.itemIndex} worker attempt ${e.attempt}: ${e.status}`);
    })
    .on("verifierComplete", (e) => {
      console.log(`    [${e.stepName}] Item ${e.itemIndex} verifier attempt ${e.attempt}: ${e.passed ? "PASS" : "FAIL"}${e.feedback ? ` - ${e.feedback}` : ""}`);
    })
    .on("candidateComplete", (e) => {
      console.log(`    [${e.stepName}] Item ${e.itemIndex} candidate ${e.candidateIndex}: ${e.status}`);
    })
    .on("judgeComplete", (e) => {
      console.log(`    [${e.stepName}] Item ${e.itemIndex} judge picked #${e.winnerIndex}`);
    })
    .run(inputs);

  // -------------------------------------------------------------------------
  // SAVE RESULTS
  // -------------------------------------------------------------------------
  save("pipeline", "result.json", {
    pipelineRunId: result.pipelineRunId,
    totalDurationMs: result.totalDurationMs,
    stepsCount: result.steps.length,
  });

  // Save each step's results
  for (const step of result.steps) {
    const stepDir = `pipeline/step-${step.index}`;
    save(stepDir, "meta.json", {
      type: step.type,
      index: step.index,
      durationMs: step.durationMs,
    });

    if (step.type === "reduce") {
      // reduce returns ReduceResult
      const reduceResult = step.results as { status: string; data: unknown; error?: string };
      save(stepDir, "result.json", reduceResult.data);
      if (reduceResult.error) save(stepDir, "error.txt", reduceResult.error);
    } else {
      // map/filter return SwarmResult[]
      const results = step.results as Array<{ status: string; data: unknown; meta: unknown; error?: string; verify?: unknown; bestOf?: unknown }>;
      for (const r of results) {
        const itemDir = `${stepDir}/item-${(r.meta as { itemIndex: number }).itemIndex}`;
        save(itemDir, "data.json", r.data);
        save(itemDir, "status.txt", r.status);
        if (r.error) save(itemDir, "error.txt", r.error);
        if (r.verify) save(itemDir, "verify.json", r.verify);
        if (r.bestOf) save(itemDir, "bestOf.json", r.bestOf);
      }
    }
  }

  // Save final output
  if ("status" in result.output) {
    // ReduceResult
    const reduceOutput = result.output as { status: string; data: PortfolioSummary | null; error?: string };
    save("output", "final.json", reduceOutput.data);
    if (reduceOutput.error) save("output", "error.txt", reduceOutput.error);

    console.log(`\n[Result] Status: ${reduceOutput.status}`);
    if (reduceOutput.data) {
      console.log(`  Properties at risk: ${reduceOutput.data.totalPropertiesAnalyzed}`);
      console.log(`  Annualized exposure: $${reduceOutput.data.annualizedExposure.toLocaleString()}`);
    }
  }

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log(`Pipeline completed in ${result.totalDurationMs}ms (pipelineRunId: ${result.pipelineRunId})`);
  console.log("Results saved to test-logs/13-pipeline-abstractions/");
  console.log("=".repeat(60));
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
