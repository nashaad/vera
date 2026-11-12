import { useEffect, useMemo, useSyncExternalStore } from "react";

import { useRouter } from "../pages/router.tsx";
import { type SessionRow, type SessionStatus } from "../protocol/sessions.ts";
import { useViewEnvironment } from "../views/env.tsx";

// Sessions that settled in this window stay listed as finished, then drop off.
export const FINISHED_WINDOW_MS = 60 * 60_000;

// The most finished sessions kept at once; the oldest goes first.
export const FINISHED_LIMIT = 50;

export interface FinishedEntry {
    readonly agentId: string;
    readonly name: string;
    readonly workspace: string;
    readonly chat: boolean;
    readonly status: SessionStatus;
    readonly finishedAt: number;
}

const ACTIVE: ReadonlySet<SessionStatus> = new Set<SessionStatus>(["working", "waiting"]);

// Only what this window saw happen is recorded; a session already idle when the window opened is not.
export class FinishedSessions {
    private readonly entries = new Map<string, FinishedEntry>();
    private statuses = new Map<string, SessionStatus>();

    // Compares each row with the status it had at the previous call. Rows missing from this call
    // have no previous status at the next one, so a session that drops out and returns is not
    // recorded as finished.
    observe(rows: readonly SessionRow[], now: number, viewing: string | undefined): boolean {
        const next = new Map<string, SessionStatus>();
        let changed = false;
        for (const row of rows) {
            next.set(row.id, row.status);
            const before = this.statuses.get(row.id);
            if (before === undefined || !ACTIVE.has(before) || ACTIVE.has(row.status)) continue;
            if (row.id === viewing) continue;
            this.entries.set(row.id, {
                agentId: row.id,
                name: row.name,
                workspace: row.workspace,
                chat: row.chat,
                status: row.status,
                finishedAt: now,
            });
            changed = true;
        }
        this.statuses = next;
        this.trim();
        return changed;
    }

    seen(agentId: string): boolean {
        return this.entries.delete(agentId);
    }

    // Entries older than the window are forgotten here, so the map only holds what can still be listed.
    list(now: number): readonly FinishedEntry[] {
        const kept: FinishedEntry[] = [];
        for (const [agentId, entry] of this.entries) {
            if (now - entry.finishedAt >= FINISHED_WINDOW_MS) {
                this.entries.delete(agentId);
                continue;
            }
            kept.push(entry);
        }
        return kept.sort((left, right) => right.finishedAt - left.finishedAt);
    }

    private trim(): void {
        while (this.entries.size > FINISHED_LIMIT) {
            let oldest: FinishedEntry | undefined;
            for (const entry of this.entries.values()) {
                if (oldest === undefined || entry.finishedAt < oldest.finishedAt) oldest = entry;
            }
            if (oldest === undefined) return;
            this.entries.delete(oldest.agentId);
        }
    }
}

const finishedSessions = new FinishedSessions();
let version = 0;
const listeners = new Set<() => void>();

function notify(): void {
    version += 1;
    for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

function currentVersion(): number {
    return version;
}

// The finished sessions still inside the window at `now`. The list is recomputed when the store
// changes or when the caller's clock moves on.
export function useFinished(now: number): readonly FinishedEntry[] {
    const current = useSyncExternalStore(subscribe, currentVersion);
    return useMemo(() => finishedSessions.list(now), [current, now]);
}

// Records the sessions that settle while the window is open, and clears the one on screen.
export function useTrackFinished(): void {
    const { connection } = useViewEnvironment();
    const { route } = useRouter();
    const rows = connection.sessionRows;
    const viewing = route.kind === "session" ? route.agentId : undefined;
    useEffect(() => {
        if (rows === undefined) return;
        if (finishedSessions.observe(rows, Date.now(), viewing)) notify();
    }, [rows, viewing]);
    useEffect(() => {
        if (viewing === undefined) return;
        if (finishedSessions.seen(viewing)) notify();
    }, [viewing]);
}
