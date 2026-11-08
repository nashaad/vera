import type { RegisteredAgentSummary } from "../agent-registry.ts";

export type SessionOwner = "host" | "w0";

export function mergeRoster(
    master: readonly RegisteredAgentSummary[],
    worker: readonly RegisteredAgentSummary[],
    ownerOf: (id: string) => SessionOwner | undefined,
): RegisteredAgentSummary[] {
    const masterRows = new Map(master.map((row) => [row.id, row]));
    const workerRows = new Map(worker.map((row) => [row.id, row]));
    const ids = new Set([...masterRows.keys(), ...workerRows.keys()]);
    const merged: RegisteredAgentSummary[] = [];
    for (const id of ids) {
        const masterRow = masterRows.get(id);
        const workerRow = workerRows.get(id);
        const owner = ownerOf(id);
        const row = owner === "w0"
            ? workerRow
            : owner === "host"
                ? masterRow
                : workerRow?.live === true
                    ? workerRow
                    : masterRow ?? workerRow;
        if (row !== undefined) merged.push(row);
    }
    return merged.sort((left, right) => left.id.localeCompare(right.id));
}
