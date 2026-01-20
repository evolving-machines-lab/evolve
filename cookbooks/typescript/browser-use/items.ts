/**
 * Items, run configuration, and result saving for browser-use cookbook.
 */

import * as fs from "fs";
import * as path from "path";
import { saveLocalDir, type FileMap, type PipelineResult } from "@evolvingmachines/sdk";
import type { HNPostResult } from "./schema";

interface RunDirResult {
    runDir: string;
    postsDir: string;
    startedAt: string;
}

export function buildItems(count: number = 3): FileMap[] {
    const items: FileMap[] = [];
    for (let rank = 1; rank <= count; rank++) {
        const page = Math.floor((rank - 1) / 30) + 1;
        const positionOnPage = ((rank - 1) % 30) + 1;
        items.push({
            "config.json": JSON.stringify({ rank, page, position_on_page: positionOnPage }),
        });
    }
    return items;
}

export function setupRunDir(items: FileMap[]): RunDirResult {
    const now = new Date();
    const startedAt = now
        .toISOString()
        .replace(/[-:]/g, "")
        .replace("T", "_")
        .slice(0, 15);

    const scriptDir = path.dirname(new URL(import.meta.url).pathname);
    const runDir = path.join(
        scriptDir,
        "output_browser_use",
        `hn_top_${items.length}_multimodal_${startedAt}`
    );
    const postsDir = path.join(runDir, "posts");
    fs.mkdirSync(postsDir, { recursive: true });

    fs.writeFileSync(
        path.join(runDir, "run_config.json"),
        JSON.stringify(
            {
                started_at: startedAt,
                count: items.length,
                concurrency: 4,
                mcp_server: "browser-use",
                target: "https://news.ycombinator.com/news",
            },
            null,
            2
        )
    );

    return { runDir, postsDir, startedAt };
}

export function saveResults(
    result: PipelineResult<HNPostResult>,
    items: FileMap[],
    postsDir: string,
    runDir: string,
    startedAt: string
): void {
    const stepResults = result.steps[0]?.results ?? [];
    const index: Record<string, unknown> = {
        started_at: startedAt,
        count: items.length,
        results: [] as unknown[],
    };

    for (let i = 0; i < stepResults.length; i++) {
        const r = stepResults[i];
        const cfg = JSON.parse(items[i]["config.json"] as string);
        const rank = cfg.rank as number;
        const postDir = path.join(postsDir, String(rank).padStart(3, "0"));

        saveLocalDir(postDir, r.files);

        const dataJson = r.data ?? null;
        if (dataJson) {
            fs.mkdirSync(postDir, { recursive: true });
            fs.writeFileSync(
                path.join(postDir, "data.json"),
                JSON.stringify(dataJson, null, 2)
            );
            if (dataJson.summary) {
                fs.writeFileSync(path.join(postDir, "summary.md"), dataJson.summary);
            }
        }

        (index.results as unknown[]).push({
            rank,
            status: r.status,
            data: dataJson,
            error: r.error,
        });
    }

    fs.writeFileSync(path.join(runDir, "index.json"), JSON.stringify(index, null, 2));
}
