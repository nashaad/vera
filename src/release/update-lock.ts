import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { processIsAlive } from "../host/process-identity.ts";
import { veraShareRoot } from "./layout.ts";

// A holder that outlives this is taken to be a PID the OS reused.
const MAX_HOLD_MS = 6 * 60 * 60 * 1_000;

interface LockRecord {
    readonly pid: number;
    readonly token: string;
    readonly created_at: string;
}

export class UpdateInProgressError extends Error {
    constructor(readonly holderPid?: number) {
        super(
            "Another vera update or rollback is running"
            + `${holderPid === undefined ? "" : ` (PID ${holderPid})`}. Wait for it to finish, then run the command again.`,
        );
        this.name = "UpdateInProgressError";
    }
}

export function updateLockPath(prefix: string): string {
    return join(veraShareRoot(prefix), ".update.lock");
}

export interface UpdateLockOptions {
    readonly isAlive?: (pid: number) => boolean;
    readonly now?: () => number;
}

// One update or rollback at a time per install. A lock left by a process that died is taken over.
// Returns the call that gives it up.
export function acquireUpdateLock(prefix: string, options: UpdateLockOptions = {}): () => void {
    const isAlive = options.isAlive ?? processIsAlive;
    const now = options.now ?? Date.now;
    const path = updateLockPath(prefix);
    mkdirSync(veraShareRoot(prefix), { recursive: true, mode: 0o755 });
    const record: LockRecord = { pid: process.pid, token: randomUUID(), created_at: new Date(now()).toISOString() };
    const source = `${JSON.stringify(record)}\n`;
    // The file reaches its name already whole, so no reader sees it half written.
    const temporary = `${path}.${record.token}.tmp`;
    writeFileSync(temporary, source, { mode: 0o600 });
    try {
        for (;;) {
            try {
                linkSync(temporary, path);
                return () => removeIfOwned(path, record.token);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            }
            const held = readLock(path);
            if (held === "missing") continue;
            if (held.record !== undefined && isAlive(held.record.pid)
                && now() - Date.parse(held.record.created_at) <= MAX_HOLD_MS) {
                throw new UpdateInProgressError(held.record.pid);
            }
            removeIfUnchanged(path, held.source);
        }
    } finally {
        try {
            unlinkSync(temporary);
        } catch {
        }
    }
}

function readLock(path: string): { readonly source: string; readonly record?: LockRecord } | "missing" {
    let source: string;
    try {
        source = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
        throw error;
    }
    try {
        const value = JSON.parse(source) as Partial<LockRecord> | null;
        if (
            value !== null && typeof value === "object"
            && Number.isInteger(value.pid) && (value.pid as number) > 0
            && typeof value.token === "string"
            && typeof value.created_at === "string" && !Number.isNaN(Date.parse(value.created_at))
        ) {
            return { source, record: value as LockRecord };
        }
    } catch {
    }
    return { source };
}

function removeIfUnchanged(path: string, source: string): void {
    const current = readLock(path);
    if (current === "missing" || current.source !== source) return;
    try {
        unlinkSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

function removeIfOwned(path: string, token: string): void {
    const current = readLock(path);
    if (current === "missing" || current.record?.token !== token) return;
    try {
        unlinkSync(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}
