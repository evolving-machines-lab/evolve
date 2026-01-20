/**
 * 05 - Structured Output
 * Data extraction with Zod schema validation.
 */
import "dotenv/config";
import { Evolve } from "@evolvingmachines/sdk";
import { z } from "zod";

// Define expected output structure
const InvoiceSchema = z.object({
    vendor: z.string(),
    invoiceNumber: z.string(),
    date: z.string(),
    lineItems: z.array(z.object({
        description: z.string(),
        quantity: z.number(),
        unitPrice: z.number(),
        total: z.number(),
    })),
    subtotal: z.number(),
    tax: z.number(),
    total: z.number(),
});

const agent = new Evolve()
    // Schema instructs agent to write output/result.json matching structure
    .withSchema(InvoiceSchema)
    // Context files are uploaded to sandbox context/ folder
    .withContext({
        "invoice.txt": `
            ACME Corp Invoice #INV-2024-0042
            Date: December 15, 2024

            Widget Pro x3 @ $29.99 = $89.97
            Service Fee x1 @ $50.00 = $50.00

            Subtotal: $139.97
            Tax (8%): $11.20
            Total: $151.17
        `,
    });

await agent.run({
    prompt: "Extract the invoice data into structured JSON",
});

// output.data is typed and validated against InvoiceSchema
const output = await agent.getOutputFiles();
console.log(output.data);

await agent.kill();
