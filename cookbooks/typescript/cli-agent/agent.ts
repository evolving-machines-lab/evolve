#!/usr/bin/env npx tsx
/**
 * Swarm CLI Agent - A sandboxed CLI agent that can think, execute code,
 * browse the web, read / edit files, and solve complex tasks.
 *
 * Setup:
 *   export EVOLVE_API_KEY=your-api-key
 *
 * Gateway mode automatically includes browser-use MCP server.
 *
 * - Put files in `input/` folder - they're uploaded to the agent's context before each run
 * - Files the agent creates are automatically downloaded to your `output/` folder
 *
 * Run: npx tsx swarm.ts
 */
import "dotenv/config";
import { Evolve, readLocalDir, saveLocalDir } from "@evolvingmachines/sdk";
import { mkdirSync } from "fs";

import { makeRenderer, readPrompt, console_, printPanel } from "./ui";
import chalk from "chalk";

// ─────────────────────────────────────────────────────────────
// Evolve Instance Configuration
// ─────────────────────────────────────────────────────────────

// Gateway mode: browser-use MCP is auto-configured via EVOLVE_API_KEY
// For BYOK mode, uncomment and set BROWSER_USE_API_KEY:
//
// const MCP_SERVERS: Record<string, { command: string; args: string[] }> = {};
// if (process.env.BROWSER_USE_API_KEY) {
//   MCP_SERVERS["browser-use"] = {
//     command: "npx",
//     args: [
//       "-y", "mcp-remote", "https://api.browser-use.com/mcp",
//       "--header", `X-Browser-Use-API-Key: ${process.env.BROWSER_USE_API_KEY}`,
//     ],
//   };
// }

const SYSTEM_PROMPT = `Your name is Manus Evolve, a powerful autonomous AI agent.
You can execute code, browse the web, manage files, and solve complex tasks such as extracting
data from complex documents, analyzing data, producing evidence based reports, and more.

CRITICAL: For any browser automation tasks, you MUST use the "browser-use" MCP server.
`;

const agent = new Evolve()
  .withAgent({ type: "claude", model: "haiku" })
  .withSystemPrompt(SYSTEM_PROMPT)
  // .withMcpServers(MCP_SERVERS)  // Uncomment for BYOK mode
  .withSessionTagPrefix("swarm-cli-ts");

// ─────────────────────────────────────────────────────────────

async function main() {
  const renderer = makeRenderer();
  agent.on("content", (event) => renderer.handleEvent(event));

  console_.print();
  printPanel(
    `${chalk.bold.cyan("🤖 Swarm")}\n${chalk.dim("Autonomous AI Agent - Code, Browse, Files & More")}`,
    { borderColor: "cyan" }
  );
  console_.print();

  while (true) {
    const prompt = await readPrompt();
    if (!prompt) continue;
    if (["/quit", "/exit", "/q"].includes(prompt)) {
      await agent.kill();
      console_.print();
      console_.printMuted("👋 Goodbye");
      break;
    }

    renderer.reset();
    renderer.startLive();

    // Upload input files to agent's context
    const inputFiles = readLocalDir("input");
    if (Object.keys(inputFiles).length > 0) {
      await agent.uploadContext(inputFiles);
    }

    await agent.run({ prompt });
    renderer.stopLive();

    // Download output files
    const output = await agent.getOutputFiles(true);
    if (Object.keys(output.files).length > 0) {
      saveLocalDir("output", output.files);
      console_.print();
      for (const name of Object.keys(output.files)) {
        console_.printSuccess(`📄 Saved: output/${name}`);
      }
    }

    console_.print();
  }
}

async function shutdown() {
  await agent.kill();
  console_.print();
  console_.print();
  console_.printMuted("👋 Goodbye");
}

// ─────────────────────────────────────────────────────────────

mkdirSync("input", { recursive: true });
mkdirSync("output", { recursive: true });

main().catch(console.error);

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
