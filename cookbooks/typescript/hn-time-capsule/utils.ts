/**
 * Utilities for Hacker News Time Capsule pipeline.
 */

import { mkdirSync, writeFileSync } from "fs";

interface StepResult {
    meta: { itemIndex: number };
    status: string;
    files?: Record<string, string | Buffer>;
    data?: { toJSON?: () => object } | object;
    error?: string;
}

export function saveIntermediate(results: StepResult[], stepName: string): void {
    const stepDir = `intermediate/${stepName}`;
    mkdirSync(stepDir, { recursive: true });

    for (const r of results) {
        const itemDir = `${stepDir}/item_${r.meta.itemIndex.toString().padStart(2, "0")}`;
        mkdirSync(itemDir, { recursive: true });
        writeFileSync(`${itemDir}/status.txt`, r.status);

        // Save files (for fetch step: meta.json, article.txt, comments.json)
        if (r.files) {
            for (const [name, content] of Object.entries(r.files)) {
                if (Buffer.isBuffer(content)) {
                    writeFileSync(`${itemDir}/${name}`, content);
                } else {
                    writeFileSync(`${itemDir}/${name}`, content);
                }
            }
        }

        // Save structured data (for analyze step: data.json)
        if (r.data) {
            const dataObj = typeof (r.data as any).toJSON === "function"
                ? (r.data as any).toJSON()
                : r.data;
            writeFileSync(`${itemDir}/data.json`, JSON.stringify(dataObj, null, 2));
        }

        if (r.error) {
            writeFileSync(`${itemDir}/error.txt`, r.error);
        }
    }
}
