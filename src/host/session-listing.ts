import type { RegisteredAgentSummary } from "./agent-registry.ts";
import type { ListAgentsRequest } from "./protocol.ts";

export interface SessionListingPage {
    readonly agents: readonly RegisteredAgentSummary[];
    readonly next_cursor?: string;
    readonly total: number;
}

/**
 * Orders and slices a session listing.
 *
 * The cursor is the id of the last row served, not an offset: rows appear and
 * disappear between pages, and an offset would silently skip or repeat a
 * session when the roster changes mid-walk. An id that is no longer in the
 * listing restarts from the top rather than failing, because a caller paging
 * through a live roster cannot be asked to handle a vanished cursor.
 */
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

/** Newest first. Id breaks ties so the order is total and paging is stable. */
function byRecencyThenId(
    left: RegisteredAgentSummary,
    right: RegisteredAgentSummary,
): number {
    const byTime = (right.updated_at ?? "").localeCompare(left.updated_at ?? "");
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
}
