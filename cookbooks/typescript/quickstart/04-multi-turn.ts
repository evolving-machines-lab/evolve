/**
 * 04 - Multi-Turn (Automated Memory)
 * Multiple .run() calls maintain context and history.
 */
import "dotenv/config";
import { Evolve } from "@evolvingmachines/sdk";

const agent = new Evolve();

// Turn 1: Create initial data
await agent.run({
    prompt: "Create a JSON file with 5 random users (name, email, age)",
});
const output1 = await agent.getOutputFiles();
console.log("Turn 1:", Object.keys(output1.files));

// Turn 2: Agent remembers the file it created
await agent.run({
    prompt: "Filter the users to only include those over 25",
});
const output2 = await agent.getOutputFiles();
console.log("Turn 2:", Object.keys(output2.files));

// Turn 3: Agent has full conversation history
await agent.run({
    prompt: "Create a summary report of the filtered users",
});
const output3 = await agent.getOutputFiles();
console.log("Turn 3:", Object.keys(output3.files));

await agent.kill();
