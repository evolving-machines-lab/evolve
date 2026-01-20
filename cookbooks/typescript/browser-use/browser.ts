/**
 * Browser-Use Cookbook
 * Browser automation with browser-use cloud API.
 *
 * Setup:
 *   export EVOLVE_API_KEY=your-api-key
 *
 * Gateway mode automatically includes browser-use MCP server.
 */

import "dotenv/config";
import { Swarm, Pipeline } from "@evolvingmachines/sdk";

import { buildItems, setupRunDir, saveResults } from "./items";
import { visitPostPrompt } from "./prompt";
import { HNPostResultSchema } from "./schema";

// Gateway mode: browser-use MCP is auto-configured via EVOLVE_API_KEY
// For BYOK mode, uncomment mcpServers and add to Swarm config below:
//
// const mcpServers = {
//     "browser-use": {
//         command: "npx",
//         args: [
//             "-y", "mcp-remote", "https://api.browser-use.com/mcp",
//             "--header", `X-Browser-Use-API-Key: ${process.env.BROWSER_USE_API_KEY}`,
//         ],
//     },
// };

const swarm = new Swarm({
    tag: "quickstart-hn-browser-use",
    concurrency: 4,
    retry: { maxAttempts: 2 },
    // mcpServers,  // Uncomment for BYOK mode
});

const pipeline = new Pipeline(swarm).map({
    name: "visit-post",
    prompt: visitPostPrompt,
    schema: HNPostResultSchema,
    agent: { type: "claude", model: "haiku" },
    timeoutMs: 15 * 60 * 1000,
    verify: {
        criteria: `
            The result must meet ALL these requirements:
            1. Summary field must contain a meaningful markdown summary (not an error message)
            2. Summary must be at least 500 characters long with proper formatting
            3. At least 2-3 relevant screenshots must be captured and listed
            4. Title, outbound_url, and final_url must be extracted
            5. Summary must include embedded screenshot references using markdown image syntax
            6. No error field or error field must be null
        `,
        maxAttempts: 2,
    },
});

async function main(): Promise<void> {
    const items = buildItems(3);
    const { runDir, postsDir, startedAt } = setupRunDir(items);

    console.log(`Visiting top ${items.length} Hacker News posts...`);
    const result = await pipeline.run(items);

    saveResults(result, items, postsDir, runDir, startedAt);
    console.log(`Done. Artifacts saved to: ${runDir}`);
}

main().catch(console.error);
