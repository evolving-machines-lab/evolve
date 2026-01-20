/**
 * 01 - Hello Agent
 * Sandboxed AI agent.
 */
import "dotenv/config";
import { Evolve } from "@evolvingmachines/sdk";

// Auto-resolves EVOLVE_API_KEY from environment
const agent = new Evolve();

await agent.run({
    prompt: `
        Research the latest developments in AI agents.
        Generate a brief report summarizing the top 3 findings.
    `,
});

// Retrieve report files from sandbox output/ folder
const output = await agent.getOutputFiles();
console.log(Object.keys(output.files));

await agent.kill();
