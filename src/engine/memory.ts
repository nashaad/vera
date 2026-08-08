import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
    MEMORY_INDEX_FILENAME,
    MEMORY_INDEX_MAX_BYTES,
    MEMORY_INDEX_WARN_BYTES,
    projectMemoryDir,
    userMemoryDir,
} from "./memory-paths.ts";

/**
 * The directory a project's memory is keyed on, resolved once per agent by
 * the owner. `source` is `workspace` when the owner had no repository to
 * resolve, which is an ordinary case: a checkout is not required to run.
 */
export interface InstructionRoot {
    readonly path: string;
    readonly source: "git" | "workspace";
}

export type MemoryScope = "user" | "project";

export interface MemoryIndexFile {
    readonly scope: MemoryScope;
    readonly dir: string;
    readonly path: string;
    readonly content: string;
    readonly bytes: number;
    readonly sha256: string;
}

export interface MemoryMetadata {
    readonly files: readonly {
        readonly scope: MemoryScope;
        readonly bytes: number;
        readonly sha256: string;
    }[];
    readonly warnings: readonly string[];
}

/**
 * Where each scope's index lives. Defaulted from `memory-paths`; passed
 * explicitly only by callers that must not read the real home directory.
 */
export interface MemoryDirectories {
    readonly user: string;
    readonly project: string;
}

export interface MemorySnapshot {
    readonly files: readonly MemoryIndexFile[];
    readonly warnings: readonly string[];
}

/**
 * Reads the index of each scope and nothing else. Topic files are left for
 * the agent to read with the file tools when a hook in the index matches.
 */
export async function loadMemory(
    instructionRoot: InstructionRoot,
    directories: MemoryDirectories = {
        user: userMemoryDir(),
        project: projectMemoryDir(instructionRoot.path),
    },
): Promise<MemorySnapshot> {
    const files: MemoryIndexFile[] = [];
    const warnings: string[] = [];

    const rootMissing = !await isDirectory(instructionRoot.path);
    if (rootMissing) {
        warnings.push(
            `the instruction root ${instructionRoot.path} does not exist, `
                + "so no project memory was loaded",
        );
    }

    const scopes: readonly { scope: MemoryScope; dir: string }[] = [
        { scope: "user", dir: directories.user },
        ...(rootMissing
            ? []
            : [{ scope: "project" as const, dir: directories.project }]),
    ];

    for (const { scope, dir } of scopes) {
        const loaded = await loadIndex(scope, dir, warnings);
        if (loaded !== undefined) {
            files.push(loaded);
        }
    }

    if (
        instructionRoot.source === "workspace"
        && files.some((file) => file.scope === "project")
    ) {
        warnings.push(
            `project memory is keyed on ${instructionRoot.path}, which is `
                + "not a git repository",
        );
    }

    return { files, warnings };
}

export function memoryMetadata(snapshot: MemorySnapshot): MemoryMetadata {
    return {
        files: snapshot.files.map(({ scope, bytes, sha256 }) => ({
            scope,
            bytes,
            sha256,
        })),
        warnings: [...snapshot.warnings],
    };
}

async function loadIndex(
    scope: MemoryScope,
    dir: string,
    warnings: string[],
): Promise<MemoryIndexFile | undefined> {
    const label = `the ${scope} memory index`;
    const path = join(dir, MEMORY_INDEX_FILENAME);
    let bytes: Uint8Array;
    try {
        const details = await stat(path);
        if (!details.isFile()) {
            warnings.push(`${label} exists but is not a regular file`);
            return undefined;
        }
        if (details.size > MEMORY_INDEX_MAX_BYTES) {
            warnings.push(
                `${label} is ${details.size} bytes; the `
                    + `${MEMORY_INDEX_MAX_BYTES}-byte limit was exceeded`,
            );
            return undefined;
        }
        bytes = await readFile(path);
        if (bytes.byteLength > MEMORY_INDEX_MAX_BYTES) {
            warnings.push(
                `${label} grew beyond the ${MEMORY_INDEX_MAX_BYTES}-byte `
                    + "limit while it was being read",
            );
            return undefined;
        }
    } catch (error) {
        if (isMissingFile(error)) {
            return undefined;
        }
        warnings.push(`${label} could not be read: ${errorMessage(error)}`);
        return undefined;
    }

    let content: string;
    try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        warnings.push(`${label} is not valid UTF-8 and was omitted`);
        return undefined;
    }

    if (bytes.byteLength > MEMORY_INDEX_WARN_BYTES) {
        warnings.push(
            `${label} is ${bytes.byteLength} bytes; it is refused past `
                + `${MEMORY_INDEX_MAX_BYTES} bytes, so move detail into `
                + "topic files",
        );
    }

    return {
        scope,
        dir,
        path,
        content,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    };
}

async function isDirectory(path: string): Promise<boolean> {
    try {
        return (await stat(path)).isDirectory();
    } catch {
        return false;
    }
}

function isMissingFile(error: unknown): boolean {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR";
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
