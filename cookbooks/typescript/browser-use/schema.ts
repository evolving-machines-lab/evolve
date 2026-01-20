/**
 * Schema for browser-use cookbook.
 */

import { z } from "zod";

export const HNPostResultSchema = z.object({
    rank: z.number(),
    page: z.number(),
    position_on_page: z.number(),

    title: z.string().nullable().optional(),
    hn_item_id: z.string().nullable().optional(),
    hn_item_url: z.string().nullable().optional(),
    outbound_url: z.string().nullable().optional(),
    final_url: z.string().nullable().optional(),

    points: z.number().nullable().optional(),
    comments: z.number().nullable().optional(),

    summary: z.string(),
    screenshots: z.array(z.string()).default([]),
    actions: z.array(z.string()).default([]),
    error: z.string().nullable().optional(),
});

export type HNPostResult = z.infer<typeof HNPostResultSchema>;
