import type { AgentListFacts, ListAgentsOptions } from "./client.ts";

export type BackgroundCommandCountResult =
    | { readonly ok: true; readonly count: number }
    | { readonly ok: false; readonly reason: string };

export type ListAgents = (options?: ListAgentsOptions) => Promise<AgentListFacts>;

const PAGE_SIZE = 50;
const MAX_PAGES = 100;
const UNKNOWN = "Vera could not verify the background commands for that session.";

export async function backgroundCommandCount(
    listAgents: ListAgents,
    agentId: string,
): Promise<BackgroundCommandCountResult> {
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    try {
        for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
            const page = await listAgents({
                limit: PAGE_SIZE,
                order: "recent",
                ...(cursor === undefined ? {} : { cursor }),
            });
            if ((page.unavailable_workers?.length ?? 0) > 0) return { ok: false, reason: UNKNOWN };
            for (const entry of page.agents) {
                if (typeof entry !== "object" || entry === null) continue;
                const fields = entry as Record<string, unknown>;
                if (fields.id !== agentId) continue;
                if (fields.background_commands === undefined) return { ok: true, count: 0 };
                if (typeof fields.background_commands === "number"
                    && Number.isSafeInteger(fields.background_commands)
                    && fields.background_commands > 0) {
                    return { ok: true, count: fields.background_commands };
                }
                return { ok: false, reason: UNKNOWN };
            }
            cursor = page.next_cursor;
            if (cursor === undefined) break;
            if (seenCursors.has(cursor)) return { ok: false, reason: UNKNOWN };
            seenCursors.add(cursor);
            if (pageIndex === MAX_PAGES - 1) return { ok: false, reason: UNKNOWN };
        }
    } catch {
        return { ok: false, reason: UNKNOWN };
    }
    return { ok: false, reason: UNKNOWN };
}
