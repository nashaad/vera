import { compareSearchRank, MAX_SEARCH_RESULTS, type SessionSearchQuery, type SessionSearchResults } from "../../store/session-search.ts";
import type { SessionOwner } from "./roster.ts";
import type { SessionEndpoint } from "./session-endpoint.ts";

export async function searchAcrossOwners(
    endpoints: ReadonlyMap<SessionOwner, SessionEndpoint>, paths: ReadonlyMap<SessionOwner, readonly string[]>, query: SessionSearchQuery,
): Promise<SessionSearchResults> {
    const shards = await Promise.all([...endpoints.entries()].map(([owner, endpoint]) =>
        endpoint.searchShard(query, paths.get(owner) ?? [], [...paths.entries()].flatMap(([other, values]) =>
            other === owner ? [] : values
        ))
    ));
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
