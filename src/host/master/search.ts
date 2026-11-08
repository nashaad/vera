import { compareSearchRank, MAX_SEARCH_RESULTS, type SessionSearchQuery, type SessionSearchResults } from "../../store/session-search.ts";
import type { SessionEndpoint } from "./session-endpoint.ts";

export async function searchAcrossOwners(
    master: SessionEndpoint, worker: SessionEndpoint, masterPaths: readonly string[], query: SessionSearchQuery,
): Promise<SessionSearchResults> {
    const shards = await Promise.all([
        master.searchShard(query, masterPaths),
        worker.searchShard(query, undefined, masterPaths),
    ]);
    const ranked = shards.flatMap((shard) => shard.results).sort((left, right) => compareSearchRank(left.rank, right.rank));
    const selected = ranked.slice(0, MAX_SEARCH_RESULTS);
    const last = selected.at(-1)?.rank;
    return {
        results: selected.map((entry) => entry.result),
        truncated: ranked.length > MAX_SEARCH_RESULTS || shards.some((shard) => shard.truncated
            || (selected.length === MAX_SEARCH_RESULTS && last !== undefined && shard.lastFile !== undefined
                && compareSearchRank(last, shard.lastFile) < 0)),
    };
}
