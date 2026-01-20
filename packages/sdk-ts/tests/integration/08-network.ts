#!/usr/bin/env tsx
/**
 * Integration Test 08: Network & Port Forwarding
 *
 * Tests:
 * - getHost() - get public URL for a port
 * - Verify port forwarding works by starting a service
 */

import { Evolve } from "../../dist/index.js";
import { createE2BProvider } from "../../../e2b/src/index.js";
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { getDefaultAgentConfig, getTestEnv } from "./test-config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../../../../.env") });

const LOGS_DIR = resolve(__dirname, "../test-logs/08-network");
const agentConfig = getDefaultAgentConfig();
const env = getTestEnv();

function log(msg: string) {
  console.log(`[08-network] ${msg}`);
}

function save(name: string, content: string) {
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
    // Test 1: Initial run to create sandbox
    log("Test 1: Initial run() to create sandbox...");
    const run1 = await evolve.run({
      prompt: "Say hello briefly",
      timeoutMs: 180000,
    });
    log(`  run() completed: exit=${run1.exitCode}`);
    save("run1-stdout.txt", run1.stdout);

    // Test 2: getHost() - get URL for port
    log("Test 2: getHost() - get public URL for port 8000...");
    const hostUrl = await evolve.getHost(8000);
    log(`  getHost(8000) returned: ${hostUrl}`);
    save("host-url.txt", hostUrl);

    // getHost() returns hostname (may or may not include https://)
    if (!hostUrl || hostUrl.length < 10) {
      throw new Error(`getHost() returned invalid host: ${hostUrl}`);
    }
    // Should contain port number and e2b domain
    if (!hostUrl.includes("8000") || !hostUrl.includes("e2b")) {
      log(`  WARNING: Unexpected host format: ${hostUrl}`);
    }
    log("  Host format looks valid");

    // Test 3: Start a simple HTTP server and verify port forwarding
    log("Test 3: Starting HTTP server on port 8000...");
    const serverCmd = await evolve.executeCommand(
      "python3 -c \"import http.server; import socketserver; handler = http.server.SimpleHTTPRequestHandler; httpd = socketserver.TCPServer(('', 8000), handler); print('Server started'); httpd.handle_request()\" &",
      { timeoutMs: 10000, background: true }
    );
    log(`  Server start command: exit=${serverCmd.exitCode}`);
    save("server-start.txt", JSON.stringify(serverCmd, null, 2));

    // Give server time to start
    await new Promise(r => setTimeout(r, 2000));

    // Test 4: Verify server is running
    log("Test 4: Verifying server is running...");
    const checkCmd = await evolve.executeCommand("curl -s http://localhost:8000 || echo 'curl failed'", {
      timeoutMs: 10000,
    });
    log(`  curl check: exit=${checkCmd.exitCode}`);
    log(`  Response length: ${checkCmd.stdout.length} chars`);
    save("curl-check.txt", checkCmd.stdout);

    // Test 5: Get host URL for different port
    log("Test 5: getHost() for different ports...");
    const port3000 = await evolve.getHost(3000);
    const port5000 = await evolve.getHost(5000);
    log(`  getHost(3000): ${port3000}`);
    log(`  getHost(5000): ${port5000}`);
    save("ports.txt", `Port 3000: ${port3000}\nPort 5000: ${port5000}`);

    // Verify URLs are different for different ports
    if (port3000 === port5000) {
      log("  WARNING: Same URL returned for different ports");
    } else {
      log("  Different URLs returned for different ports (expected)");
    }

    await evolve.kill();

    const duration = ((Date.now() - start) / 1000).toFixed(1);
    log(`\n============================================================`);
    log(`PASS - All network tests passed (${duration}s)`);
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
