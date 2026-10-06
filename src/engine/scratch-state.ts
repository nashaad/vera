import { readFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_TODO_BYTES = 2000;

export async function readScratchTodo(
    scratchDir: string,
): Promise<string | undefined> {
    let content: string;
    try {
        content = await readFile(join(scratchDir, "todo.md"), "utf8");
    } catch {
        return undefined;
    }
    if (content.trim().length === 0) {
        return undefined;
    }
    return content.length > MAX_TODO_BYTES
        ? `${content.slice(0, MAX_TODO_BYTES)}\n[truncated]`
        : content;
}

export function formatScratchTodo(scratchDir: string, todo: string): string {
    return `Your todo list, ${join(scratchDir, "todo.md")}, as it stands after compaction:\n\n${todo}`;
}
