/**
 * 06 - Map + Retry + Verify
 * Parallel processing with LLM-as-judge verification.
 */
import "dotenv/config";
import { Swarm } from "@evolvingmachines/sdk";
import { z } from "zod";

// Swarm processes multiple items in parallel sandboxes
const swarm = new Swarm();

const SummarySchema = z.object({
    title: z.string(),
    keyPoints: z.array(z.string()),
    wordCount: z.number(),
});

const documents = [
    { "doc.txt": "Q1 2024: Revenue increased 15% YoY driven by new product launches..." },
    { "doc.txt": "Q2 2024: Operational costs reduced by 8% through automation..." },
    { "doc.txt": "Q3 2024: Market expansion into APAC region exceeded targets..." },
];

const results = await swarm.map({
    items: documents,
    prompt: `
        Summarize this quarterly report.
        Include a title, key points, and word count.
    `,
    schema: SummarySchema,
    // LLM judge verifies output, retries with feedback if failed
    verify: {
        criteria: "Summary must include at least 3 key points and accurate word count",
        maxAttempts: 2,
    },
    // Auto-retry on error with exponential backoff
    retry: {
        maxAttempts: 3,
        backoffMs: 1000,
    },
});

// Access successful results
for (const r of results.success) {
    console.log(r.data?.title, "-", r.data?.keyPoints.length, "key points");
}
