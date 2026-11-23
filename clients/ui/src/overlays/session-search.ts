import type { AgentListFacts } from "../protocol/client.ts";
import { sessionRows } from "../protocol/sessions.ts";
import { buildSessionItems, rankItems, type RankedItem } from "./palette.ts";

export function appendSessionMatches(
    loaded: readonly RankedItem[],
    listing: AgentListFacts,
    query: string,
    now: number,
): readonly RankedItem[] {
    const seen = new Set(loaded.map((entry) => entry.item.id));
    const result = [...loaded];
    const matches = rankItems(buildSessionItems(sessionRows(listing), now), query);
    for (const match of matches) {
        if (seen.has(match.item.id)) continue;
        seen.add(match.item.id);
        result.push(match);
    }
    return result;
}

export function scheduleSessionSearch(
    query: string,
    search: (query: string) => Promise<AgentListFacts>,
    onResult: (result: AgentListFacts | undefined) => void,
): () => void {
    let cancelled = false;
    const timer = setTimeout(() => {
        Promise.resolve().then(() => search(query)).then(
            (result) => { if (!cancelled) onResult(result); },
            () => { if (!cancelled) onResult(undefined); },
        );
    }, 150);
    return () => {
        cancelled = true;
        clearTimeout(timer);
    };
}
