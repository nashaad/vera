import type { RegisteredAgentSummary } from "./agent-registry.ts";
import type { ListAgentsRequest } from "./protocol.ts";

export interface SessionListingPage {
    readonly agents: readonly RegisteredAgentSummary[];
    readonly next_cursor?: string;
    readonly total: number;
}

export function pageSessionListing(
    agents: readonly RegisteredAgentSummary[],
    request: Pick<ListAgentsRequest, "limit" | "cursor" | "order">,
): SessionListingPage {
    const ordered = request.order === "recent"
        ? [...agents].sort(byRecencyThenId)
        : agents;
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

function byRecencyThenId(
    left: RegisteredAgentSummary,
    right: RegisteredAgentSummary,
): number {
    const byTime = (right.updated_at ?? "").localeCompare(left.updated_at ?? "");
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
}
