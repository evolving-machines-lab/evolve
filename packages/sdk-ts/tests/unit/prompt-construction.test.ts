#!/usr/bin/env npx tsx
/**
 * Unit Test: Prompt Construction
 *
 * Tests prompt construction using actual src/ functions:
 * - buildWorkerSystemPrompt() for Agent prompts
 * - applyTemplate() for template variable substitution
 * - zodSchemaToJson() for schema conversion
 * - buildFileTree() logic copied from src/swarm/index.ts
 *
 * Saves generated files to test-logs/prompt-construction/ for inspection.
 */

import { z } from "zod";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// Import actual functions from src/
import {
  buildWorkerSystemPrompt,
  applyTemplate,
  zodSchemaToJson,
  WORKSPACE_PROMPT,
  WORKSPACE_SWE_PROMPT,
  SYSTEM_PROMPT,
  SCHEMA_PROMPT,
  JUDGE_PROMPT,
} from "../../dist/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(__dirname, "../test-logs/prompt-construction");

// =============================================================================
// buildFileTree() - copied from src/swarm/index.ts
// =============================================================================

type FileMap = Record<string, string | Uint8Array>;

function buildFileTree(files: FileMap): string {
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
      entries.push({ line: `${folderPrefix}${folder}/`, comment: "task given to workers" });

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

// =============================================================================
// TEST SCHEMAS
// =============================================================================

const AnalysisSchema = z.object({
  summary: z.string(),
  score: z.number(),
  tags: z.array(z.string()),
});

const JudgeSchema = z.object({
  winner: z.number().min(0).max(2),
  reasoning: z.string(),
});

// =============================================================================
// TEST CASES
// =============================================================================

interface TestCase {
  name: string;
  filename: string;
  generator: () => string;
}

const WORKING_DIR = "/home/user/workspace";

const testCases: TestCase[] = [
  // =========================================================================
  // WORKER PROMPTS (using buildWorkerSystemPrompt from src/)
  // =========================================================================

  // Knowledge mode
  {
    name: "Knowledge mode - bare (no system prompt, no schema)",
    filename: "01-worker-knowledge-bare.md",
    generator: () => buildWorkerSystemPrompt({
      workingDir: WORKING_DIR,
      mode: "knowledge",
    }),
  },
  {
    name: "Knowledge mode - with system prompt only",
    filename: "02-worker-knowledge-system-prompt.md",
    generator: () => buildWorkerSystemPrompt({
      workingDir: WORKING_DIR,
      mode: "knowledge",
      systemPrompt: "You are a helpful financial analyst. Always be precise with numbers.",
    }),
  },
  {
    name: "Knowledge mode - with schema only",
    filename: "03-worker-knowledge-schema.md",
    generator: () => buildWorkerSystemPrompt({
      workingDir: WORKING_DIR,
      mode: "knowledge",
      schema: AnalysisSchema,
    }),
  },
  {
    name: "Knowledge mode - with system prompt and schema",
    filename: "04-worker-knowledge-full.md",
    generator: () => buildWorkerSystemPrompt({
      workingDir: WORKING_DIR,
      mode: "knowledge",
      systemPrompt: "You are a helpful financial analyst. Always be precise with numbers.",
      schema: AnalysisSchema,
    }),
  },

  // SWE mode
  {
    name: "SWE mode - bare (no system prompt, no schema)",
    filename: "05-worker-swe-bare.md",
    generator: () => buildWorkerSystemPrompt({
      workingDir: WORKING_DIR,
      mode: "swe",
    }),
  },
  {
    name: "SWE mode - with system prompt only",
    filename: "06-worker-swe-system-prompt.md",
    generator: () => buildWorkerSystemPrompt({
      workingDir: WORKING_DIR,
      mode: "swe",
      systemPrompt: "You are a senior software engineer. Follow best practices.",
    }),
  },
  {
    name: "SWE mode - with schema only",
    filename: "07-worker-swe-schema.md",
    generator: () => buildWorkerSystemPrompt({
      workingDir: WORKING_DIR,
      mode: "swe",
      schema: AnalysisSchema,
    }),
  },
  {
    name: "SWE mode - with system prompt and schema",
    filename: "08-worker-swe-full.md",
    generator: () => buildWorkerSystemPrompt({
      workingDir: WORKING_DIR,
      mode: "swe",
      systemPrompt: "You are a senior software engineer. Follow best practices.",
      schema: AnalysisSchema,
    }),
  },

  // =========================================================================
  // JUDGE PROMPTS (using applyTemplate + JUDGE_PROMPT from src/)
  // fileTree generated using buildFileTree() logic copied from src/
  // =========================================================================
  {
    name: "Judge prompt - 3 candidates with input files",
    filename: "09-judge-3-candidates.md",
    generator: () => {
      // Build a realistic FileMap like Swarm does
      const context: FileMap = {
        "worker_task/system_prompt.txt": "You are a financial analyst.",
        "worker_task/user_prompt.txt": "Analyze the quarterly report.",
        "worker_task/schema.json": zodSchemaToJson(AnalysisSchema),
        "worker_task/input/report.pdf": "PDF content here",
        "worker_task/input/data.csv": "CSV content here",
        "candidate_0/output/result.json": '{"summary": "..."}',
        "candidate_1/output/result.json": '{"summary": "..."}',
        "candidate_2/output/result.json": '{"summary": "..."}',
      };
      const fileTree = buildFileTree(context);
      return applyTemplate(JUDGE_PROMPT, {
        candidateCount: "3",
        criteria: "Most accurate and comprehensive analysis. Check for correctness, completeness, and clarity.",
        fileTree: fileTree,
      });
    },
  },
  {
    name: "Judge prompt - 5 candidates without input files",
    filename: "10-judge-5-candidates-no-input.md",
    generator: () => {
      // No input files case
      const context: FileMap = {
        "worker_task/user_prompt.txt": "Write a poem about AI.",
        "candidate_0/output/poem.txt": "Roses are red...",
        "candidate_1/output/poem.txt": "In silicon dreams...",
        "candidate_2/output/poem.txt": "The machine awakens...",
        "candidate_3/output/poem.txt": "Binary stars...",
        "candidate_4/output/poem.txt": "Neurons of light...",
      };
      const fileTree = buildFileTree(context);
      return applyTemplate(JUDGE_PROMPT, {
        candidateCount: "5",
        criteria: "Best creativity, emotional impact, and poetic quality.",
        fileTree: fileTree,
      });
    },
  },

  // =========================================================================
  // RAW TEMPLATES (for reference)
  // =========================================================================
  {
    name: "Raw template - workspace-knowledge.md",
    filename: "11-raw-workspace-knowledge.md",
    generator: () => WORKSPACE_PROMPT,
  },
  {
    name: "Raw template - workspace-swe.md",
    filename: "12-raw-workspace-swe.md",
    generator: () => WORKSPACE_SWE_PROMPT,
  },
  {
    name: "Raw template - system.md",
    filename: "13-raw-system.md",
    generator: () => SYSTEM_PROMPT,
  },
  {
    name: "Raw template - schema.md",
    filename: "14-raw-schema.md",
    generator: () => SCHEMA_PROMPT,
  },
  {
    name: "Raw template - judge.md",
    filename: "15-raw-judge.md",
    generator: () => JUDGE_PROMPT,
  },

  // =========================================================================
  // SCHEMA CONVERSION (using zodSchemaToJson from src/)
  // =========================================================================
  {
    name: "Schema JSON - AnalysisSchema",
    filename: "16-schema-analysis.json",
    generator: () => zodSchemaToJson(AnalysisSchema),
  },
  {
    name: "Schema JSON - JudgeSchema",
    filename: "17-schema-judge.json",
    generator: () => zodSchemaToJson(JudgeSchema),
  },
];

// =============================================================================
// VALIDATION TESTS
// =============================================================================

interface ValidationTest {
  name: string;
  test: () => boolean;
}

const validationTests: ValidationTest[] = [
  {
    name: "Knowledge mode includes context/ folder",
    test: () => {
      const prompt = buildWorkerSystemPrompt({ workingDir: WORKING_DIR, mode: "knowledge" });
      return prompt.includes("context/") && !prompt.includes("repo/");
    },
  },
  {
    name: "SWE mode includes repo/ folder",
    test: () => {
      const prompt = buildWorkerSystemPrompt({ workingDir: WORKING_DIR, mode: "swe" });
      return prompt.includes("repo/") && prompt.includes("context/");
    },
  },
  {
    name: "System prompt is appended (not prepended)",
    test: () => {
      const prompt = buildWorkerSystemPrompt({
        workingDir: WORKING_DIR,
        mode: "knowledge",
        systemPrompt: "CUSTOM_MARKER_123",
      });
      const workspaceIndex = prompt.indexOf("FILESYSTEM INSTRUCTIONS");
      const customIndex = prompt.indexOf("CUSTOM_MARKER_123");
      return workspaceIndex < customIndex;
    },
  },
  {
    name: "Schema is appended after system prompt",
    test: () => {
      const prompt = buildWorkerSystemPrompt({
        workingDir: WORKING_DIR,
        mode: "knowledge",
        systemPrompt: "CUSTOM_MARKER_123",
        schema: AnalysisSchema,
      });
      const customIndex = prompt.indexOf("CUSTOM_MARKER_123");
      const schemaIndex = prompt.indexOf("STRUCTURED OUTPUT");
      return customIndex < schemaIndex;
    },
  },
  {
    name: "Working directory is substituted",
    test: () => {
      const prompt = buildWorkerSystemPrompt({ workingDir: "/custom/path", mode: "knowledge" });
      return prompt.includes("/custom/path") && !prompt.includes("{{workingDir}}");
    },
  },
  {
    name: "Judge prompt has no unsubstituted placeholders when filled",
    test: () => {
      const prompt = applyTemplate(JUDGE_PROMPT, {
        candidateCount: "3",
        criteria: "test criteria",
        fileTree: "test tree",
      });
      return !prompt.includes("{{");
    },
  },
  {
    name: "zodSchemaToJson produces valid JSON",
    test: () => {
      const json = zodSchemaToJson(AnalysisSchema);
      try {
        JSON.parse(json);
        return true;
      } catch {
        return false;
      }
    },
  },
  {
    name: "zodSchemaToJson includes type definitions",
    test: () => {
      const json = zodSchemaToJson(AnalysisSchema);
      const parsed = JSON.parse(json);
      return parsed.type === "object" && parsed.properties?.summary?.type === "string";
    },
  },
  {
    name: "buildFileTree shows worker_task first",
    test: () => {
      const files: FileMap = {
        "candidate_0/output/result.json": "{}",
        "worker_task/user_prompt.txt": "test",
        "candidate_1/output/result.json": "{}",
      };
      const tree = buildFileTree(files);
      const workerIndex = tree.indexOf("worker_task");
      const candidateIndex = tree.indexOf("candidate_0");
      return workerIndex < candidateIndex;
    },
  },
  {
    name: "buildFileTree shows input/ subfolder when present",
    test: () => {
      const files: FileMap = {
        "worker_task/user_prompt.txt": "test",
        "worker_task/input/file.txt": "content",
        "candidate_0/output/result.json": "{}",
      };
      const tree = buildFileTree(files);
      return tree.includes("worker_task/") && tree.includes("input/");
    },
  },
  {
    name: "buildFileTree omits input/ when no input files",
    test: () => {
      const files: FileMap = {
        "worker_task/user_prompt.txt": "test",
        "candidate_0/output/result.json": "{}",
      };
      const tree = buildFileTree(files);
      return tree.includes("worker_task/") && !tree.includes("input/");
    },
  },
  {
    name: "buildFileTree shows system_prompt.txt only when present",
    test: () => {
      const withSys: FileMap = {
        "worker_task/system_prompt.txt": "custom prompt",
        "worker_task/user_prompt.txt": "test",
        "candidate_0/output/result.json": "{}",
      };
      const withoutSys: FileMap = {
        "worker_task/user_prompt.txt": "test",
        "candidate_0/output/result.json": "{}",
      };
      const treeWith = buildFileTree(withSys);
      const treeWithout = buildFileTree(withoutSys);
      return treeWith.includes("system_prompt.txt") && !treeWithout.includes("system_prompt.txt");
    },
  },
  {
    name: "buildFileTree shows schema.json only when present",
    test: () => {
      const withSchema: FileMap = {
        "worker_task/user_prompt.txt": "test",
        "worker_task/schema.json": "{}",
        "candidate_0/output/result.json": "{}",
      };
      const withoutSchema: FileMap = {
        "worker_task/user_prompt.txt": "test",
        "candidate_0/output/result.json": "{}",
      };
      const treeWith = buildFileTree(withSchema);
      const treeWithout = buildFileTree(withoutSchema);
      return treeWith.includes("schema.json") && !treeWithout.includes("schema.json");
    },
  },
  {
    name: "buildFileTree has inline comments",
    test: () => {
      const files: FileMap = {
        "worker_task/user_prompt.txt": "test",
        "candidate_0/output/result.json": "{}",
      };
      const tree = buildFileTree(files);
      return tree.includes("# task given to workers") && tree.includes("# worker 0 solution");
    },
  },
];

// =============================================================================
// MAIN
// =============================================================================

async function main() {
  console.log("============================================================");
  console.log("Prompt Construction Unit Tests");
  console.log("============================================================\n");

  // Clean and create output directory
  rmSync(OUTPUT_DIR, { recursive: true, force: true });
  mkdirSync(OUTPUT_DIR, { recursive: true });

  let passed = 0;
  let failed = 0;

  // Run generation tests
  console.log("--- Generation Tests ---\n");

  for (const testCase of testCases) {
    process.stdout.write(`[${testCase.filename}] ${testCase.name}... `);

    try {
      const content = testCase.generator();
      writeFileSync(resolve(OUTPUT_DIR, testCase.filename), content);
      console.log(`✓ (${content.length} chars)`);
      passed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`✗ (${msg})`);
      failed++;
    }
  }

  // Run validation tests
  console.log("\n--- Validation Tests ---\n");

  for (const test of validationTests) {
    process.stdout.write(`${test.name}... `);

    try {
      if (test.test()) {
        console.log("✓");
        passed++;
      } else {
        console.log("✗ (assertion failed)");
        failed++;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`✗ (${msg})`);
      failed++;
    }
  }

  console.log("\n============================================================");
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`Output saved to: ${OUTPUT_DIR}`);
  console.log("============================================================\n");

  process.exit(failed > 0 ? 1 : 0);
}

main();
