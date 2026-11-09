import type { RegisteredAgentSummary } from "../agent-registry.ts";

export type WorkerOwner = `w${number}`;
export type SessionOwner = "host" | WorkerOwner;

export function mergeRoster(
    host: readonly RegisteredAgentSummary[],
    worker: readonly RegisteredAgentSummary[],
    ownerOf: (id: string) => SessionOwner | undefined,
): RegisteredAgentSummary[] {
    return mergeRosters([["host", host], ["w0", worker]], ownerOf);
}

export function mergeRosters(
    rosters: readonly (readonly [SessionOwner, readonly RegisteredAgentSummary[]])[],
    ownerOf: (id: string) => SessionOwner | undefined,
): RegisteredAgentSummary[] {
    const rows = new Map(rosters.map(([owner, roster]) => [owner, new Map(roster.map((row) => [row.id, row]))]));
    const ids = new Set(rosters.flatMap(([, roster]) => roster.map((row) => row.id)));
    const merged: RegisteredAgentSummary[] = [];
    for (const id of ids) {
        const owner = ownerOf(id);
        const candidates = rosters.flatMap(([candidate]) => {
            const row = rows.get(candidate)?.get(id);
            return row === undefined ? [] : [row];
        });
        const row = owner === undefined
            ? candidates.find((candidate) => candidate.live === true) ?? candidates[0]
            : rows.get(owner)?.get(id);
        if (row !== undefined) merged.push(row);
    }
    return merged.sort((left, right) => left.id.localeCompare(right.id));
}
