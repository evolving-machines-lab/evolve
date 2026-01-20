/**
 * Schema Utilities
 *
 * Functions for working with Zod and JSON Schema.
 */

import type { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";

/**
 * Check if a schema is a Zod schema (has safeParse method)
 */
export function isZodSchema(schema: unknown): schema is z.ZodType<unknown> {
  return (
    schema !== null &&
    typeof schema === "object" &&
    "safeParse" in schema &&
    typeof (schema as { safeParse: unknown }).safeParse === "function"
  );
}

/**
 * Convert Zod schema to JSON Schema string
 */
export function zodSchemaToJson(schema: z.ZodType<unknown>): string {
  return JSON.stringify(
    zodToJsonSchema(schema, { target: "jsonSchema7" }),
    null,
    2
  );
}

/**
 * Convert JSON Schema object to formatted string
 */
export function jsonSchemaToString(schema: Record<string, unknown>): string {
  return JSON.stringify(schema, null, 2);
}
