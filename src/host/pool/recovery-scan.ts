import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { defaultSessionDirectory, readSessionHeader, SessionStore } from "../../store/session-store.ts";
import type { RegisteredAgentSummary } from "../agent-registry.ts";
import { sessionShardIndex } from "../shard.ts";
import { indexStoredSession, withSessionReservation, type RestoringSessions } from "../session-host/storage.ts";
import type { RoutedSession } from "./session-endpoint.ts";

export async function recoverUnownedSessions(options: {
    readonly home: string;
    readonly directory?: string;
    readonly reservations: RestoringSessions;
    readonly residents: readonly RoutedSession[];
    readonly index: number;
    readonly count: number;
    readonly remember: (summary: RegisteredAgentSummary) => void;
}): Promise<void> {
    const directory = options.directory ?? defaultSessionDirectory(options.home);
    const names = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
    });
    const protectedIds = new Set(options.residents.map((session) => session.id));
    const protectedPaths = new Set(options.residents.map((session) => session.sessionPath));
    for (const name of names.filter((value) => value.endsWith(".jsonl")).sort()) {
        const id = name.slice(0, -6);
        const path = join(directory, name);
        if (protectedIds.has(id) || protectedPaths.has(path) || sessionShardIndex(id, options.count) !== options.index) continue;
        try {
            const header = await readSessionHeader(path);
            if (header.id !== id || protectedIds.has(header.id)) continue;
            await withSessionReservation(path, options.reservations, async (canonical) => {
                if (protectedPaths.has(canonical)) return;
                const store = await SessionStore.open(canonical);
                if (!await store.repairCrashedTurn({ workerExited: true })) return;
                const indexed = new Map<string, RegisteredAgentSummary>();
                await indexStoredSession(canonical, indexed);
                const summary = indexed.get(id);
                if (summary !== undefined) options.remember(summary);
            });
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
}
