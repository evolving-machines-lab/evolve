/**
 * 02 - Streaming
 * Real-time output with all content event types.
 */
import "dotenv/config";
import { Evolve } from "@evolvingmachines/sdk";

const agent = new Evolve();

// Listen to parsed content events (recommended over raw stdout)
agent.on("content", (event) => {
    const update = event.update;
    const type = update.sessionUpdate;

    if (type === "agent_message_chunk") {
        // Text output from agent
        if (update.content?.type === "text") {
            process.stdout.write(update.content.text);
        }

    } else if (type === "agent_thought_chunk") {
        // Reasoning/thinking
        if (update.content?.type === "text") {
            process.stdout.write(`[thinking] ${update.content.text}`);
        }

    } else if (type === "tool_call") {
        // Tool execution started
        console.log(`\n[tool] ${update.title} (${update.kind})`);

    } else if (type === "tool_call_update") {
        // Tool execution finished
        console.log(`[tool] ${update.toolCallId} → ${update.status}`);

    } else if (type === "plan") {
        // Agent todo list updates
        for (const entry of update.entries ?? []) {
            const icon = { completed: "✓", in_progress: "→", pending: "○" }[entry.status] ?? "○";
            console.log(`${icon} ${entry.content}`);
        }
    }
});

await agent.run({
    prompt: "Explain quantum computing in 3 sentences",
});

await agent.kill();
