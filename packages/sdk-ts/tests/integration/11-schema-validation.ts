#!/usr/bin/env tsx
/**
 * Integration Test 11: Schema Validation
 *
 * Tests:
 * - Zod schema validation (existing functionality)
 * - JSON Schema validation (new functionality)
 * - Validation modes: strict, standard, loose
 * - Schema options override
 */

import { z } from "zod";
import { Evolve, VALIDATION_PRESETS } from "../../dist/index.js";
import { createE2BProvider } from "../../../e2b/src/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { getDefaultAgentConfig, getTestEnv } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const LOGS_DIR = resolve(__dirname, "../test-logs/11-schema-validation");
const agentConfig = getDefaultAgentConfig();
const env = getTestEnv();

function log(msg: string) {
  console.log(`[11-schema-validation] ${msg}`);
}

function save(name: string, content: string | Uint8Array) {
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(resolve(LOGS_DIR, name), content);
}

// Define test schemas
const ZodResultSchema = z.object({
  name: z.string(),
  count: z.number(),
  success: z.boolean(),
});

const JsonResultSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    count: { type: "number" },
    success: { type: "boolean" },
  },
  required: ["name", "count", "success"],
};

async function main() {
  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  log("Starting schema validation tests...");
  log(`Using agent: ${agentConfig.type} (${agentConfig.model})`);
  const start = Date.now();

  const e2bProvider = createE2BProvider({ apiKey: env.E2B_API_KEY });

  try {
    // =========================================================================
    // Test 1: Zod Schema Validation
    // =========================================================================
    log("\n--- Test 1: Zod Schema Validation ---");

    const zodKit = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(e2bProvider)
      .withSchema(ZodResultSchema);

    log("Running agent with Zod schema...");
    const zodRun = await zodKit.run({
      prompt: `Create a JSON file at output/result.json with exactly this structure:
{
  "name": "test-item",
  "count": 42,
  "success": true
}
Make sure the file is valid JSON.`,
      timeoutMs: 180000,
    });
    log(`  Agent run completed: exit=${zodRun.exitCode}`);
    save("test1-zod-stdout.txt", zodRun.stdout);

    const zodOutput = await zodKit.getOutputFiles<z.infer<typeof ZodResultSchema>>();
    log(`  Files retrieved: ${Object.keys(zodOutput.files).join(", ") || "(none)"}`);

    if (zodOutput.error) {
      log(`  ERROR: ${zodOutput.error}`);
      if (zodOutput.rawData) {
        save("test1-zod-rawdata.txt", zodOutput.rawData);
        log(`  Raw data saved to test1-zod-rawdata.txt`);
      }
      throw new Error(`Zod validation failed: ${zodOutput.error}`);
    }

    if (!zodOutput.data) {
      throw new Error("Zod validation returned null data without error");
    }

    log(`  Validated data: ${JSON.stringify(zodOutput.data)}`);
    log(`  ✓ Zod schema validation passed`);

    await zodKit.kill();

    // =========================================================================
    // Test 2: JSON Schema Validation (standard mode)
    // =========================================================================
    log("\n--- Test 2: JSON Schema Validation (standard mode) ---");

    const jsonKit = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(e2bProvider)
      .withSchema(JsonResultSchema, { mode: "standard" });

    log("Running agent with JSON Schema...");
    const jsonRun = await jsonKit.run({
      prompt: `Create a JSON file at output/result.json with exactly this structure:
{
  "name": "json-test",
  "count": 100,
  "success": true
}
Make sure the file is valid JSON.`,
      timeoutMs: 180000,
    });
    log(`  Agent run completed: exit=${jsonRun.exitCode}`);
    save("test2-json-stdout.txt", jsonRun.stdout);

    interface JsonResult {
      name: string;
      count: number;
      success: boolean;
    }

    const jsonOutput = await jsonKit.getOutputFiles<JsonResult>();
    log(`  Files retrieved: ${Object.keys(jsonOutput.files).join(", ") || "(none)"}`);

    if (jsonOutput.error) {
      log(`  ERROR: ${jsonOutput.error}`);
      if (jsonOutput.rawData) {
        save("test2-json-rawdata.txt", jsonOutput.rawData);
        log(`  Raw data saved to test2-json-rawdata.txt`);
      }
      throw new Error(`JSON Schema validation failed: ${jsonOutput.error}`);
    }

    if (!jsonOutput.data) {
      throw new Error("JSON Schema validation returned null data without error");
    }

    log(`  Validated data: ${JSON.stringify(jsonOutput.data)}`);
    log(`  ✓ JSON Schema validation (standard mode) passed`);

    await jsonKit.kill();

    // =========================================================================
    // Test 3: JSON Schema with loose mode (type coercion)
    // =========================================================================
    log("\n--- Test 3: JSON Schema with loose mode (type coercion) ---");

    const looseKit = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(e2bProvider)
      .withSchema(JsonResultSchema, { mode: "loose" });

    log("Running agent (will produce string numbers that need coercion)...");
    const looseRun = await looseKit.run({
      prompt: `Create a JSON file at output/result.json with this structure:
{
  "name": "loose-test",
  "count": "50",
  "success": true,
  "extraField": "should be removed"
}
Note: count is intentionally a string "50" not a number.
Make sure the file is valid JSON.`,
      timeoutMs: 180000,
    });
    log(`  Agent run completed: exit=${looseRun.exitCode}`);
    save("test3-loose-stdout.txt", looseRun.stdout);

    const looseOutput = await looseKit.getOutputFiles<JsonResult>();
    log(`  Files retrieved: ${Object.keys(looseOutput.files).join(", ") || "(none)"}`);

    if (looseOutput.error) {
      log(`  ERROR: ${looseOutput.error}`);
      if (looseOutput.rawData) {
        save("test3-loose-rawdata.txt", looseOutput.rawData);
        log(`  Raw data saved to test3-loose-rawdata.txt`);
      }
      // Loose mode should coerce "50" to 50, so this shouldn't fail
      throw new Error(`Loose mode validation failed: ${looseOutput.error}`);
    }

    if (!looseOutput.data) {
      throw new Error("Loose mode validation returned null data without error");
    }

    log(`  Validated data: ${JSON.stringify(looseOutput.data)}`);

    // Verify coercion happened
    if (typeof looseOutput.data.count !== "number") {
      throw new Error(`Loose mode should coerce string to number, got ${typeof looseOutput.data.count}`);
    }
    log(`  ✓ Type coercion worked: "50" → ${looseOutput.data.count} (number)`);

    // Verify extra field was removed (if removeAdditional worked)
    if ("extraField" in looseOutput.data) {
      log(`  Note: extraField was not removed (Ajv removeAdditional may need additionalProperties: false in schema)`);
    } else {
      log(`  ✓ Extra field removed`);
    }

    log(`  ✓ JSON Schema loose mode passed`);

    await looseKit.kill();

    // =========================================================================
    // Test 4: Validation presets are correctly defined
    // =========================================================================
    log("\n--- Test 4: Validation presets check ---");

    log(`  VALIDATION_PRESETS.strict: ${JSON.stringify(VALIDATION_PRESETS.strict)}`);
    log(`  VALIDATION_PRESETS.standard: ${JSON.stringify(VALIDATION_PRESETS.standard)}`);
    log(`  VALIDATION_PRESETS.loose: ${JSON.stringify(VALIDATION_PRESETS.loose)}`);

    // Verify preset values
    if (VALIDATION_PRESETS.strict.coerceTypes !== false) {
      throw new Error("strict preset should have coerceTypes: false");
    }
    if (VALIDATION_PRESETS.loose.coerceTypes !== true) {
      throw new Error("loose preset should have coerceTypes: true");
    }
    if (VALIDATION_PRESETS.standard.useDefaults !== true) {
      throw new Error("standard preset should have useDefaults: true");
    }

    log(`  ✓ Validation presets are correctly defined`);

    // =========================================================================
    // Test 5: No schema - should return files without validation
    // =========================================================================
    log("\n--- Test 5: No schema (files only) ---");

    const noSchemaKit = new Evolve()
      .withAgent(agentConfig)
      .withSandbox(e2bProvider);
    // No .withSchema() call

    log("Running agent without schema...");
    const noSchemaRun = await noSchemaKit.run({
      prompt: `Create output/result.json with any JSON content you want, like {"message": "hello"}.`,
      timeoutMs: 180000,
    });
    log(`  Agent run completed: exit=${noSchemaRun.exitCode}`);

    const noSchemaOutput = await noSchemaKit.getOutputFiles();
    log(`  Files retrieved: ${Object.keys(noSchemaOutput.files).join(", ") || "(none)"}`);
    log(`  data: ${noSchemaOutput.data}`);
    log(`  error: ${noSchemaOutput.error || "(none)"}`);

    if (noSchemaOutput.data !== null) {
      throw new Error("Without schema, data should be null");
    }
    if (noSchemaOutput.error) {
      throw new Error(`Without schema, there should be no error: ${noSchemaOutput.error}`);
    }

    log(`  ✓ No schema mode works correctly`);

    await noSchemaKit.kill();

    // =========================================================================
    // Summary
    // =========================================================================
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`PASS - All schema validation tests passed (${duration}s)`);
    log(`============================================================\n`);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    save("error.txt", err instanceof Error ? err.stack || msg : msg);

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`FAIL - ${msg} (${duration}s)`);
    log(`============================================================\n`);
    process.exit(1);
  }
}

main();
