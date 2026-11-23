import { expect, test } from "bun:test";

import type { AgentListFacts } from "../../clients/ui/src/protocol/client.ts";
import { canShowMoreSessions, loadSessionTailPage, mergeSessionRows, relativeTime, sessionCursor, sessionPageOptions, sessionRows, SESSIONS_PAGE_SIZE } from "../../clients/ui/src/protocol/sessions.ts";
import { SessionPager } from "../../clients/ui/src/state/sessionPager.ts";

test("@core merged session pages deduplicate by id, with the first page winning", () => {
    const first = sessionRows({ agents: [{ id: "recent", title: "New title" }, { id: "middle" }] });
    const tail = sessionRows({ agents: [{ id: "middle", title: "Stale title" }, { id: "older" }] });
    expect(mergeSessionRows(first, tail).map((row) => [row.id, row.name])).toEqual([
        ["recent", "New title"],
        ["middle", "middle"],
        ["older", "older"],
    ]);
});

test("@core a duplicate cursor page follows next_cursor until new rows arrive", async () => {
    const first = sessionRows({ agents: [{ id: "a" }, { id: "b" }] });
    const cursors: string[] = [];
    const result = await loadSessionTailPage(first, [], "b", 3, async (cursor) => {
        cursors.push(cursor);
        return cursors.length === 1
            ? { agents: [{ id: "b" }], next_cursor: "b-duplicate", total: 4 }
            : { agents: [{ id: "c" }, { id: "d" }], next_cursor: "d-next", total: 4 };
    });
    expect(cursors).toEqual(["b", "b-duplicate"]);
    expect(result.rows.map((row) => row.id)).toEqual(["c", "d"]);
    expect(result.nextCursor).toBe("d-next");
});

test("@core a page deduplicates duplicate ids within the response and keeps the first row", async () => {
    const first = sessionRows({ agents: [{ id: "a" }] });
    const result = await loadSessionTailPage(first, [], "a", 1, async () => ({
        agents: [{ id: "b", title: "First" }, { id: "b", title: "Second" }],
        next_cursor: "b-next",
    }));
    expect(result.rows.map((row) => [row.id, row.name])).toEqual([["b", "First"]]);
});

test("reconnect paging restores the prior tail length across multiple pages", async () => {
    const first = sessionRows({ agents: [{ id: "a" }, { id: "b" }] });
    let page = 0;
    const result = await loadSessionTailPage(first, [], "b", 4, async (cursor) => {
        page += 1;
        return page === 1
            ? { agents: [{ id: "b" }, { id: "c" }], next_cursor: "c-next", total: 7 }
            : { agents: [{ id: "d" }, { id: "e" }], next_cursor: "e-next", total: 7 };
    }, 3);
    expect(result.rows.map((row) => row.id)).toEqual(["c", "d", "e"]);
    expect(result.pages).toBe(2);
    expect(result.nextCursor).toBe("e-next");
});

test("@core the next cursor is the last shown row id and Show more ends with the listing", () => {
    const rows = sessionRows({ agents: [{ id: "first" }, { id: "last-shown" }] });
    expect(sessionCursor(rows)).toBe("last-shown");
    expect(SESSIONS_PAGE_SIZE).toBe(50);
    expect(sessionPageOptions()).toEqual({ limit: 50, order: "recent" });
    expect(sessionPageOptions("tail-row")).toEqual({ limit: 50, order: "recent", cursor: "tail-row" });
    expect(canShowMoreSessions(101, 100, "next")).toBe(true);
    expect(canShowMoreSessions(101, 101, undefined)).toBe(false);
    expect(canShowMoreSessions(101, 100, undefined)).toBe(false);
});

test("@core a poll landing during Show more updates the first page without losing the new tail", async () => {
    const pager = new SessionPager();
    pager.applyFirstPage({ agents: [{ id: "a" }, { id: "b" }], next_cursor: "b", total: 5 });
    const page = deferred<AgentListFacts>();
    const loading = pager.loadMore(async () => page.promise);
    const poll = pager.applyFirstPage({ agents: [{ id: "new-a" }, { id: "b" }], next_cursor: "b", total: 5 });
    expect(poll.rows.map((row) => row.id)).toEqual(["new-a", "b"]);
    page.resolve({ agents: [{ id: "c" }], next_cursor: "c", total: 5 });
    const update = await loading;
    expect(update?.rows.map((row) => row.id)).toEqual(["new-a", "b", "c"]);
});

test("@core restore publishes the fresh first page with the old tail before swapping in restored rows", async () => {
    const pager = new SessionPager();
    pager.applyFirstPage({ agents: [{ id: "a" }, { id: "b" }], next_cursor: "b", total: 6 });
    await pager.loadMore(async () => ({ agents: [{ id: "old-c" }, { id: "old-d" }], next_cursor: "old-d", total: 6 }));
    pager.invalidate();
    pager.applyFirstPage({ agents: [{ id: "a-new" }, { id: "b" }], next_cursor: "b", total: 6 });
    const firstPage = deferred<AgentListFacts>();
    const tailPage = deferred<AgentListFacts>();
    const updates: string[][] = [];
    const restoring = pager.restoreTail(async () => firstPage.promise, async () => tailPage.promise, 2, (update) => {
        updates.push(update.rows.map((row) => row.id));
    });
    expect(pager.isBusy).toBe(true);
    expect(await pager.loadMore(async () => ({ agents: [{ id: "wrong" }] }))).toBeUndefined();
    const poll = pager.applyFirstPage({ agents: [{ id: "poll-a" }, { id: "b" }], next_cursor: "b", total: 6 });
    expect(poll.rows.map((row) => row.id)).toEqual(["poll-a", "b", "old-c", "old-d"]);
    firstPage.resolve({ agents: [{ id: "fresh-a" }, { id: "b" }], next_cursor: "b", total: 6 });
    await Promise.resolve();
    await Promise.resolve();
    expect(updates).toEqual([["fresh-a", "b", "old-c", "old-d"]]);
    const duringRestore = pager.applyFirstPage({ agents: [{ id: "poll-a" }, { id: "b" }], next_cursor: "b", total: 6 });
    expect(duringRestore.rows.map((row) => row.id)).toEqual(["poll-a", "b", "old-c", "old-d"]);
    tailPage.resolve({ agents: [{ id: "b" }, { id: "new-c" }, { id: "new-d" }], total: 6 });
    const update = await restoring;
    expect(update?.rows.map((row) => row.id)).toEqual(["poll-a", "b", "new-c", "new-d"]);
    expect(updates).toEqual([
        ["fresh-a", "b", "old-c", "old-d"],
        ["poll-a", "b", "new-c", "new-d"],
    ]);
});

test("@core restore after reaching the old listing end uses the new first-page cursor", async () => {
    const pager = new SessionPager();
    pager.applyFirstPage({ agents: [{ id: "a" }, { id: "b" }], next_cursor: "b", total: 4 });
    await pager.loadMore(async () => ({ agents: [{ id: "c" }, { id: "d" }], total: 4 }));
    expect(pager.canShowMore).toBe(false);
    pager.invalidate();
    const cursors: string[] = [];
    const update = await pager.restoreTail(
        async () => ({ agents: [{ id: "new-a" }, { id: "b" }], next_cursor: "b", total: 4 }),
        async (cursor) => {
            cursors.push(cursor);
            return { agents: [{ id: "b" }, { id: "new-c" }, { id: "new-d" }], total: 4 };
        },
        2,
    );
    expect(cursors).toEqual(["b"]);
    expect(update?.rows.map((row) => row.id)).toEqual(["new-a", "b", "new-c", "new-d"]);
});

test("@core resetting the pager for a different home clears the previous tail and cursor", async () => {
    const pager = new SessionPager();
    pager.applyFirstPage({ agents: [{ id: "old-a" }, { id: "old-b" }], next_cursor: "old-b", total: 5 });
    await pager.loadMore(async () => ({ agents: [{ id: "old-c" }], next_cursor: "old-c", total: 5 }));
    expect(pager.tailLength).toBe(1);

    pager.reset();
    expect(pager.tailLength).toBe(0);
    expect(pager.canShowMore).toBe(false);
    const firstPage = pager.applyFirstPage({ agents: [{ id: "new-a" }, { id: "new-b" }], next_cursor: "new-b", total: 3 });
    expect(firstPage.rows.map((row) => row.id)).toEqual(["new-a", "new-b"]);
    expect((await pager.loadMore(async (cursor) => {
        expect(cursor).toBe("new-b");
        return { agents: [{ id: "new-c" }], total: 3 };
    }))?.rows.map((row) => row.id)).toEqual(["new-a", "new-b", "new-c"]);
});

test("@core drop and reconnect invalidate an in-flight Show more without sticking busy", async () => {
    const pager = new SessionPager();
    pager.applyFirstPage({ agents: [{ id: "a" }, { id: "b" }], next_cursor: "b", total: 5 });
    const page = deferred<AgentListFacts>();
    const stale = pager.loadMore(async () => page.promise);
    expect(pager.isBusy).toBe(true);
    pager.invalidate();
    pager.applyFirstPage({ agents: [{ id: "reconnected-a" }, { id: "b" }], next_cursor: "b", total: 5 });
    const current = pager.loadMore(async () => ({ agents: [{ id: "c" }], next_cursor: "c", total: 5 }));
    page.resolve({ agents: [{ id: "stale" }], next_cursor: "stale", total: 5 });
    expect(await stale).toBeUndefined();
    expect((await current)?.rows.map((row) => row.id)).toEqual(["reconnected-a", "b", "c"]);
    expect(pager.isBusy).toBe(false);
});

test("@core dropping a connection suppresses intermediate and final restore updates", async () => {
    const pager = new SessionPager();
    pager.applyFirstPage({ agents: [{ id: "a" }, { id: "b" }], next_cursor: "b", total: 5 });
    await pager.loadMore(async () => ({ agents: [{ id: "old-c" }], next_cursor: "old-c", total: 5 }));
    pager.invalidate();

    const firstPage = deferred<AgentListFacts>();
    const tailPage = deferred<AgentListFacts>();
    const updates: string[][] = [];
    const restoring = pager.restoreTail(async () => firstPage.promise, async () => tailPage.promise, 1, (update) => {
        updates.push(update.rows.map((row) => row.id));
    });
    pager.invalidate();
    pager.applyFirstPage({ agents: [{ id: "connected-a" }, { id: "b" }], next_cursor: "b", total: 5 });
    firstPage.resolve({ agents: [{ id: "stale-a" }, { id: "b" }], next_cursor: "b", total: 5 });
    await Promise.resolve();
    await Promise.resolve();
    tailPage.resolve({ agents: [{ id: "stale-c" }], total: 5 });
    expect(await restoring).toBeUndefined();
    expect(updates).toEqual([]);
    expect(pager.applyFirstPage({ agents: [{ id: "connected-a" }, { id: "b" }], next_cursor: "b", total: 5 }).rows.map((row) => row.id))
        .toEqual(["connected-a", "b", "old-c"]);
});

test("@core a duplicate-only page follows next_cursor, and the button disappears at listing end", async () => {
    const pager = new SessionPager();
    pager.applyFirstPage({ agents: [{ id: "a" }, { id: "b" }], next_cursor: "b", total: 101 });
    const cursors: string[] = [];
    const update = await pager.loadMore(async (cursor) => {
        cursors.push(cursor);
        return cursors.length === 1
            ? { agents: [{ id: "b" }], next_cursor: "b-again", total: 101 }
            : { agents: [{ id: "c" }, { id: "d" }], total: 101 };
    });
    expect(cursors).toEqual(["b", "b-again"]);
    expect(update?.rows.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
    expect(pager.canShowMore).toBe(false);
});

test("@core session rows carry a name, folder, status and the last activity, and skip rows they cannot read", () => {
    const rows = sessionRows({
        agents: [
            { id: "abc", name: "  First  ", workspace: "/w/crow", status: "working", updated_at: "2026-01-02T03:04:05Z", live: true, parent_id: "p1" },
            { id: "def12345678", title: "Titled", status: "sailing" },
            { id: "ghi12345678" },
            { id: "" },
            { name: "no id" },
            null,
            "text",
        ],
    });
    expect(rows).toEqual([
        { id: "abc", name: "First", workspace: "/w/crow", status: "working", updatedAt: Date.parse("2026-01-02T03:04:05Z"), live: true, chat: false, archived: false, parentId: "p1" },
        { id: "def12345678", name: "Titled", workspace: "", status: "other", live: false, chat: false, archived: false },
        { id: "ghi12345678", name: "ghi12345", workspace: "", status: "other", live: false, chat: false, archived: false },
    ]);
});

test("@core a row shows the title, which carries a rename, and falls back to the identity name before there is a title", () => {
    const rows = sessionRows({
        agents: [
            { id: "renamed1", name: "swift-stone:d14d", title: "crow map" },
            { id: "untitled", name: "mellow-summit:a5bd", title: "  " },
            { id: "identity", name: "glad-fern:17b8" },
        ],
    });
    expect(rows.map((item) => item.name)).toEqual(["crow map", "mellow-summit:a5bd", "glad-fern:17b8"]);
});

test("a row the host marks as a chat is a chat, and only an exact true counts", () => {
    const rows = sessionRows({
        agents: [
            { id: "chat1", workspace: "/home/runtime/sessions/chat1.jsonl.files", chat: true },
            { id: "plain1", workspace: "/w/crow", chat: "true" },
            { id: "plain2", workspace: "/w/crow", chat: false },
            { id: "plain3", workspace: "/w/crow" },
        ],
    });
    expect(rows.map((item) => [item.id, item.chat])).toEqual([
        ["chat1", true],
        ["plain1", false],
        ["plain2", false],
        ["plain3", false],
    ]);
});

test("an unreadable time leaves the row without one", () => {
    expect(sessionRows({ agents: [{ id: "a", updated_at: "not a date" }, { id: "b", updated_at: 5 }] }))
        .toEqual([
            { id: "a", name: "a", workspace: "", status: "other", live: false, chat: false, archived: false },
            { id: "b", name: "b", workspace: "", status: "other", live: false, chat: false, archived: false },
        ]);
});

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => {};
    const promise = new Promise<T>((accept) => { resolve = accept; });
    return { promise, resolve };
}

test("the relative time is coarse and never negative", () => {
    const now = Date.parse("2026-01-10T12:00:00Z");
    expect(relativeTime(undefined, now)).toBe("");
    expect(relativeTime(now + 5_000, now)).toBe("now");
    expect(relativeTime(now - 30_000, now)).toBe("now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5m");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3h");
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe("2d");
    expect(relativeTime(now - 45 * 86_400_000, now)).toBe("1mo");
    expect(relativeTime(now - 400 * 86_400_000, now)).toBe("1y");
});
