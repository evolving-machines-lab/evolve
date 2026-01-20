/**
 * File Utilities
 *
 * Functions for reading and writing local files as FileMaps.
 */

import * as fs from "fs";
import * as path from "path";
import type { FileMap } from "../types";

/**
 * Read files from a local directory, returning a FileMap.
 *
 * @param localPath - Path to local directory
 * @param recursive - Read subdirectories recursively (default: false)
 * @returns FileMap with relative paths as keys
 *
 * @example
 * // Top-level files only (default)
 * readLocalDir('./folder')
 * // { "file.txt": Buffer }
 *
 * // Recursive - includes subdirectories
 * readLocalDir('./folder', true)
 * // { "file.txt": Buffer, "subdir/nested.txt": Buffer }
 */
export function readLocalDir(localPath: string, recursive = false): FileMap {
  const result: FileMap = {};

  function walk(dir: string, prefix: string): void {
    for (const entry of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, entry);
      const relativePath = prefix ? `${prefix}/${entry}` : entry;

      if (fs.statSync(fullPath).isDirectory()) {
        if (recursive) {
          walk(fullPath, relativePath);
        }
      } else {
        result[relativePath] = fs.readFileSync(fullPath);
      }
    }
  }

  walk(localPath, "");
  return result;
}

/**
 * Save a FileMap to a local directory, creating nested directories as needed.
 *
 * @param localPath - Base directory to save files to
 * @param files - FileMap to save (from getOutputFiles or other source)
 *
 * @example
 * // Save output files to local directory
 * const output = await agent.getOutputFiles(true);
 * saveLocalDir('./output', output.files);
 * // Creates: ./output/file.txt, ./output/subdir/nested.txt, etc.
 */
export function saveLocalDir(localPath: string, files: FileMap): void {
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(localPath, name);
    const dir = path.dirname(filePath);

    // Create parent directories if needed
    fs.mkdirSync(dir, { recursive: true });

    // Convert content to Buffer if needed
    let data: Buffer | string;
    if (content instanceof ArrayBuffer) {
      data = Buffer.from(content);
    } else if (content instanceof Uint8Array) {
      data = Buffer.from(content);
    } else {
      data = content as Buffer | string;
    }

    fs.writeFileSync(filePath, data);
  }
}
