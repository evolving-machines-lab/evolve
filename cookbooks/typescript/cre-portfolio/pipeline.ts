/**
 * CRE Portfolio Analysis - Evolve Edition
 *
 * Rent roll PDFs → Extract → Analyze → Portfolio Dashboard
 */

import "dotenv/config";
import { writeFileSync, mkdirSync } from "fs";
import { Swarm, Pipeline } from "@evolvingmachines/sdk";
import {
    EXTRACT_SYSTEM, EXTRACT,
    ANALYZE_SYSTEM, ANALYZE,
    REDUCE_SYSTEM, REDUCE,
} from "./prompts";
import { RentRollExtractSchema, PropertyAnalysisSchema } from "./schema";
import { loadRentRolls, saveIntermediate } from "./utils";

const swarm = new Swarm({
    tag: "cre-portfolio",
    concurrency: 4,
    retry: { maxAttempts: 2 },
});

const pipeline = new Pipeline(swarm)
    .map({
        name: "extract",
        systemPrompt: EXTRACT_SYSTEM,
        prompt: EXTRACT,
        schema: RentRollExtractSchema,
        agent: { type: "claude", model: "haiku" },
    })
    .map({
        name: "analyze",
        systemPrompt: ANALYZE_SYSTEM,
        prompt: ANALYZE,
        schema: PropertyAnalysisSchema,
        agent: { type: "claude", model: "haiku" },
    })
    .reduce({
        name: "portfolio",
        systemPrompt: REDUCE_SYSTEM,
        prompt: REDUCE,
    });

async function main() {
    const pdfDir = process.argv[2] || "./input";

    console.log("Loading rent rolls...");
    const items = loadRentRolls(pdfDir);
    console.log(`Processing ${items.length} properties...\n`);

    const result = await pipeline.run(items);

    // Save intermediate outputs
    saveIntermediate(result.steps[0].results as any[], "extract");
    saveIntermediate(result.steps[1].results as any[], "analyze");

    // Save final output
    mkdirSync("output", { recursive: true });
    for (const [name, content] of Object.entries(result.output.files)) {
        writeFileSync(`output/${name}`, content as string);
    }

    console.log("\nDone! Output saved to ./output/");
}

main().catch(console.error);
