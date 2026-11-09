import { open } from "node:fs/promises";

import { openSessionForRecovery, readSessionTurnState } from "../../store/session-store.ts";
import type { AgentRegistry } from "../agent-registry.ts";
import { withSessionReservation, type RestoringSessions } from "../session-host/storage.ts";

export interface CrashSessionPath {
    readonly path: string;
    readonly id: string;
}

export async function discoverCrashSession(path: string): Promise<CrashSessionPath | undefined> {
    const file = await open(path, "r").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
    });
    if (file === undefined) return undefined;
    try {
        const buffer = Buffer.alloc(64 * 1_024);
        let length = 0;
        let newline = -1;
        while (length < buffer.length && newline === -1) {
            const start = length;
            const { bytesRead } = await file.read(buffer, length, Math.min(4 * 1_024, buffer.length - length), length);
            if (bytesRead === 0) return undefined;
            length += bytesRead;
            const offset = buffer.subarray(start, length).indexOf(0x0a);
            if (offset !== -1) newline = start + offset;
        }
        if (newline === -1) return undefined;
        let header: unknown;
        try { header = JSON.parse(buffer.subarray(0, newline).toString("utf8")); }
        catch { return undefined; }
        if (typeof header !== "object" || header === null || Array.isArray(header)) return undefined;
        const value = header as Record<string, unknown>;
        if (value.type !== "session" || typeof value.id !== "string" || value.id.length === 0) return undefined;
        return { path, id: value.id };
    } finally {
        await file.close();
    }
}

export async function recoverCrashSession(options: {
    readonly session: CrashSessionPath;
    readonly registry: AgentRegistry;
    readonly reservations: RestoringSessions;
    readonly owns: (id: string) => Promise<boolean>;
    readonly record: (id: string) => Promise<void>;
    readonly signal: AbortSignal;
}): Promise<"done" | "changed"> {
    try {
        return await withSessionReservation(options.session.path, options.reservations, async (path) => {
            options.signal.throwIfAborted();
            const current = await discoverCrashSession(path);
            if (current === undefined) return "done";
            if (current.id !== options.session.id || !await options.owns(current.id)) return "changed";
            const { registry } = options;
            if (registry.agents.has(current.id) || registry.startingIds.has(current.id)
                || registry.trashingIds.has(current.id)) return "done";
            const state = await readSessionTurnState(path).catch(() => undefined);
            if (state === undefined || (!state.turnOpen && !state.needsQueueRecovery)) return "done";
            options.signal.throwIfAborted();
            await options.record(state.sessionId);
            options.signal.throwIfAborted();
            await openSessionForRecovery(path);
            return "done";
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "done";
        throw error;
    }
}
