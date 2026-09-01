import { homedir } from "node:os";
import { join } from "node:path";
import { veraProfileDirectory } from "../profile-paths.ts";

export function memoryKey(instructionRoot: string): string {
    const flattened = instructionRoot.replace(/[^A-Za-z0-9]+/g, "-");
    return flattened.length === 0 ? "-" : flattened;
}

export const MEMORY_INDEX_FILENAME = "MEMORY.md";

export const MEMORY_INDEX_MAX_BYTES = 8 * 1024;
export const MEMORY_INDEX_WARN_BYTES = 4 * 1024;
export const MEMORY_TOPIC_MAX_BYTES = 32 * 1024;

export function memoryRoot(): string {
    return join(veraProfileDirectory(), "memory");
}

export function userMemoryDir(): string {
    return join(memoryRoot(), "user");
}

export function projectMemoryDir(instructionRoot: string): string {
    return join(memoryRoot(), "projects", memoryKey(instructionRoot));
}
