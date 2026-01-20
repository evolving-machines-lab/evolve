/**
 * 08 - Pipeline: Map → Filter → Reduce
 * Fluent API for multi-step workflows.
 */
import "dotenv/config";
import { Swarm, Pipeline } from "@evolvingmachines/sdk";
import { z } from "zod";

const swarm = new Swarm();

const AnalysisSchema = z.object({
    summary: z.string(),
    riskLevel: z.enum(["critical", "high", "medium", "low"]),
    issues: z.array(z.string()),
});

const FilterSchema = z.object({
    isCritical: z.boolean(),
    justification: z.string(),
});

const ReportSchema = z.object({
    executiveSummary: z.string(),
    criticalFindings: z.array(z.string()),
    recommendations: z.array(z.string()),
});

// Pipeline chains operations with fluent API
const pipeline = new Pipeline(swarm)
    // Step 1: Analyze each item in parallel
    .map({
        name: "analyze",
        prompt: `
            Analyze this security report.
            Assess the risk level and list all issues found.
        `,
        schema: AnalysisSchema,
    })
    // Step 2: Filter to critical items only
    .filter({
        name: "critical-only",
        prompt: "Determine if this finding requires immediate attention",
        schema: FilterSchema,
        condition: (d) => d.isCritical,
    })
    // Step 3: Synthesize into single report
    .reduce({
        name: "synthesize",
        prompt: `
            Create an executive security report.
            Summarize all critical findings and provide recommendations.
        `,
        schema: ReportSchema,
    });

const securityReports = [
    { "report.txt": "SQL injection vulnerability found in login endpoint..." },
    { "report.txt": "Minor CSS styling issue on mobile devices..." },
    { "report.txt": "Authentication bypass possible via API token reuse..." },
    { "report.txt": "Outdated library version with known CVE..." },
];

// Pipeline is reusable - run with different data
const result = await pipeline.run(securityReports);

// Pipeline ending with reduce() returns ReduceResult (not array)
if (!Array.isArray(result.output)) {
    console.log("Executive Summary:", result.output.data?.executiveSummary);
    console.log("Critical Findings:", result.output.data?.criticalFindings);
}
