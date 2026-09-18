import { open, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { probeImportSource, type ImportProbe } from "./index.ts";
import type { ImportSourceTool } from "./types.ts";

export interface ImportRoots {
    readonly claudeCode: string;
    readonly codex: string;
}

export interface ImportableSession {
    readonly tool: ImportSourceTool;
    readonly path: string;
    readonly sourceSessionId: string;
    readonly workspace: string;
    readonly updatedAt: string;
    readonly startedAt?: string;
    readonly title?: string;
    readonly firstMessage?: string;
}

export interface ImportableSessionList {
    readonly sessions: readonly ImportableSession[];
    // True when the listing stopped at the limit with files left unread.
    readonly truncated: boolean;
}

export interface ImportableSessionScannerOptions {
    readonly limit?: number;
    readonly headBytes?: number;
    readonly deepBytes?: number;
    readonly tailBytes?: number;
}

const DEFAULT_LIMIT = 200;
const HEAD_BYTES = 256 * 1024;
const DEEP_BYTES = 1024 * 1024;
const TAIL_BYTES = 64 * 1024;
const FIRST_LINE_BYTES = 64 * 1024;
const PREVIEW_CHARS = 200;
// Claude Code shortens longer folder names, so they cannot be matched by name.
const MAX_ENCODED_FOLDER = 200;

export function importRootsFrom(
    env: Readonly<Record<string, string | undefined>>,
    home: string = homedir(),
): ImportRoots {
    const claudeHome = nonEmpty(env.CLAUDE_CONFIG_DIR) ?? join(home, ".claude");
    const codexHome = nonEmpty(env.CODEX_HOME) ?? join(home, ".codex");
    return {
        claudeCode: join(claudeHome, "projects"),
        codex: join(codexHome, "sessions"),
    };
}

function nonEmpty(value: string | undefined): string | undefined {
    return value === undefined || value.length === 0 ? undefined : value;
}

// Claude Code names a project folder after its cwd with every
// non-alphanumeric character replaced by "-". Different paths can collide.
export function claudeCodeFolderName(cwd: string): string {
    return cwd.replaceAll(/[^a-zA-Z0-9]/g, "-");
}

interface Candidate {
    readonly tool: ImportSourceTool;
    readonly path: string;
    readonly mtimeMs: number;
    readonly size: number;
}

interface CachedFile {
    readonly mtimeMs: number;
    readonly size: number;
    // undefined: not read yet. null: read, and not a session.
    cwd?: string | null;
    probe?: ImportProbe | null;
}

// Lists sessions newest first. Reads only the start and end of each file,
// never writes, and remembers what it read until the file changes.
export class ImportableSessionScanner {
    private readonly roots: ImportRoots;
    private readonly limit: number;
    private readonly headBytes: number;
    private readonly deepBytes: number;
    private readonly tailBytes: number;
    private readonly cache = new Map<string, CachedFile>();

    constructor(roots: ImportRoots, options: ImportableSessionScannerOptions = {}) {
        this.roots = roots;
        this.limit = options.limit ?? DEFAULT_LIMIT;
        this.headBytes = options.headBytes ?? HEAD_BYTES;
        this.deepBytes = options.deepBytes ?? DEEP_BYTES;
        this.tailBytes = options.tailBytes ?? TAIL_BYTES;
    }

    async list(workspace?: string): Promise<ImportableSessionList> {
        const candidates = [
            ...await this.claudeCodeFiles(workspace),
            ...await this.codexFiles(),
        ].sort((left, right) => right.mtimeMs - left.mtimeMs);
        this.prune(candidates);

        const sessions: ImportableSession[] = [];
        for (let index = 0; index < candidates.length; index += 1) {
            if (sessions.length === this.limit) {
                return { sessions, truncated: true };
            }
            const candidate = candidates[index]!;
            const cached = this.cached(candidate);
            if (workspace !== undefined && candidate.tool === "codex") {
                if (cached.cwd === undefined) cached.cwd = await this.codexCwd(candidate.path);
                if (cached.cwd !== workspace) continue;
            }
            if (cached.probe === undefined) cached.probe = await this.probe(candidate);
            const probe = cached.probe;
            if (probe === null) continue;
            if (workspace !== undefined && probe.cwd !== workspace) continue;
            sessions.push(importableSession(candidate, probe));
        }
        return { sessions, truncated: false };
    }

    private cached(candidate: Candidate): CachedFile {
        const found = this.cache.get(candidate.path);
        if (found !== undefined && found.mtimeMs === candidate.mtimeMs && found.size === candidate.size) {
            return found;
        }
        const fresh: CachedFile = { mtimeMs: candidate.mtimeMs, size: candidate.size };
        this.cache.set(candidate.path, fresh);
        return fresh;
    }

    private prune(candidates: readonly Candidate[]): void {
        const present = new Set(candidates.map((candidate) => candidate.path));
        for (const path of this.cache.keys()) {
            if (!present.has(path)) this.cache.delete(path);
        }
    }

    private async claudeCodeFiles(workspace?: string): Promise<Candidate[]> {
        const folder = workspace === undefined ? undefined : claudeCodeFolderName(workspace);
        const matchByName = folder !== undefined && folder.length <= MAX_ENCODED_FOLDER;
        const projects = await visibleEntries(this.roots.claudeCode);
        const files: Candidate[] = [];
        for (const project of projects) {
            if (!project.isDirectory()) continue;
            if (matchByName && project.name !== folder) continue;
            const directory = join(this.roots.claudeCode, project.name);
            for (const entry of await visibleEntries(directory)) {
                if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
                const candidate = await candidateFor("claude-code", join(directory, entry.name));
                if (candidate !== undefined) files.push(candidate);
            }
        }
        return files;
    }

    // Codex keeps rollouts under sessions/YYYY/MM/DD/.
    private async codexFiles(): Promise<Candidate[]> {
        const files: Candidate[] = [];
        const walk = async (directory: string, depth: number): Promise<void> => {
            for (const entry of await visibleEntries(directory)) {
                const path = join(directory, entry.name);
                if (entry.isDirectory() && depth < 3) {
                    await walk(path, depth + 1);
                } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
                    const candidate = await candidateFor("codex", path);
                    if (candidate !== undefined) files.push(candidate);
                }
            }
        };
        await walk(this.roots.codex, 0);
        return files;
    }

    // The first line of a rollout is its session_meta, which holds the cwd.
    private async codexCwd(path: string): Promise<string | null> {
        const head = await readRange(path, 0, FIRST_LINE_BYTES);
        if (head === undefined) return null;
        const end = head.indexOf("\n");
        const probe = probeImportSource(end === -1 ? head : head.slice(0, end));
        return probe?.tool === "codex" && probe.subagent !== true ? probe.cwd : null;
    }

    private async probe(candidate: Candidate): Promise<ImportProbe | null> {
        const head = await readRange(candidate.path, 0, this.headBytes);
        if (head === undefined) return null;
        const tail = candidate.tool === "claude-code" && candidate.size > this.headBytes
            ? await readRange(
                candidate.path,
                Math.max(this.headBytes, candidate.size - this.tailBytes),
                this.tailBytes,
            ) ?? ""
            : "";
        let probe = probeImportSource(head, tail);
        if (probe !== undefined && probe.firstMessage === undefined && candidate.size > this.headBytes) {
            const deep = await readRange(candidate.path, 0, this.deepBytes);
            if (deep !== undefined) probe = probeImportSource(deep, tail) ?? probe;
        }
        if (probe === undefined || probe.subagent === true) return null;
        // A file read to the end with nothing typed in it has nothing to import.
        if (probe.firstMessage === undefined && candidate.size <= this.deepBytes) return null;
        return probe;
    }
}

async function visibleEntries(directory: string) {
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        return entries.filter((entry) => !entry.name.startsWith("."));
    } catch {
        return [];
    }
}

async function candidateFor(tool: ImportSourceTool, path: string): Promise<Candidate | undefined> {
    try {
        const info = await stat(path);
        return { tool, path, mtimeMs: info.mtimeMs, size: info.size };
    } catch {
        return undefined;
    }
}

async function readRange(path: string, position: number, length: number): Promise<string | undefined> {
    try {
        const file = await open(path, "r");
        try {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await file.read(buffer, 0, length, position);
            return buffer.toString("utf8", 0, bytesRead);
        } finally {
            await file.close();
        }
    } catch {
        return undefined;
    }
}

function importableSession(candidate: Candidate, probe: ImportProbe): ImportableSession {
    const firstMessage = probe.firstMessage === undefined
        ? undefined
        : Array.from(probe.firstMessage).slice(0, PREVIEW_CHARS).join("");
    return {
        tool: probe.tool,
        path: candidate.path,
        sourceSessionId: probe.sourceSessionId,
        workspace: probe.cwd,
        updatedAt: new Date(candidate.mtimeMs).toISOString(),
        ...(probe.startedAt === undefined ? {} : { startedAt: probe.startedAt }),
        ...(probe.title === undefined ? {} : { title: probe.title }),
        ...(firstMessage === undefined ? {} : { firstMessage }),
    };
}
