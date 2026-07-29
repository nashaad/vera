import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_LISTED_FILES = 20;
const MAX_TODO_BYTES = 2000;

export interface ScratchStateSnapshot {
    /** Entry names, capped at MAX_LISTED_FILES. */
    readonly files: readonly string[];
    /** How many entries the cap hid. */
    readonly truncatedFiles: number;
    /** Contents of todo.md, capped at MAX_TODO_BYTES. */
    readonly todo?: string;
}

/**
 * Snapshots the scratch directory for the contextual prompt. An unreadable
 * directory reads as absent rather than failing the turn: the scratch dir is
 * an affordance, not a dependency.
 */
export async function loadScratchState(
    scratchDir: string,
): Promise<ScratchStateSnapshot | undefined> {
    let entries: string[];
    try {
        entries = (await readdir(scratchDir)).sort();
    } catch {
        return undefined;
    }
    if (entries.length === 0) {
        return undefined;
    }
    const files = entries.slice(0, MAX_LISTED_FILES);
    let todo: string | undefined;
    if (entries.includes("todo.md")) {
        try {
            const content = await readFile(join(scratchDir, "todo.md"), "utf8");
            todo = content.length > MAX_TODO_BYTES
                ? `${content.slice(0, MAX_TODO_BYTES)}\n[truncated]`
                : content;
        } catch {
            todo = undefined;
        }
    }
    return {
        files,
        truncatedFiles: entries.length - files.length,
        ...(todo === undefined ? {} : { todo }),
    };
}
