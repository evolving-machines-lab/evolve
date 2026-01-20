#!/usr/bin/env npx tsx
/**
 * Swarm CLI Agent + Composio Integrations
 *
 * AI agent with access to 500+ external services via Composio Tool Router.
 * Can send emails, post to Slack, create GitHub issues, update Notion, and more.
 *
 * Run: npx tsx swarm.ts
 */
import { Evolve, readLocalDir, saveLocalDir } from "@evolvingmachines/sdk";
import { mkdirSync } from "fs";
import "dotenv/config";
import chalk from "chalk";

import { makeRenderer, readPrompt, console_, printPanel } from "./ui";

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const USER_ID = "swarm-user-002";
// Choose from 1000+ integrations: https://docs.composio.dev/toolkits/introduction
const ENABLED_TOOLKITS = ["gmail"];

const SYSTEM_PROMPT = `Your name is Manus Evolve, a powerful autonomous AI agent.
You can execute code, manage files, and take actions across external services via Composio MCP.
`;

// ─────────────────────────────────────────────────────────────
// Evolve Agent
// ─────────────────────────────────────────────────────────────

const agent = new Evolve()
  .withAgent({ type: "claude", model: "sonnet" })
  .withSystemPrompt(SYSTEM_PROMPT)
  .withComposio(USER_ID, { toolkits: ENABLED_TOOLKITS })
  .withSessionTagPrefix("swarm-composio-ts");

// ─────────────────────────────────────────────────────────────

async function main() {
  // Pre-authenticate Composio services
  const status = await Evolve.composio.status(USER_ID) as Record<string, boolean>;
  for (const toolkit of ENABLED_TOOLKITS.filter(t => !status[t])) {
    const { url } = await Evolve.composio.auth(USER_ID, toolkit);
    console_.print(`\n${chalk.cyan(toolkit)}: ${url}`);
    console_.print(chalk.dim("Press Enter after authenticating..."));
    await new Promise<void>(r => process.stdin.once("data", () => r()));
  }

  const renderer = makeRenderer();
  agent.on("content", (event) => renderer.handleEvent(event));

  console_.print();
  printPanel(
    `${chalk.bold.cyan("Swarm")} + ${chalk.bold.magenta("Composio")}\n${chalk.dim("AI Agent with external integrations")}`,
    { borderColor: "cyan" }
  );
  console_.print();

  while (true) {
    const prompt = await readPrompt();
    if (!prompt) continue;
    if (["/quit", "/exit", "/q"].includes(prompt)) {
      await agent.kill();
      console_.print();
      console_.printMuted("Goodbye");
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
  console_.printMuted("Goodbye");
}

// ─────────────────────────────────────────────────────────────

mkdirSync("input", { recursive: true });
mkdirSync("output", { recursive: true });

main().catch(console.error);

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
