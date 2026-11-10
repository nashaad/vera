import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import {
    dirname,
    extname,
    isAbsolute,
    join,
    relative,
    resolve,
} from "node:path";
import { Lexer } from "marked";

export const PROJECT_INSTRUCTION_FILENAMES = [
    "AGENTS.md",
    "AGENTS.local.md",
] as const;

const MAX_FILE_BYTES = 128 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_IMPORT_HOPS = 4;
const MAX_IMPORT_CACHE_ENTRIES = 64;

interface CachedImports {
    readonly size: number;
    readonly mtimeMs: number;
    readonly content: string;
    readonly candidates: readonly string[];
}

const importCache = new Map<string, CachedImports>();

const TEXT_FILE_EXTENSIONS = new Set([
    ".md",
    ".txt",
    ".json",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".csv",
    ".html",
    ".css",
    ".js",
    ".ts",
    ".tsx",
    ".jsx",
    ".mjs",
    ".cjs",
    ".py",
    ".rb",
    ".go",
    ".rs",
    ".java",
    ".kt",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".cs",
    ".swift",
    ".sh",
    ".bash",
    ".zsh",
    ".fish",
    ".ps1",
    ".ini",
    ".cfg",
    ".conf",
    ".sql",
    ".graphql",
    ".proto",
    ".vue",
    ".svelte",
    ".astro",
    ".rst",
    ".org",
    ".lock",
    ".diff",
    ".patch",
]);

export interface ProjectInstructionFile {
    readonly name: string;
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

interface LoadState {
    readonly workspace: string;
    readonly workspaceRealPath: string;
    readonly files: ProjectInstructionFile[];
    readonly warnings: string[];
    readonly loadedPaths: Set<string>;
    totalBytes: number;
}

interface MarkdownToken {
    readonly type: string;
    readonly text?: string;
    readonly raw?: string;
    readonly tokens?: readonly MarkdownToken[];
    readonly items?: readonly MarkdownToken[];
}

export async function loadProjectInstructions(
    workspace: string,
): Promise<ProjectInstructionSnapshot> {
    const workspaceRealPath = await realpath(workspace).catch(() =>
        resolve(workspace)
    );
    const state: LoadState = {
        workspace: workspaceRealPath,
        workspaceRealPath,
        files: [],
        warnings: [],
        loadedPaths: new Set(),
        totalBytes: 0,
    };

    for (const name of PROJECT_INSTRUCTION_FILENAMES) {
        await loadInstructionFile(join(workspace, name), state, 0, true);
    }

    return {
        files: state.files,
        warnings: state.warnings,
    };
}

async function loadInstructionFile(
    path: string,
    state: LoadState,
    importHops: number,
    root: boolean,
): Promise<void> {
    let resolvedPath: string;
    try {
        resolvedPath = await realpath(path);
    } catch (error) {
        if (!root || !isMissingFile(error)) {
            state.warnings.push(
                `${displayPath(state.workspace, path)} could not be read: ${errorMessage(error)}`,
            );
        }
        return;
    }

    if (state.loadedPaths.has(resolvedPath)) {
        return;
    }
    if (!root && !isWithin(state.workspaceRealPath, resolvedPath)) {
        state.warnings.push(
            `${displayPath(state.workspace, path)} was not imported because it is outside the workspace`,
        );
        return;
    }
    if (!root && !isTextFile(resolvedPath)) {
        state.warnings.push(
            `${displayPath(state.workspace, path)} was not imported because its file type is not supported`,
        );
        return;
    }

    let bytes: Uint8Array;
    let size: number;
    let mtimeMs: number;
    try {
        const details = await stat(resolvedPath);
        if (!details.isFile()) {
            state.warnings.push(
                `${displayPath(state.workspace, path)} exists but is not a regular file`,
            );
            return;
        }
        if (details.size > MAX_FILE_BYTES) {
            state.warnings.push(
                `${displayPath(state.workspace, path)} is ${details.size} bytes; the ${MAX_FILE_BYTES}-byte limit was exceeded`,
            );
            return;
        }
        size = details.size;
        mtimeMs = details.mtimeMs;
        bytes = await readFile(resolvedPath);
        if (bytes.byteLength > MAX_FILE_BYTES) {
            state.warnings.push(
                `${displayPath(state.workspace, path)} grew beyond the ${MAX_FILE_BYTES}-byte limit while it was being read`,
            );
            return;
        }
    } catch (error) {
        state.warnings.push(
            `${displayPath(state.workspace, path)} could not be read: ${errorMessage(error)}`,
        );
        return;
    }

    if (state.totalBytes + bytes.byteLength > MAX_TOTAL_BYTES) {
        state.warnings.push(
            `${displayPath(state.workspace, path)} was omitted because project instructions exceed the ${MAX_TOTAL_BYTES}-byte total limit`,
        );
        return;
    }

    let content: string;
    try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        state.warnings.push(
            `${displayPath(state.workspace, path)} is not valid UTF-8 and was omitted`,
        );
        return;
    }

    state.loadedPaths.add(resolvedPath);
    state.totalBytes += bytes.byteLength;
    state.files.push({
        name: displayPath(state.workspace, resolvedPath),
        path: resolvedPath,
        content,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
    });

    const imports = cachedImportPaths(content, resolvedPath, size, mtimeMs);
    if (imports.length > 0 && importHops >= MAX_IMPORT_HOPS) {
        state.warnings.push(
            `${displayPath(state.workspace, path)} imports were skipped after ${MAX_IMPORT_HOPS} hops`,
        );
        return;
    }
    for (const importedPath of imports) {
        await loadInstructionFile(importedPath, state, importHops + 1, false);
    }
}

function cachedImportPaths(
    content: string,
    sourcePath: string,
    size: number,
    mtimeMs: number,
): readonly string[] {
    const cached = importCache.get(sourcePath);
    let candidates: readonly string[];
    // Rewrites can preserve size and mtime, so the decoded content must match too.
    if (cached !== undefined
        && cached.size === size
        && cached.mtimeMs === mtimeMs
        && cached.content === content) {
        importCache.delete(sourcePath);
        importCache.set(sourcePath, cached);
        candidates = cached.candidates;
    } else {
        candidates = extractImportCandidates(content);
        importCache.delete(sourcePath);
        if (importCache.size >= MAX_IMPORT_CACHE_ENTRIES) {
            const oldest = importCache.keys().next().value;
            if (oldest !== undefined) importCache.delete(oldest);
        }
        importCache.set(sourcePath, { size, mtimeMs, content, candidates });
    }
    // Resolve imports again so home-directory and symlink changes are observed.
    return [...new Set(candidates.map((path) => resolveImportPath(path, sourcePath)))];
}

function extractImportCandidates(
    content: string,
): readonly string[] {
    const tokens = new Lexer({ gfm: false }).lex(content);
    const imports = new Set<string>();

    function extract(text: string): void {
        const pattern = /(?:^|\s)@((?:[^\s\\]|\\ )+)/g;
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(text)) !== null) {
            let candidate = match[1];
            if (candidate === undefined) {
                continue;
            }
            const fragment = candidate.indexOf("#");
            if (fragment >= 0) {
                candidate = candidate.slice(0, fragment);
            }
            candidate = candidate.replaceAll("\\ ", " ");
            if (!isImportPath(candidate)) {
                continue;
            }
            imports.add(candidate);
        }
    }

    function visit(items: readonly MarkdownToken[]): void {
        for (const token of items) {
            if (token.type === "code" || token.type === "codespan") {
                continue;
            }
            if (token.type === "html") {
                const residue = (token.raw ?? "").replace(
                    /<!--[\s\S]*?-->/g,
                    "",
                );
                if (residue.trim().length > 0) {
                    extract(residue);
                }
                continue;
            }
            if (token.type === "text") {
                extract(token.text ?? "");
            }
            if (token.tokens !== undefined) {
                visit(token.tokens);
            }
            if (token.items !== undefined) {
                visit(token.items);
            }
        }
    }

    visit(tokens as readonly MarkdownToken[]);
    return [...imports];
}

function resolveImportPath(path: string, sourcePath: string): string {
    if (path.startsWith("~/")) {
        return resolve(homedir(), path.slice(2));
    }
    return isAbsolute(path) ? path : resolve(dirname(sourcePath), path);
}

function isImportPath(path: string): boolean {
    return path.startsWith("./")
        || path.startsWith("~/")
        || (path.startsWith("/") && path !== "/")
        || (!path.startsWith("@")
            && !/^[#%^&*()]+/.test(path)
            && /^[a-zA-Z0-9._-]/.test(path));
}

function isTextFile(path: string): boolean {
    const extension = extname(path).toLowerCase();
    return extension.length === 0 || TEXT_FILE_EXTENSIONS.has(extension);
}

function isWithin(parent: string, child: string): boolean {
    const path = relative(parent, child);
    return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function displayPath(workspace: string, path: string): string {
    const relativePath = relative(workspace, path);
    return relativePath.length > 0 && !relativePath.startsWith("..")
        ? relativePath
        : path;
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
