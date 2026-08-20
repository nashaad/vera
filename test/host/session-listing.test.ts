import { expect, test } from "bun:test";

import type { RegisteredAgentSummary } from "../../src/host/agent-registry.ts";
import { pageSessionListing } from "../../src/host/session-listing.ts";

function agent(
    id: string,
    updatedAt?: string,
): RegisteredAgentSummary {
    return {
        id,
        workspace: "/workspace",
        session_path: `/sessions/${id}.jsonl`,
        kind: "interactive",
        status: "idle",
        live: false,
        ...(updatedAt === undefined ? {} : { updated_at: updatedAt }),
    };
}

const AGENTS = ["a", "b", "c", "d", "e"].map((id) => agent(id));

test("no limit serves the whole listing, which is the historic shape", () => {
    const page = pageSessionListing(AGENTS, {});
    expect(page.agents).toEqual(AGENTS);
    expect(page.next_cursor).toBeUndefined();
    expect(page.total).toBe(5);
});

test("paging walks the listing exactly once", () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard += 1) {
        const page = pageSessionListing(AGENTS, {
            limit: 2,
            ...(cursor === undefined ? {} : { cursor }),
        });
        seen.push(...page.agents.map((row) => row.id));
        expect(page.total).toBe(5);
        cursor = page.next_cursor;
        if (cursor === undefined) break;
    }
    expect(cursor).toBeUndefined();
    expect(seen).toEqual(["a", "b", "c", "d", "e"]);
});

test("the last page reports no cursor even when it is full", () => {
    const page = pageSessionListing(AGENTS.slice(0, 4), {
        limit: 2,
        cursor: "b",
    });
    expect(page.agents.map((row) => row.id)).toEqual(["c", "d"]);
    expect(page.next_cursor).toBeUndefined();
});

test("a cursor that left the listing restarts from the top", () => {
    const page = pageSessionListing(AGENTS, { limit: 2, cursor: "gone" });
    expect(page.agents.map((row) => row.id)).toEqual(["a", "b"]);
    expect(page.next_cursor).toBe("b");
});

test("recent order is newest first with the id breaking ties", () => {
    const page = pageSessionListing([
        agent("old", "2026-08-19T10:00:00.000Z"),
        agent("newest", "2026-08-20T10:00:00.000Z"),
        agent("undated"),
        agent("also-newest", "2026-08-20T10:00:00.000Z"),
    ], { order: "recent" });

    expect(page.agents.map((row) => row.id)).toEqual([
        "also-newest",
        "newest",
        "old",
        "undated",
    ]);
});

test("recent order keeps paging stable across the whole listing", () => {
    const listing = [
        agent("c", "2026-08-20T12:00:00.000Z"),
        agent("a", "2026-08-20T11:00:00.000Z"),
        agent("b", "2026-08-20T13:00:00.000Z"),
    ];
    const first = pageSessionListing(listing, { order: "recent", limit: 1 });
    expect(first.agents.map((row) => row.id)).toEqual(["b"]);
    const second = pageSessionListing(listing, {
        order: "recent",
        limit: 5,
        cursor: first.next_cursor!,
    });
    expect(second.agents.map((row) => row.id)).toEqual(["c", "a"]);
    expect(second.next_cursor).toBeUndefined();
});
