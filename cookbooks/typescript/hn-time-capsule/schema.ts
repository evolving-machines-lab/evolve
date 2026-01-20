/**
 * Structured output schema for HN Time Capsule analysis.
 */

import { z } from "zod";

const AwardSchema = z.object({
    user: z.string().describe("HN username"),
    reason: z.string().describe("Why they were right/wrong in hindsight"),
});

const GradeSchema = z.object({
    grade: z.string().describe("Letter grade (A+ to F)"),
    rationale: z.string().describe("Brief explanation for the grade"),
});

export const AnalysisSchema = z.object({
    title: z.string().describe("Article title"),
    summary: z.string().describe("Brief summary of article and discussion"),
    what_happened: z.string().describe("What actually happened to this topic/company/technology"),
    most_prescient: AwardSchema.describe("Commenter who best predicted the future"),
    most_wrong: AwardSchema.describe("Commenter who was most wrong"),
    notable_aspects: z.string().describe("Other fun or notable aspects of the article or discussion"),
    grades: z.record(GradeSchema).describe("HN username → grade with rationale"),
    score: z.number().describe("0-10 how interesting this retrospective is"),
});
