import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Deliberately separate from `workspaceKey`. Event logs shard per checkout, so
 * they key on the raw cwd; memory is shared across a project's checkouts, so it
 * keys on the resolved instruction root. Same shape, different input, and
 * merging the two would silently give a worktree its own memory.
 */
export function memoryKey(instructionRoot: string): string {
    const flattened = instructionRoot.replace(/[^A-Za-z0-9]+/g, "-");
    return flattened.length === 0 ? "-" : flattened;
}

export const MEMORY_INDEX_FILENAME = "MEMORY.md";

/** Hard limits. The index is warned about earlier than it is refused. */
export const MEMORY_INDEX_MAX_BYTES = 8 * 1024;
export const MEMORY_INDEX_WARN_BYTES = 4 * 1024;
export const MEMORY_TOPIC_MAX_BYTES = 32 * 1024;

export function memoryRoot(): string {
    return join(homedir(), ".vera", "memory");
}

export function userMemoryDir(): string {
    return join(memoryRoot(), "user");
}

export function projectMemoryDir(instructionRoot: string): string {
    return join(memoryRoot(), "projects", memoryKey(instructionRoot));
}
