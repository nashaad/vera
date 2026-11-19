import type { RegisteredAgentSummary } from "./agent-registry/support.ts";

export interface SessionArchiveIndex {
    rootAgentId(agentId: string): string | undefined;
    effectiveArchived(agentId: string): boolean;
    family(agentId: string): readonly RegisteredAgentSummary[];
}

export function createSessionArchiveIndex(
    summaries: readonly RegisteredAgentSummary[],
): SessionArchiveIndex {
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));
    const rootById = new Map<string, string>();

    const rootAgentId = (agentId: string): string | undefined => {
        const cached = rootById.get(agentId);
        if (cached !== undefined) return cached;
        if (!byId.has(agentId)) return undefined;

        const path: string[] = [];
        const position = new Map<string, number>();
        let currentId = agentId;
        while (true) {
            const known = rootById.get(currentId);
            if (known !== undefined) {
                currentId = known;
                break;
            }
            const cycleStart = position.get(currentId);
            if (cycleStart !== undefined) {
                let smallest = currentId;
                for (let index = cycleStart; index < path.length; index += 1) {
                    const candidate = path[index]!;
                    if (candidate < smallest) smallest = candidate;
                }
                currentId = smallest;
                break;
            }
            position.set(currentId, path.length);
            path.push(currentId);
            const parentId = byId.get(currentId)?.parent_id;
            if (parentId === undefined || !byId.has(parentId)) break;
            currentId = parentId;
        }
        for (const id of path) rootById.set(id, currentId);
        return currentId;
    };

    return {
        rootAgentId,
        effectiveArchived(agentId) {
            const rootId = rootAgentId(agentId);
            return rootId === undefined ? false : byId.get(rootId)?.archived === true;
        },
        family(agentId) {
            const rootId = rootAgentId(agentId);
            return rootId === undefined ? [] : summaries.filter((summary) => rootAgentId(summary.id) === rootId);
        },
    };
}
