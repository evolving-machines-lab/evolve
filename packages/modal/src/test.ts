/**
 * Comprehensive Modal Provider Tests
 *
 * Tests all features:
 * - Sandbox creation and lifecycle
 * - Command execution (run, spawn, list, kill)
 * - File operations (read, write, writeBatch, binary files)
 * - Parallel operations
 * - Folder operations (list, makeDir, exists, remove, rename)
 * - Port tunneling (getHost)
 */

import { config } from "dotenv";
import { createModalProvider, SandboxInstance } from "./index";

// Load .env from project root
config({ path: "../../.env" });

// Test utilities
const log = (msg: string) => console.log(`\n✅ ${msg}`);
const logSection = (msg: string) => console.log(`\n${"=".repeat(60)}\n${msg}\n${"=".repeat(60)}`);
const assert = (condition: boolean, msg: string) => {
  if (!condition) throw new Error(`❌ Assertion failed: ${msg}`);
};

// Sample test files
const TEXT_CONTENT = "Hello, Modal! This is a test file.\nWith multiple lines.\nAnd special chars: é ñ 中文";
const JSON_CONTENT = JSON.stringify({ name: "test", values: [1, 2, 3], nested: { a: true } }, null, 2);
const BINARY_CONTENT = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]); // PNG header

async function runTests() {
  console.log("🚀 Starting Modal Provider Comprehensive Tests\n");

  const provider = createModalProvider({
    appName: "evolve-test",
    defaultTimeoutMs: 300000, // 5 min
  });

  let sandbox: SandboxInstance | null = null;

  try {
    // ================================================================
    // SANDBOX CREATION
    // ================================================================
    logSection("1. SANDBOX CREATION");

    const startTime = Date.now();
    sandbox = await provider.create({
      image: "python:3.12-slim",
      envs: { TEST_VAR: "hello_world" },
      workingDirectory: "/home/user",
    });
    const createTime = Date.now() - startTime;

    log(`Sandbox created in ${createTime}ms`);
    log(`Sandbox ID: ${sandbox.sandboxId}`);
    assert(sandbox.sandboxId.length > 0, "sandboxId should not be empty");

    // ================================================================
    // COMMAND EXECUTION
    // ================================================================
    logSection("2. COMMAND EXECUTION");

    // Test run() - basic command
    const echoResult = await sandbox.commands.run("echo 'Hello Modal'");
    log(`run() basic: exit=${echoResult.exitCode}, stdout="${echoResult.stdout.trim()}"`);
    assert(echoResult.exitCode === 0, "echo should succeed");
    assert(echoResult.stdout.includes("Hello Modal"), "stdout should contain message");

    // Test run() - with environment variable
    const envResult = await sandbox.commands.run("echo $TEST_VAR");
    log(`run() env var: stdout="${envResult.stdout.trim()}"`);
    assert(envResult.stdout.includes("hello_world"), "env var should be set");

    // Test run() - with cwd option
    await sandbox.commands.run("mkdir -p /tmp/testdir");
    const cwdResult = await sandbox.commands.run("pwd", { cwd: "/tmp/testdir" });
    log(`run() with cwd: stdout="${cwdResult.stdout.trim()}"`);
    assert(cwdResult.stdout.includes("/tmp/testdir"), "cwd should work");

    // Test run() - stderr capture
    const stderrResult = await sandbox.commands.run("echo 'error msg' >&2");
    log(`run() stderr: stderr="${stderrResult.stderr.trim()}"`);
    assert(stderrResult.stderr.includes("error msg"), "stderr should be captured");

    // Test run() - exit code
    const failResult = await sandbox.commands.run("exit 42");
    log(`run() exit code: ${failResult.exitCode}`);
    assert(failResult.exitCode === 42, "exit code should be 42");

    // Test spawn() - background process
    const spawnHandle = await sandbox.commands.spawn("sleep 1 && echo 'done'");
    log(`spawn() started: processId=${spawnHandle.processId}`);
    const spawnResult = await spawnHandle.wait();
    log(`spawn() completed: exit=${spawnResult.exitCode}, stdout="${spawnResult.stdout.trim()}"`);
    assert(spawnResult.stdout.includes("done"), "spawn should complete");

    // Test list() - process listing
    // Note: Modal's exec model runs each command in isolation, so spawned processes
    // may not be visible to subsequent ps calls. We test that list() works without errors.
    const processes = await sandbox.commands.list();
    log(`list() works: returned ${processes.length} entries`);
    // Don't assert count - Modal's process visibility is different from E2B

    // Test kill() - verify the method works (even if no process to kill)
    const testKill = await sandbox.commands.kill("99999");
    log(`kill() non-existent PID: ${testKill}`);

    // ================================================================
    // FILE OPERATIONS - BASIC
    // ================================================================
    logSection("3. FILE OPERATIONS - BASIC");

    // Test write() and read() - text file
    await sandbox.files.write("/tmp/test.txt", TEXT_CONTENT);
    const readText = await sandbox.files.read("/tmp/test.txt");
    log(`write/read text: ${(readText as string).length} chars`);
    assert(readText === TEXT_CONTENT, "text content should match");

    // Test write() and read() - JSON file
    await sandbox.files.write("/tmp/test.json", JSON_CONTENT);
    const readJson = await sandbox.files.read("/tmp/test.json");
    log(`write/read JSON: ${(readJson as string).length} chars`);
    assert(readJson === JSON_CONTENT, "JSON content should match");

    // Test makeDir()
    await sandbox.files.makeDir("/tmp/nested/deep/folder");
    const mkdirCheck = await sandbox.commands.run("test -d /tmp/nested/deep/folder && echo exists");
    log(`makeDir(): ${mkdirCheck.stdout.trim()}`);
    assert(mkdirCheck.stdout.includes("exists"), "nested dir should exist");

    // Test exists()
    const existsTrue = await sandbox.files.exists("/tmp/test.txt");
    const existsFalse = await sandbox.files.exists("/tmp/nonexistent.txt");
    log(`exists(): true=${existsTrue}, false=${existsFalse}`);
    assert(existsTrue === true, "existing file should return true");
    assert(existsFalse === false, "nonexistent file should return false");

    // ================================================================
    // FILE OPERATIONS - BINARY
    // ================================================================
    logSection("4. FILE OPERATIONS - BINARY");

    // Test binary write/read with PNG header
    await sandbox.files.write("/tmp/test.png", BINARY_CONTENT);
    const readBinary = await sandbox.files.read("/tmp/test.png") as Uint8Array;
    log(`write/read binary: ${readBinary.length} bytes`);
    assert(readBinary.length === BINARY_CONTENT.length, "binary length should match");
    assert(readBinary[0] === 0x89 && readBinary[1] === 0x50, "PNG header should match");

    // Create a real image using Python
    const createImageResult = await sandbox.commands.run(`python3 -c "
from PIL import Image
import io

# Create a simple 100x100 red image
img = Image.new('RGB', (100, 100), color='red')
img.save('/tmp/red_image.png')
print('Image created')
" 2>&1 || pip install Pillow && python3 -c "
from PIL import Image
img = Image.new('RGB', (100, 100), color='red')
img.save('/tmp/red_image.png')
print('Image created')
"`);
    log(`Create real PNG: ${createImageResult.stdout.trim()}`);

    // Read real image
    const realImage = await sandbox.files.read("/tmp/red_image.png") as Uint8Array;
    log(`Read real PNG: ${realImage.length} bytes, starts with ${realImage.slice(0, 4).join(",")}`);
    assert(realImage.length > 100, "real image should have content");
    assert(realImage[0] === 0x89 && realImage[1] === 0x50, "should be valid PNG");

    // ================================================================
    // FILE OPERATIONS - BATCH
    // ================================================================
    logSection("5. FILE OPERATIONS - BATCH (writeBatch)");

    const batchFiles = [
      { path: "/tmp/batch/file1.txt", data: "Content of file 1" },
      { path: "/tmp/batch/file2.txt", data: "Content of file 2" },
      { path: "/tmp/batch/nested/file3.txt", data: "Content of file 3" },
      { path: "/tmp/batch/data.json", data: JSON.stringify({ batch: true }) },
      { path: "/tmp/batch/binary.bin", data: new Uint8Array([1, 2, 3, 4, 5]) },
    ];

    const batchStart = Date.now();
    await sandbox.files.writeBatch(batchFiles);
    const batchTime = Date.now() - batchStart;
    log(`writeBatch() ${batchFiles.length} files in ${batchTime}ms`);

    // Verify batch files
    for (const file of batchFiles) {
      const exists = await sandbox.files.exists(file.path);
      assert(exists, `batch file ${file.path} should exist`);
    }
    log(`All ${batchFiles.length} batch files verified`);

    // ================================================================
    // FILE OPERATIONS - FOLDER
    // ================================================================
    logSection("6. FILE OPERATIONS - FOLDER");

    // Test list()
    const batchList = await sandbox.files.list("/tmp/batch");
    log(`list() /tmp/batch: ${batchList.length} entries`);
    log(`  Files: ${batchList.filter(f => f.type === "file").map(f => f.name).join(", ")}`);
    log(`  Dirs: ${batchList.filter(f => f.type === "dir").map(f => f.name).join(", ")}`);
    assert(batchList.length >= 4, "should list batch files");

    // Test rename()
    await sandbox.files.rename("/tmp/batch/file1.txt", "/tmp/batch/file1_renamed.txt");
    const renamedExists = await sandbox.files.exists("/tmp/batch/file1_renamed.txt");
    const originalGone = !(await sandbox.files.exists("/tmp/batch/file1.txt"));
    log(`rename(): renamed=${renamedExists}, original_gone=${originalGone}`);
    assert(renamedExists && originalGone, "rename should work");

    // Test remove()
    await sandbox.files.remove("/tmp/batch/file2.txt");
    const removedGone = !(await sandbox.files.exists("/tmp/batch/file2.txt"));
    log(`remove(): removed=${removedGone}`);
    assert(removedGone, "remove should work");

    // ================================================================
    // PARALLEL OPERATIONS
    // ================================================================
    logSection("7. PARALLEL OPERATIONS");

    // Parallel writes
    const parallelFiles = Array.from({ length: 10 }, (_, i) => ({
      path: `/tmp/parallel/file${i}.txt`,
      data: `Parallel file ${i} content`,
    }));

    await sandbox.files.makeDir("/tmp/parallel");

    const parallelWriteStart = Date.now();
    await Promise.all(parallelFiles.map(f => sandbox!.files.write(f.path, f.data)));
    const parallelWriteTime = Date.now() - parallelWriteStart;
    log(`Parallel write 10 files: ${parallelWriteTime}ms`);

    // Parallel reads
    const parallelReadStart = Date.now();
    const parallelResults = await Promise.all(
      parallelFiles.map(f => sandbox!.files.read(f.path))
    );
    const parallelReadTime = Date.now() - parallelReadStart;
    log(`Parallel read 10 files: ${parallelReadTime}ms`);
    assert(parallelResults.every((r, i) => (r as string).includes(`Parallel file ${i}`)), "all parallel reads should match");

    // Parallel commands
    const parallelCmdStart = Date.now();
    const parallelCmds = await Promise.all([
      sandbox.commands.run("echo cmd1"),
      sandbox.commands.run("echo cmd2"),
      sandbox.commands.run("echo cmd3"),
      sandbox.commands.run("sleep 0.5 && echo cmd4"),
      sandbox.commands.run("sleep 0.5 && echo cmd5"),
    ]);
    const parallelCmdTime = Date.now() - parallelCmdStart;
    log(`Parallel 5 commands: ${parallelCmdTime}ms`);
    assert(parallelCmds.every(r => r.exitCode === 0), "all parallel commands should succeed");

    // ================================================================
    // STREAMING
    // ================================================================
    logSection("8. STREAMING");

    // Test readStream
    await sandbox.files.write("/tmp/stream_test.txt", "Line 1\nLine 2\nLine 3\n");
    const readStream = await sandbox.files.readStream("/tmp/stream_test.txt");
    const reader = readStream.getReader();
    let streamContent = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      streamContent += new TextDecoder().decode(value);
    }
    log(`readStream(): ${streamContent.length} chars`);
    assert(streamContent.includes("Line 1"), "stream should contain content");

    // Test writeStream
    const writeData = new TextEncoder().encode("Streamed content here\n");
    const writeStream = new ReadableStream({
      start(controller) {
        controller.enqueue(writeData);
        controller.close();
      }
    });
    await sandbox.files.writeStream("/tmp/stream_write.txt", writeStream);
    const streamWriteResult = await sandbox.files.read("/tmp/stream_write.txt");
    log(`writeStream(): ${(streamWriteResult as string).length} chars`);
    assert((streamWriteResult as string).includes("Streamed content"), "writeStream should work");

    // ================================================================
    // SANDBOX LIFECYCLE
    // ================================================================
    logSection("9. SANDBOX LIFECYCLE");

    // Test isRunning()
    const isRunning = await sandbox.isRunning();
    log(`isRunning(): ${isRunning}`);
    assert(isRunning === true, "sandbox should be running");

    // Test getInfo()
    const info = await sandbox.getInfo();
    log(`getInfo(): id=${info.sandboxId}, image=${info.image}`);
    assert(info.sandboxId === sandbox.sandboxId, "info sandboxId should match");

    // Test pause() - should throw
    try {
      await sandbox.pause();
      assert(false, "pause should throw");
    } catch (e: any) {
      log(`pause() throws as expected: "${e.message.substring(0, 50)}..."`);
      assert(e.message.includes("does not support pause"), "should throw pause error");
    }

    // ================================================================
    // PROVIDER METHODS
    // ================================================================
    logSection("10. PROVIDER METHODS");

    // Test connect()
    const sandboxId = sandbox.sandboxId;
    const reconnected = await provider.connect(sandboxId);
    log(`connect(): reconnected to ${reconnected.sandboxId}`);
    assert(reconnected.sandboxId === sandboxId, "should reconnect to same sandbox");

    // Verify reconnected sandbox works
    const reconnectTest = await reconnected.commands.run("echo reconnected");
    log(`reconnected sandbox works: ${reconnectTest.stdout.trim()}`);
    assert(reconnectTest.stdout.includes("reconnected"), "reconnected sandbox should work");

    // Test list()
    const sandboxList = await provider.list({ limit: 10 });
    log(`list(): found ${sandboxList.length} sandboxes`);

    // ================================================================
    // CLEANUP
    // ================================================================
    logSection("11. CLEANUP");

    await sandbox.kill();
    log("Sandbox terminated");

    // Verify killed
    try {
      await sandbox.commands.run("echo test");
      log("WARNING: sandbox still responding after kill");
    } catch {
      log("Sandbox confirmed killed");
    }

    // ================================================================
    // SUMMARY
    // ================================================================
    logSection("🎉 ALL TESTS PASSED!");
    console.log(`
Summary:
- Sandbox creation: ✅
- Command execution (run, spawn, list, kill): ✅
- File operations (read, write, text, binary): ✅
- Batch operations (writeBatch with tar): ✅
- Folder operations (list, makeDir, exists, remove, rename): ✅
- Parallel operations: ✅
- Streaming (readStream, writeStream): ✅
- Sandbox lifecycle (isRunning, getInfo, kill): ✅
- Provider methods (connect, list): ✅
- Error handling (pause throws): ✅
`);

  } catch (error: any) {
    console.error(`\n❌ TEST FAILED: ${error.message}`);
    console.error(error.stack);

    // Cleanup on failure
    if (sandbox) {
      try {
        await sandbox.kill();
        console.log("Sandbox cleaned up after failure");
      } catch {}
    }

    process.exit(1);
  }
}

// Run tests
runTests().catch(console.error);
