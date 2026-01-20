/**
 * 03 - MCP Chrome DevTools
 * Browser automation with Chrome DevTools MCP server.
 */
import "dotenv/config";
import { Evolve } from "@evolvingmachines/sdk";

// MCP servers extend agent capabilities with external tools
const agent = new Evolve()
    .withMcpServers({
        "chrome-devtools": {
            command: "npx",
            args: [
                "chrome-devtools-mcp@latest",
                "--headless=true",
                "--isolated=true",
                "--chromeArg=--no-sandbox",
                "--chromeArg=--disable-setuid-sandbox",
                "--chromeArg=--disable-dev-shm-usage",
            ],
            env: {},
        },
    });

await agent.run({
    prompt: `
        Use Chrome DevTools to:
        1. Navigate to https://news.ycombinator.com
        2. Take a screenshot and save it to a file.
    `,
});

const output = await agent.getOutputFiles();
console.log(Object.keys(output.files));

await agent.kill();
