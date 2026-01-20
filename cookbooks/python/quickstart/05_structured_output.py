"""
05 - Structured Output
Data extraction with Pydantic schema validation.
"""
import asyncio
from dotenv import load_dotenv
from pydantic import BaseModel
from evolve import Evolve

load_dotenv()

# Define expected output structure
class LineItem(BaseModel):
    description: str
    quantity: int
    unit_price: float
    total: float

class InvoiceSchema(BaseModel):
    vendor: str
    invoice_number: str
    date: str
    line_items: list[LineItem]
    subtotal: float
    tax: float
    total: float

async def main():
    agent = Evolve(
        # Schema instructs agent to write output/result.json matching structure
        schema=InvoiceSchema,
        # Context files are uploaded to sandbox context/ folder
        context={
            "invoice.txt": """
                ACME Corp Invoice #INV-2024-0042
                Date: December 15, 2024

                Widget Pro x3 @ $29.99 = $89.97
                Service Fee x1 @ $50.00 = $50.00

                Subtotal: $139.97
                Tax (8%): $11.20
                Total: $151.17
            """,
        }
    )

    await agent.run(
        prompt="Extract the invoice data into structured JSON"
    )

    # output.data is typed and validated against InvoiceSchema
    output = await agent.get_output_files()
    print(output.data)

    await agent.kill()

if __name__ == "__main__":
    asyncio.run(main())
