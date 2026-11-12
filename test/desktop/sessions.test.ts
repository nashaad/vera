import { expect, test } from "bun:test";

import { relativeTime, sessionRows } from "../../clients/ui/src/protocol/sessions.ts";

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
        { id: "abc", name: "First", workspace: "/w/crow", status: "working", updatedAt: Date.parse("2026-01-02T03:04:05Z"), live: true, parentId: "p1" },
        { id: "def12345678", name: "Titled", workspace: "", status: "other", live: false },
        { id: "ghi12345678", name: "ghi12345", workspace: "", status: "other", live: false },
    ]);
});

test("an unreadable time leaves the row without one", () => {
    expect(sessionRows({ agents: [{ id: "a", updated_at: "not a date" }, { id: "b", updated_at: 5 }] }))
        .toEqual([
            { id: "a", name: "a", workspace: "", status: "other", live: false },
            { id: "b", name: "b", workspace: "", status: "other", live: false },
        ]);
});

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
