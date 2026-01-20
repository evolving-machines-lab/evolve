/**
 * HN Time Capsule - Evolve Edition
 *
 * Karpathy's 1,486 lines -> ~50 lines
 */

import "dotenv/config";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { Swarm, Pipeline } from "@evolvingmachines/sdk";
import { FETCH, ANALYZE, RENDER } from "./prompts";
import { AnalysisSchema } from "./schema";
import { saveIntermediate } from "./utils";

const swarm = new Swarm({
    tag: "hn-time-capsule",
    concurrency: 10,
    retry: { maxAttempts: 2 },
});

const pipeline = new Pipeline(swarm)
    .map({
        name: "fetch",
        prompt: FETCH,
        agent: { type: "claude", model: "haiku" },
    })
    .map({
        name: "analyze",
        prompt: ANALYZE,
        schema: AnalysisSchema,
        agent: { type: "claude", model: "haiku" },
    })
    .reduce({
        name: "render",
        prompt: RENDER,
    });

async function main() {
    // Clean previous run
    rmSync("intermediate", { recursive: true, force: true });
    rmSync("output", { recursive: true, force: true });

    const date = "2015-12-01";
    const limit = 30;

    const items = Array.from({ length: limit }, (_, i) => ({
        "config.json": JSON.stringify({ rank: i + 1, date }),
    }));

    console.log(`Processing ${items.length} articles from ${date}...`);
    const result = await pipeline.run(items);

    saveIntermediate(result.steps[0].results as any[], "fetch");
    saveIntermediate(result.steps[1].results as any[], "analyze");

    mkdirSync("output", { recursive: true });
    for (const [name, content] of Object.entries(result.output.files)) {
        writeFileSync(`output/${name}`, content as string);
    }
    console.log("Done! Output saved to ./output/");
}

main().catch(console.error);
