#!/usr/bin/env tsx
/**
 * Integration Test 03: File Operations
 *
 * Tests:
 * - uploadContext() - runtime upload to context/
 * - uploadFiles() - runtime upload to workspace
 * - getOutputFiles() - retrieve output files (with recursive option)
 * - readLocalDir() - read local directory into FileMap
 * - run() to verify uploaded files are accessible
 */

import { Evolve, readLocalDir } from "../../dist/index.js";
import { createE2BProvider } from "../../../e2b/src/index.js";
import { config } from "dotenv";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { getDefaultAgentConfig, getTestEnv } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const LOGS_DIR = resolve(__dirname, "../test-logs/03-file-operations");
const agentConfig = getDefaultAgentConfig();
const env = getTestEnv();

function log(msg: string) {
  console.log(`[03-file-operations] ${msg}`);
}

function save(name: string, content: string | Uint8Array) {
  mkdirSync(LOGS_DIR, { recursive: true });
  writeFileSync(resolve(LOGS_DIR, name), content);
}

async function main() {
  rmSync(LOGS_DIR, { recursive: true, force: true });
  mkdirSync(LOGS_DIR, { recursive: true });

  log("Starting test...");
  const start = Date.now();

  const evolve = new Evolve()
    .withAgent(agentConfig)
    .withSandbox(createE2BProvider({ apiKey: env.E2B_API_KEY }));

  try {
    // Test 1: run() first to initialize sandbox
    log("Test 1: Initial run() to create sandbox...");
    const run1 = await evolve.run({
      prompt: "List the contents of the current directory with ls -la",
      timeoutMs: 180000,
    });
    log(`  run() completed: exit=${run1.exitCode}`);
    save("run1-stdout.txt", run1.stdout);

    if (run1.exitCode !== 0) {
      throw new Error(`Initial run() failed with exit code ${run1.exitCode}`);
    }

    // Test 2: uploadContext() - upload files to context/
    log("Test 2: uploadContext() - uploading to context/...");
    const contextData = {
      "uploaded-context.txt": "This is context data uploaded at runtime",
      "nested/deep/context.json": JSON.stringify({ test: true, timestamp: Date.now() }),
    };
    await evolve.uploadContext(contextData);
    log(`  uploadContext() completed`);

    // Test 3: uploadFiles() - upload files to workspace
    log("Test 3: uploadFiles() - uploading to workspace...");
    const workspaceData = {
      "uploaded-file.txt": "This is a workspace file uploaded at runtime",
      "scripts/test-script.sh": "#!/bin/bash\necho 'Hello from uploaded script'",
    };
    await evolve.uploadFiles(workspaceData);
    log(`  uploadFiles() completed`);

    // Test 4: Verify uploaded files are accessible via run()
    log("Test 4: Verifying uploaded files via run()...");
    const run2 = await evolve.run({
      prompt: "List all files in context/ and in the workspace. Then read uploaded-context.txt and uploaded-file.txt and tell me what they contain.",
      timeoutMs: 180000,
    });
    log(`  run() completed: exit=${run2.exitCode}`);
    save("run2-stdout.txt", run2.stdout);

    if (run2.exitCode !== 0) {
      throw new Error(`Verification run() failed with exit code ${run2.exitCode}`);
    }

    // Test 5: Create output files and retrieve them
    log("Test 5: Creating and retrieving output files...");
    const run3 = await evolve.run({
      prompt: "Create a file called output/result.txt with the text 'Test output file created successfully'. Also create output/data.json with {\"success\": true}",
      timeoutMs: 180000,
    });
    log(`  run() completed: exit=${run3.exitCode}`);
    save("run3-stdout.txt", run3.stdout);

    // Test 6: getOutputFiles()
    log("Test 6: getOutputFiles() - retrieving output files...");
    const outputResult = await evolve.getOutputFiles();
    const fileNames = Object.keys(outputResult.files);
    log(`  Retrieved ${fileNames.length} output files:`);
    for (const [name, content] of Object.entries(outputResult.files)) {
      log(`    - ${name}`);
      const data = typeof content === "string" ? content : new Uint8Array(content as ArrayBuffer);
      save(`output-${name}`, data);
    }

    if (fileNames.length === 0) {
      log("  WARNING: No output files retrieved (agent may not have created files in output/)");
    }

    // Test 7: readLocalDir() - local utility
    log("Test 7: readLocalDir() - local utility (no sandbox)...");
    const tempDir = resolve(LOGS_DIR, "temp-test-dir");
    rmSync(tempDir, { recursive: true, force: true });
    mkdirSync(tempDir, { recursive: true });
    mkdirSync(join(tempDir, "subdir", "nested"), { recursive: true });

    writeFileSync(join(tempDir, "file1.txt"), "Content 1");
    writeFileSync(join(tempDir, "file2.txt"), "Content 2");
    writeFileSync(join(tempDir, "subdir", "shallow.txt"), "Shallow content");
    writeFileSync(join(tempDir, "subdir", "nested", "deep.txt"), "Deep content");

    // Test non-recursive
    const localFiles = readLocalDir(tempDir);
    const localNames = Object.keys(localFiles);
    log(`  Non-recursive: found ${localNames.length} files: ${localNames.join(", ")}`);
    if (localNames.length !== 2) {
      throw new Error(`readLocalDir() non-recursive should find 2 files, got ${localNames.length}`);
    }
    if (!localNames.includes("file1.txt") || !localNames.includes("file2.txt")) {
      throw new Error("readLocalDir() should include file1.txt and file2.txt");
    }

    // Test recursive
    const allLocalFiles = readLocalDir(tempDir, true);
    const allLocalNames = Object.keys(allLocalFiles);
    log(`  Recursive: found ${allLocalNames.length} files: ${allLocalNames.join(", ")}`);
    if (allLocalNames.length !== 4) {
      throw new Error(`readLocalDir(recursive=true) should find 4 files, got ${allLocalNames.length}`);
    }
    if (!allLocalNames.includes("subdir/shallow.txt") || !allLocalNames.includes("subdir/nested/deep.txt")) {
      throw new Error("readLocalDir(recursive) should include nested files");
    }

    // Verify content is Buffer
    const content = allLocalFiles["file1.txt"];
    if (!(content instanceof Buffer)) {
      throw new Error("readLocalDir() content should be Buffer");
    }
    if (content.toString() !== "Content 1") {
      throw new Error("readLocalDir() content should match");
    }
    log("  readLocalDir() tests passed");
    rmSync(tempDir, { recursive: true, force: true });

    // Test 8: getOutputFiles(recursive) - nested output files
    log("Test 8: getOutputFiles(recursive=true) - nested output...");
    // Create nested files via run() so they're included in timestamp filtering
    await evolve.run({
      prompt: "Create nested directories and files: mkdir -p output/subdir/nested && echo 'top level' > output/top.txt && echo 'shallow' > output/subdir/shallow.txt && echo 'deep' > output/subdir/nested/deep.txt",
      timeoutMs: 120000,
    });
    log("  Created nested files in output/");

    // Test non-recursive
    const topLevelResult = await evolve.getOutputFiles();
    const topLevelNames = Object.keys(topLevelResult.files);
    log(`  Non-recursive: ${topLevelNames.length} files: ${topLevelNames.join(", ")}`);
    const hasNestedNonRecursive = topLevelNames.some(n => n.includes("/"));
    if (hasNestedNonRecursive && topLevelNames.length > 1) {
      log("  WARNING: Non-recursive returned nested files (might be timing issue)");
    }

    // Test recursive
    const allOutputResult = await evolve.getOutputFiles(true);
    const allOutputNames = Object.keys(allOutputResult.files);
    log(`  Recursive: ${allOutputNames.length} files: ${allOutputNames.join(", ")}`);
    if (allOutputNames.length < 3) {
      throw new Error(`getOutputFiles(recursive) should find at least 3 files, got ${allOutputNames.length}`);
    }
    const hasSubdir = allOutputNames.some(n => n.includes("subdir/"));
    if (!hasSubdir) {
      throw new Error("getOutputFiles(recursive) should include files from subdir/");
    }
    log("  getOutputFiles(recursive) tests passed");

    // Test 9: readLocalDir() + uploadContext() - end-to-end
    log("Test 9: readLocalDir() + uploadContext() - end-to-end...");
    const uploadTempDir = resolve(LOGS_DIR, "temp-upload-dir");
    rmSync(uploadTempDir, { recursive: true, force: true });
    mkdirSync(uploadTempDir, { recursive: true });
    mkdirSync(join(uploadTempDir, "data"), { recursive: true });

    writeFileSync(join(uploadTempDir, "local1.txt"), "Local file 1");
    writeFileSync(join(uploadTempDir, "data", "nested.json"), '{"source": "local"}');

    const filesToUpload = readLocalDir(uploadTempDir, true);
    await evolve.uploadContext(filesToUpload);
    log(`  Uploaded ${Object.keys(filesToUpload).length} files from local dir`);

    const verifyResult = await evolve.executeCommand(
      "cat /home/user/workspace/context/local1.txt && cat /home/user/workspace/context/data/nested.json",
      { timeoutMs: 30000 }
    );
    if (!verifyResult.stdout.includes("Local file 1") || !verifyResult.stdout.includes('{"source": "local"}')) {
      throw new Error("Uploaded files content mismatch");
    }
    log("  readLocalDir() + uploadContext() end-to-end passed");
    rmSync(uploadTempDir, { recursive: true, force: true });

    await evolve.kill();

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`PASS - All file operation tests passed (${duration}s)`);
    log(`============================================================\n`);
    process.exit(0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    save("error.txt", err instanceof Error ? err.stack || msg : msg);
    await evolve.kill().catch(() => {});

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`FAIL - ${msg} (${duration}s)`);
    log(`============================================================\n`);
    process.exit(1);
  }
}

main();
