/**
 * Prompt Templates
 *
 * Prompts are stored as markdown files for easy editing.
 * They are inlined at build time via tsup's text loader.
 */

import type { z } from "zod";
import { isZodSchema, zodSchemaToJson, jsonSchemaToString } from "../utils";

// Imported as string at build time (see tsup.config.ts loader)
// Agent prompts (system prompts - goes into CLAUDE.md-like context)
import WORKSPACE_MD from "./agent_md/workspace-knowledge.md";
import WORKSPACE_SWE_MD from "./agent_md/workspace-swe.md";
import BASE_MD from "./agent_md/base.md";
import SCHEMA_MD from "./agent_md/schema.md";
import JUDGE_AGENT_MD from "./agent_md/judge.md";
import VERIFY_AGENT_MD from "./agent_md/verify.md";
import REDUCE_AGENT_MD from "./agent_md/reduce.md";

// User prompts (task prompts - passed to .run())
import JUDGE_USER_MD from "./user/judge.md";
import VERIFY_USER_MD from "./user/verify.md";
import RETRY_FEEDBACK_MD from "./user/retry-feedback.md";

/**
 * Workspace system prompt template (knowledge mode)
 *
 * Placeholders:
 * - {{workingDir}} - The working directory path
 */
export const WORKSPACE_PROMPT: string = WORKSPACE_MD;

/**
 * Workspace system prompt template (SWE mode - includes repo/ folder)
 *
 * Placeholders:
 * - {{workingDir}} - The working directory path
 */
export const WORKSPACE_SWE_PROMPT: string = WORKSPACE_SWE_MD;

/**
 * User system prompt wrapper template
 *
 * Placeholders:
 * - {{systemPrompt}} - The user's system prompt content
 */
export const SYSTEM_PROMPT: string = BASE_MD;

/**
 * Structured output schema prompt template (for Swarm abstractions)
 *
 * Placeholders:
 * - {{schema}} - JSON schema for the expected output
 */
export const SCHEMA_PROMPT: string = SCHEMA_MD;

/**
 * Judge system prompt template (for Swarm best_of)
 *
 * Placeholders:
 * - {{candidateCount}} - Number of candidates
 * - {{criteria}} - Evaluation criteria
 * - {{fileTree}} - Tree view of context folders
 */
export const JUDGE_PROMPT: string = JUDGE_AGENT_MD;

/**
 * Judge user prompt (for Swarm best_of)
 */
export const JUDGE_USER_PROMPT: string = JUDGE_USER_MD;

/**
 * Verify system prompt template (for Swarm verify option)
 *
 * Placeholders:
 * - {{criteria}} - Verification criteria
 * - {{fileTree}} - Tree view of context folders
 */
export const VERIFY_PROMPT: string = VERIFY_AGENT_MD;

/**
 * Verify user prompt (for Swarm verify option)
 */
export const VERIFY_USER_PROMPT: string = VERIFY_USER_MD;

/**
 * Reduce context prompt template (for Swarm reduce)
 *
 * Explains the context structure to the reduce agent.
 *
 * Placeholders:
 * - {{fileTree}} - Tree view of item folders
 */
export const REDUCE_PROMPT: string = REDUCE_AGENT_MD;

/**
 * Retry feedback prompt template (for Swarm verify retry)
 *
 * Replaces the user prompt when verification fails and retry is needed.
 *
 * Placeholders:
 * - {{originalPrompt}} - The original user prompt
 * - {{feedback}} - Verifier's feedback on what needs to be fixed
 */
export const RETRY_FEEDBACK_PROMPT: string = RETRY_FEEDBACK_MD;

/**
 * Apply template variables to a prompt
 */
export function applyTemplate(
  template: string,
  variables: Record<string, string>
): string {
  let result = template;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), value);
  }
  return result;
}

/**
 * Build worker system prompt
 *
 * Used by Agent class to generate the system prompt file written to sandbox.
 *
 * @param mode - "knowledge" (default) or "swe" (includes repo/ folder)
 */
export function buildWorkerSystemPrompt(options: {
  workingDir: string;
  systemPrompt?: string;
  schema?: z.ZodType<unknown> | Record<string, unknown>;
  mode?: "knowledge" | "swe";
}): string {
  // Pick workspace template based on mode
  const workspaceTemplate = options.mode === "swe" ? WORKSPACE_SWE_PROMPT : WORKSPACE_PROMPT;
  let fullPrompt = applyTemplate(workspaceTemplate, { workingDir: options.workingDir }).trim();

  // Add custom system prompt if provided
  if (options.systemPrompt) {
    fullPrompt += `\n\n\n${applyTemplate(SYSTEM_PROMPT, { systemPrompt: options.systemPrompt }).trim()}`;
  }

  // Add schema prompt if provided (auto-detect Zod vs JSON Schema)
  if (options.schema) {
    const schemaStr = isZodSchema(options.schema)
      ? zodSchemaToJson(options.schema)
      : jsonSchemaToString(options.schema);
    fullPrompt += `\n\n\n${applyTemplate(SCHEMA_PROMPT, { schema: schemaStr }).trim()}`;
  }

  return fullPrompt;
}

/**
 * Build ASCII file tree for judge/verify context
 *
 * Generates a formatted tree representation with comments explaining each section.
 * Used by Swarm bestOf and verify to show the evaluator what files are available.
 */
export function buildFileTree(files: Record<string, string | Buffer | ArrayBuffer | Uint8Array>): string {
  const folders = [...new Set(Object.keys(files).map((p) => p.split("/")[0]))]
    .sort((a, b) => (a === "worker_task" ? -1 : b === "worker_task" ? 1 : a.localeCompare(b)));
  if (!folders.length) return "context/\n  (empty)";

  // Check what exists in worker_task/
  const hasSystemPrompt = "worker_task/system_prompt.txt" in files;
  const hasSchema = "worker_task/schema.json" in files;
  const hasInput = Object.keys(files).some((p) => p.startsWith("worker_task/input/"));

  // Build all entries first to calculate max width for alignment
  type Entry = { line: string; comment: string };
  const entries: Entry[] = [];

  folders.forEach((folder, i) => {
    const isLastFolder = i === folders.length - 1;
    const folderPrefix = isLastFolder ? "└── " : "├── ";
    const childIndent = isLastFolder ? "    " : "│   ";

    if (folder === "worker_task") {
      entries.push({ line: `${folderPrefix}${folder}/`, comment: "task given to worker" });

      // Build worker_task children (only show what exists)
      const children: { name: string; comment: string }[] = [];
      if (hasSystemPrompt) children.push({ name: "system_prompt.txt", comment: "worker system prompt" });
      children.push({ name: "user_prompt.txt", comment: "worker task prompt" });
      if (hasSchema) children.push({ name: "schema.json", comment: "expected output schema" });
      if (hasInput) children.push({ name: "input/", comment: "worker input files" });

      children.forEach((child, j) => {
        const isLastChild = j === children.length - 1;
        const childPrefix = isLastChild ? "└── " : "├── ";
        entries.push({ line: `${childIndent}${childPrefix}${child.name}`, comment: child.comment });
      });
    } else if (folder.startsWith("candidate_")) {
      const idx = folder.replace("candidate_", "");
      entries.push({ line: `${folderPrefix}${folder}/`, comment: `worker ${idx} solution` });
    } else if (folder === "worker_output") {
      entries.push({ line: `${folderPrefix}${folder}/`, comment: "output to verify" });
    } else if (folder.startsWith("item_")) {
      const idx = folder.replace("item_", "");
      entries.push({ line: `${folderPrefix}${folder}/`, comment: `input ${idx}` });
    } else {
      entries.push({ line: `${folderPrefix}${folder}/`, comment: "" });
    }
  });

  // Calculate max line width and align comments
  const maxWidth = Math.max(...entries.map((e) => e.line.length));
  const lines = ["context/"];
  for (const entry of entries) {
    if (entry.comment) {
      const padding = " ".repeat(maxWidth - entry.line.length + 3);
      lines.push(`${entry.line}${padding}# ${entry.comment}`);
    } else {
      lines.push(entry.line);
    }
  }

  return lines.join("\n");
}
