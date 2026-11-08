import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import { readSessionIndexMetadata } from "../store/session-store.ts";

export const SESSION_BLOCK_VERSION = 1;

export interface SessionBlockRecord {
    readonly version: typeof SESSION_BLOCK_VERSION;
    readonly session_id: string;
    readonly root_session_id: string;
    readonly blocked_at: string;
    readonly reason: string | null;
}

export type SessionBlockState =
    | { readonly status: "absent" }
    | { readonly status: "blocked"; readonly record: SessionBlockRecord }
    | { readonly status: "unreadable" };

export interface StoredSessionTree {
    readonly parents: ReadonlyMap<string, string>;
    readonly names: ReadonlyMap<string, string>;
}

export interface StoredSessionTreeRow {
    readonly id: string;
    readonly parent?: string;
    readonly name?: string;
    readonly order: number;
}

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function sessionBlockPath(directory: string, sessionId: string): string {
    if (!SESSION_ID.test(sessionId)) {
        throw new Error(`invalid session id for a block: ${sessionId}`);
    }
    return join(directory, `${sessionId}.json`);
}

// A file that exists blocks, even when its contents cannot be read.
export function isSessionBlockedSync(
    directory: string,
    sessionId: string,
): boolean {
    return existsSync(sessionBlockPath(directory, sessionId));
}

export async function readSessionBlock(
    directory: string,
    sessionId: string,
): Promise<SessionBlockState> {
    let text: string;
    try {
        text = await readFile(sessionBlockPath(directory, sessionId), "utf8");
    } catch (error) {
        if (isMissingFile(error)) return { status: "absent" };
        throw error;
    }
    const record = parseSessionBlockRecord(text);
    return record === undefined
        ? { status: "unreadable" }
        : { status: "blocked", record };
}

// An existing block is kept, so a second block never rewrites who blocked it.
export async function writeSessionBlock(
    directory: string,
    record: SessionBlockRecord,
): Promise<"written" | "already_blocked"> {
    const path = sessionBlockPath(directory, record.session_id);
    if (existsSync(path)) return "already_blocked";
    await mkdir(directory, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 4)}\n`, {
        flag: "wx",
    });
    await rename(temporary, path);
    return "written";
}

export async function removeSessionBlock(
    directory: string,
    sessionId: string,
): Promise<boolean> {
    const path = sessionBlockPath(directory, sessionId);
    if (!existsSync(path)) return false;
    await rm(path, { force: true });
    return true;
}

// Unreadable files are listed by id only; their root is unknown.
export async function listSessionBlocks(
    directory: string,
): Promise<readonly SessionBlockRecord[]> {
    let names: string[];
    try {
        names = readdirSync(directory);
    } catch (error) {
        if (isMissingFile(error)) return [];
        throw error;
    }
    const records: SessionBlockRecord[] = [];
    for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const state = await readSessionBlock(
            directory,
            name.slice(0, -".json".length),
        );
        if (state.status === "blocked") records.push(state.record);
    }
    return records;
}

export function blockedSessionMessage(sessionId: string): string {
    return `Session ${sessionId} is blocked. Nothing new runs in it until `
        + `'vera unblock ${sessionId}'.`;
}

// Reads every stored session header under the session directory.
export async function readStoredSessionTree(
    sessionDirectory: string,
): Promise<StoredSessionTree> {
    const parents = new Map<string, string>();
    const names = new Map<string, string>();
    for (const row of await readStoredSessionTreeShard(sessionDirectory)) {
        if (row.parent !== undefined) parents.set(row.id, row.parent);
        if (row.name !== undefined) names.set(row.id, row.name);
    }
    return { parents, names };
}

export async function readStoredSessionTreeShard(
    sessionDirectory: string,
    includePaths?: readonly string[],
    excludePaths: readonly string[] = [],
): Promise<readonly StoredSessionTreeRow[]> {
    const canonicalPaths = async (paths: readonly string[]): Promise<Set<string>> => new Set(await Promise.all(
        paths.map((path) => realpath(path).catch(() => resolve(path))),
    ));
    const included = includePaths === undefined ? undefined : await canonicalPaths(includePaths);
    const excluded = await canonicalPaths(excludePaths);
    let files: string[];
    try {
        files = readdirSync(sessionDirectory);
    } catch (error) {
        if (isMissingFile(error)) return [];
        throw error;
    }
    const rows: StoredSessionTreeRow[] = [];
    for (const [order, file] of files.entries()) {
        if (!file.endsWith(".jsonl")) continue;
        const path = join(sessionDirectory, file);
        if (included !== undefined || excluded.size > 0) {
            const canonical = await realpath(path).catch(() => resolve(path));
            if ((included !== undefined && !included.has(canonical)) || excluded.has(canonical)) continue;
        }
        let metadata;
        try {
            metadata = await readSessionIndexMetadata(path);
        } catch {
            continue;
        }
        const { header } = metadata;
        const parent = header.delegation?.parentId ?? header.parentId;
        rows.push({
            id: header.id, order,
            ...(parent === undefined ? {} : { parent }),
            ...(metadata.title === undefined ? {} : { name: metadata.title }),
        });
    }
    return rows;
}

// Breadth-first from the root. The root is always first, even when no header names it.
export function startedTreeOf(
    rootId: string,
    parents: ReadonlyMap<string, string>,
): readonly string[] {
    const children = new Map<string, string[]>();
    for (const [child, parent] of parents) {
        const list = children.get(parent) ?? [];
        list.push(child);
        children.set(parent, list);
    }
    const tree = [rootId];
    const seen = new Set(tree);
    for (const current of tree) {
        for (const child of children.get(current) ?? []) {
            if (seen.has(child)) continue;
            seen.add(child);
            tree.push(child);
        }
    }
    return tree;
}

export function parseSessionBlockRecord(
    text: string,
): SessionBlockRecord | undefined {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        return undefined;
    }
    if (typeof value !== "object" || value === null) return undefined;
    const record = value as Record<string, unknown>;
    if (
        record.version !== SESSION_BLOCK_VERSION
        || typeof record.session_id !== "string"
        || typeof record.root_session_id !== "string"
        || typeof record.blocked_at !== "string"
        || (record.reason !== null && typeof record.reason !== "string")
    ) {
        return undefined;
    }
    return {
        version: SESSION_BLOCK_VERSION,
        session_id: record.session_id,
        root_session_id: record.root_session_id,
        blocked_at: record.blocked_at,
        reason: record.reason ?? null,
    };
}

function isMissingFile(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}
