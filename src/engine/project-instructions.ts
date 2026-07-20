import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

export const PROJECT_INSTRUCTION_FILENAMES = [
    "AGENTS.md",
    "AGENTS.local.md",
] as const;

const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;

export interface ProjectInstructionFile {
    readonly name: typeof PROJECT_INSTRUCTION_FILENAMES[number];
    readonly path: string;
    readonly content: string;
    readonly bytes: number;
    readonly sha256: string;
}

export interface ProjectInstructionMetadata {
    readonly files: readonly {
        readonly name: string;
        readonly bytes: number;
        readonly sha256: string;
    }[];
    readonly warnings: readonly string[];
}

export interface ProjectInstructionSnapshot {
    readonly files: readonly ProjectInstructionFile[];
    readonly warnings: readonly string[];
}

export async function loadProjectInstructions(
    workspace: string,
): Promise<ProjectInstructionSnapshot> {
    const files: ProjectInstructionFile[] = [];
    const warnings: string[] = [];
    let totalBytes = 0;

    for (const name of PROJECT_INSTRUCTION_FILENAMES) {
        const path = join(workspace, name);
        let bytes: Uint8Array;
        try {
            const details = await stat(path);
            if (!details.isFile()) {
                warnings.push(`${name} exists but is not a regular file`);
                continue;
            }
            if (details.size > MAX_FILE_BYTES) {
                warnings.push(
                    `${name} is ${details.size} bytes; the ${MAX_FILE_BYTES}-byte limit was exceeded`,
                );
                continue;
            }
            bytes = await readFile(path);
            if (bytes.byteLength > MAX_FILE_BYTES) {
                warnings.push(
                    `${name} grew beyond the ${MAX_FILE_BYTES}-byte limit while it was being read`,
                );
                continue;
            }
        } catch (error) {
            if (isMissingFile(error)) {
                continue;
            }
            warnings.push(`${name} could not be read: ${errorMessage(error)}`);
            continue;
        }

        if (totalBytes + bytes.byteLength > MAX_TOTAL_BYTES) {
            warnings.push(
                `${name} was omitted because project instructions exceed the ${MAX_TOTAL_BYTES}-byte total limit`,
            );
            continue;
        }

        let content: string;
        try {
            content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
            warnings.push(`${name} is not valid UTF-8 and was omitted`);
            continue;
        }

        totalBytes += bytes.byteLength;
        files.push({
            name,
            path,
            content,
            bytes: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
        });
    }

    return {
        files,
        warnings,
    };
}

export function projectInstructionMetadata(
    snapshot: ProjectInstructionSnapshot,
): ProjectInstructionMetadata {
    return {
        files: snapshot.files.map(({ name, bytes, sha256 }) => ({
            name,
            bytes,
            sha256,
        })),
        warnings: [...snapshot.warnings],
    };
}

function isMissingFile(error: unknown): boolean {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
