import type { RegisteredAgentSummary } from "./agent-registry.ts";
import type { ListAgentsRequest } from "./protocol.ts";

export interface SessionListingPage {
    readonly agents: readonly RegisteredAgentSummary[];
    readonly next_cursor?: string;
    readonly total: number;
}

export function pageSessionListing(
    agents: readonly RegisteredAgentSummary[],
    request: Pick<ListAgentsRequest, "limit" | "cursor" | "order" | "query">,
): SessionListingPage {
    const filtered = request.query === undefined
        ? agents
        : filterSessionListing(agents, request.query);
    const ordered = request.order === "recent"
        ? [...filtered].sort(byRecencyThenId)
        : filtered;
    const start = request.cursor === undefined
        ? 0
        : ordered.findIndex((agent) => agent.id === request.cursor) + 1;
    const from = start <= 0 ? 0 : start;
    const rows = request.limit === undefined
        ? ordered.slice(from)
        : ordered.slice(from, from + request.limit);
    const last = rows.at(-1);
    const exhausted = last === undefined || from + rows.length >= ordered.length;
    return {
        agents: rows,
        ...(exhausted ? {} : { next_cursor: last!.id }),
        total: ordered.length,
    };
}

function filterSessionListing(
    agents: readonly RegisteredAgentSummary[],
    query: string,
): readonly RegisteredAgentSummary[] {
    const words = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
    if (words.length === 0) return agents;
    return agents.filter((agent) => {
        const workspace = agent.workspace.replace(/[\\/]+$/u, "");
        const folder = workspace.split(/[\\/]/u).at(-1) ?? "";
        const fields = [agent.title, agent.name, folder]
            .filter((value): value is string => typeof value === "string")
            .map((value) => value.toLowerCase());
        return words.every((word) => fields.some((field) => field.includes(word)));
    });
}

function byRecencyThenId(
    left: RegisteredAgentSummary,
    right: RegisteredAgentSummary,
): number {
    const byTime = (right.updated_at ?? "").localeCompare(left.updated_at ?? "");
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
}
