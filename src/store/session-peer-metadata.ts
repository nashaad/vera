import { open, stat } from "node:fs/promises";
import { isApprovalMode, type ApprovalMode } from "../sdk/permissions.ts";

const CHUNK_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const IDENTITY_TYPE = Buffer.from('"session_identity"');
const FAILURE_TYPE = Buffer.from('"agent_failure"');
const PERMISSIONS_TYPE = Buffer.from('"permissions"');

export interface StoredPeerFacts {
    readonly name?: string;
    readonly failed: boolean;
}

const storedFacts = new WeakMap<object, StoredPeerFacts>();

export function rememberStoredPeerFacts(summary: object, facts: StoredPeerFacts): void {
    storedFacts.set(summary, facts);
}

export function storedPeerFacts(summary: object): StoredPeerFacts | undefined {
    return storedFacts.get(summary);
}

export async function readFinalSessionFailure(path: string, size: number): Promise<boolean> {
    const file = await open(path, "r");
    try {
        let position = size;
        const parts: Buffer[] = [];
        let trailingNewline = true;
        while (position > 0) {
            const length = Math.min(CHUNK_BYTES, position);
            position -= length;
            const chunk = Buffer.allocUnsafe(length);
            let read = 0;
            while (read < length) {
                const result = await file.read(chunk, read, length - read, position + read);
                if (result.bytesRead === 0) throw new Error(`Unexpected end of session file ${path}`);
                read += result.bytesRead;
            }
            let end = length;
            if (trailingNewline) {
                trailingNewline = false;
                if (chunk[end - 1] === 10) end -= 1;
            }
            const newline = chunk.lastIndexOf(10, end - 1);
            parts.push(chunk.subarray(newline + 1, end));
            if (newline !== -1) break;
        }
        try {
            const record: unknown = JSON.parse(Buffer.concat(parts.reverse()).toString("utf8"));
            if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
            const value = record as Record<string, unknown>;
            return value.type === "agent_failure" && typeof value.id === "string" && value.id.length > 0
                && typeof value.timestamp === "string" && !Number.isNaN(Date.parse(value.timestamp))
                && typeof value.detail === "string" && value.detail.trim().length > 0;
        } catch {
            return false;
        }
    } finally {
        await file.close();
    }
}

export interface SessionPeerMetadata {
    readonly name?: string;
    readonly failed: boolean;
    readonly approvalMode?: ApprovalMode;
}

interface IndexedPeerMetadata {
    readonly metadata: SessionPeerMetadata;
    readonly modified: number;
    readonly size: number;
}

const indexedPeerMetadata = new WeakMap<object, IndexedPeerMetadata>();

export function rememberSessionPeerMetadata(
    summary: object, metadata: SessionPeerMetadata, modified: number, size: number,
): void {
    indexedPeerMetadata.set(summary, { metadata, modified, size });
}

export async function sessionPeerMetadata(summary: object, path: string): Promise<SessionPeerMetadata> {
    const file = await stat(path);
    const cached = indexedPeerMetadata.get(summary);
    if (cached !== undefined && cached.modified === file.mtimeMs && cached.size === file.size) return cached.metadata;
    const metadata = await readSessionPeerMetadata(path);
    rememberSessionPeerMetadata(summary, metadata, file.mtimeMs, file.size);
    return metadata;
}

export async function readSessionPeerMetadata(path: string): Promise<SessionPeerMetadata> {
    const file = await open(path, "r");
    const chunk = Buffer.allocUnsafe(CHUNK_BYTES);
    let pending = Buffer.alloc(0);
    let oversized = false;
    let position = 0;
    let name: string | undefined;
    let approvalMode: ApprovalMode | undefined;
    let failed = false;
    const consume = (): void => {
        if (pending.length === 0) return;
        if (oversized) {
            const prefix = pending.toString("utf8");
            if (/^\s*\{\s*"type"\s*:\s*"agent_failure"/.test(prefix)) failed = true;
            if (/^\s*\{\s*"type"\s*:\s*"permissions"/.test(prefix)) approvalMode = "ask";
            return;
        }
        if (pending.indexOf(IDENTITY_TYPE) < 0 && pending.indexOf(FAILURE_TYPE) < 0 && pending.indexOf(PERMISSIONS_TYPE) < 0) return;
        try {
            const record: unknown = JSON.parse(pending.toString("utf8"));
            if (record !== null && typeof record === "object") {
                const value = record as Record<string, unknown>;
                if (name === undefined && value.type === "session_identity"
                    && typeof value.name === "string" && value.name.length > 0
                    && typeof value.key === "string" && value.key.length > 0
                    && typeof value.timestamp === "string") name = value.name;
                if (value.type === "agent_failure" && typeof value.id === "string"
                    && typeof value.timestamp === "string" && typeof value.detail === "string") failed = true;
                if (value.type === "permissions") approvalMode = isApprovalMode(value.mode) ? value.mode : "ask";
            }
        } catch {
        }
    };
    try {
        while (true) {
            const { bytesRead } = await file.read(chunk, 0, chunk.length, position);
            if (bytesRead === 0) break;
            position += bytesRead;
            let start = 0;
            while (start < bytesRead) {
                const newline = chunk.indexOf(10, start);
                const end = newline < 0 || newline >= bytesRead ? bytesRead : newline;
                const part = chunk.subarray(start, end);
                if (!oversized) {
                    if (pending.length + part.length > MAX_RECORD_BYTES) {
                        pending = Buffer.concat([pending, part.subarray(0, MAX_RECORD_BYTES - pending.length)]);
                        oversized = true;
                    } else {
                        pending = Buffer.concat([pending, part]);
                    }
                }
                if (end < bytesRead) {
                    consume();
                    pending = Buffer.alloc(0);
                    oversized = false;
                    start = end + 1;
                } else {
                    break;
                }
            }
        }
        consume();
        return { ...(name === undefined ? {} : { name }), failed,
            ...(approvalMode === undefined ? {} : { approvalMode }) };
    } finally {
        await file.close();
    }
}
