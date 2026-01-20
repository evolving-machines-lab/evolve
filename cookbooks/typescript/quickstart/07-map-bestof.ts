/**
 * 07 - Map + BestOf
 * Parallel processing with N candidates per item, judge picks best.
 */
import "dotenv/config";
import { Swarm } from "@evolvingmachines/sdk";
import { z } from "zod";

const swarm = new Swarm();

const AnalysisSchema = z.object({
    sentiment: z.enum(["positive", "neutral", "negative"]),
    confidence: z.number(),
    reasoning: z.string(),
});

const reviews = [
    { "review.txt": "This product exceeded my expectations! Fast shipping and great quality." },
    { "review.txt": "Okay product, nothing special. Arrived on time but packaging was damaged." },
    { "review.txt": "Terrible experience. Product broke after 2 days, no response from support." },
];

const results = await swarm.map({
    items: reviews,
    prompt: `
        Analyze the sentiment of this customer review.
        Provide sentiment, confidence score (0-1), and reasoning.
    `,
    schema: AnalysisSchema,
    // Run N candidates per item, judge picks best result
    bestOf: {
        n: 3,
        judgeCriteria: "Most accurate sentiment classification with well-reasoned explanation",
    },
    // Auto-retry on error
    retry: {
        maxAttempts: 2,
    },
});

// Each result contains the winning candidate
for (const r of results.success) {
    console.log(r.data?.sentiment, `(${r.data?.confidence})`, "-", r.bestOf?.judgeReasoning);
}
