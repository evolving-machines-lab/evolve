/**
 * Utilities for CRE rent roll pipeline.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "fs";
import { join } from "path";

interface StepResult {
    meta: { itemIndex: number };
    status: string;
    data?: { toJSON?: () => object } | object;
    error?: string;
}

export function loadRentRolls(pdfDir: string): Record<string, Buffer>[] {
    // Clean previous run
    rmSync("intermediate", { recursive: true, force: true });
    rmSync("output", { recursive: true, force: true });

    const files = readdirSync(pdfDir)
        .filter((f) => f.endsWith(".pdf"))
        .sort();

    if (files.length === 0) {
        throw new Error(`No PDF files found in ${pdfDir}`);
    }

    const items: Record<string, Buffer>[] = [];
    for (let i = 0; i < files.length; i++) {
        const filename = files[i];
        const content = readFileSync(join(pdfDir, filename));
        items.push({ [filename]: content });
        console.log(`  [${i}] ${filename}`);
    }

    return items;
}

export function saveIntermediate(results: StepResult[], stepName: string): void {
    const stepDir = `intermediate/${stepName}`;
    mkdirSync(stepDir, { recursive: true });

    for (const r of results) {
        const itemDir = `${stepDir}/item_${r.meta.itemIndex.toString().padStart(2, "0")}`;
        mkdirSync(itemDir, { recursive: true });
        writeFileSync(`${itemDir}/status.txt`, r.status);

        if (r.data) {
            const dataObj =
                typeof (r.data as any).toJSON === "function"
                    ? (r.data as any).toJSON()
                    : r.data;
            writeFileSync(`${itemDir}/data.json`, JSON.stringify(dataObj, null, 2));
        }

        if (r.error) {
            writeFileSync(`${itemDir}/error.txt`, r.error);
        }
    }
}
