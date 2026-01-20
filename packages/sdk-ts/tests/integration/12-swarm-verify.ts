#!/usr/bin/env tsx
/**
 * Integration Test 12: Swarm Verify
 *
 * Tests map with verify option using rent roll PDFs.
 * - map + verify: Extract units from 3 rent rolls with quality verification
 * - Verifier checks extraction quality and retries with feedback if needed
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

const agentConfig = getDefaultAgentConfig();

const LOGS_DIR = resolve(__dirname, "../test-logs/12-swarm-verify");
const FIXTURES_DIR = resolve(__dirname, "../fixtures/test_data");

const env = getTestEnv();

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

type RentRoll = z.infer<typeof RentRollSchema>;

// =============================================================================
// PROMPTS
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
Check for any data extraction inaccuracies. 
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
  console.log("Swarm Verify Integration Test");
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
  });

  // -------------------------------------------------------------------------
  // MAP with verify
  // -------------------------------------------------------------------------
  console.log("\n[1] map + verify: Extracting from 3 rent rolls with verification...");

  const inputs: FileMap[] = [
    { "Sample1.pdf": readFileSync(resolve(FIXTURES_DIR, "Sample1.pdf")) },
    { "Sample2.pdf": readFileSync(resolve(FIXTURES_DIR, "Sample2.pdf")) },
    { "Sample3.pdf": readFileSync(resolve(FIXTURES_DIR, "Sample3.pdf")) },
  ];

  const mapResults = await swarm.map<RentRoll>({
    items: inputs,
    prompt: EXTRACT_PROMPT,
    systemPrompt: SYSTEM_PROMPT,
    schema: RentRollSchema,
    verify: {
      criteria: VERIFY_CRITERIA,
      maxAttempts: 2,
      verifierAgent: agentConfig ? { type: agentConfig.type, model: agentConfig.model } : undefined,
    },
    retry: { maxAttempts: 2, backoffMs: 1000 },
  });

  for (const r of mapResults) {
    const idx = r.meta.itemIndex;
    save(`map/item-${idx}`, "result.json", r.data);
    save(`map/item-${idx}`, "meta.json", r.meta);
    save(`map/item-${idx}`, "status.txt", r.status);
    if (r.error) save(`map/item-${idx}`, "error.txt", r.error);
    if (r.rawData) save(`map/item-${idx}`, "rawData.json", r.rawData);

    // Save verify info
    if (r.verify) {
      save(`map/item-${idx}`, "verify.json", {
        passed: r.verify.passed,
        reasoning: r.verify.reasoning,
        attempts: r.verify.attempts,
        verifyMeta: r.verify.verifyMeta,
      });
      console.log(`    [${idx}] ${r.data?.propertyName || "unknown"}: verify=${r.verify.passed ? "PASS" : "FAIL"} (${r.verify.attempts} attempt(s))`);
    } else {
      console.log(`    [${idx}] ${r.data?.propertyName || "unknown"}: no verify info`);
    }
  }

  console.log(`\n    Success: ${mapResults.success.length}, Errors: ${mapResults.error.length}`);

  // -------------------------------------------------------------------------
  // SUMMARY
  // -------------------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log("Test complete. Results saved to test-logs/12-swarm-verify/");
  console.log("=".repeat(60));
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
