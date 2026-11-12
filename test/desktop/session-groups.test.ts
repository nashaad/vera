import { expect, test } from "bun:test";

import { folderName, groupSessions, waitingCount } from "../../clients/ui/src/protocol/sessionGroups.ts";
import type { SessionRow } from "../../clients/ui/src/protocol/sessions.ts";

function row(id: string, workspace: string, extra: Partial<SessionRow> = {}): SessionRow {
    return { id, name: id, workspace, status: "idle", live: false, ...extra };
}

test("@core sessions group by folder in order of their most recent session", () => {
    const groups = groupSessions([
        row("a", "/p/crow"),
        row("b", "/p/parrot/"),
        row("c", "/p/crow"),
        row("d", ""),
    ]);
    expect(groups.map((group) => [group.title, group.entries.map((entry) => entry.row.id)])).toEqual([
        ["crow", ["a", "c"]],
        ["parrot", ["b"]],
        ["No folder", ["d"]],
    ]);
});

test("a child follows its parent in the same folder, one level deep", () => {
    const groups = groupSessions([
        row("grandchild", "/p", { parentId: "child" }),
        row("parent", "/p"),
        row("other", "/q", { parentId: "parent" }),
        row("child", "/p", { parentId: "parent" }),
        row("orphan", "/p", { parentId: "gone" }),
    ]);
    expect(groups[0]?.entries.map((entry) => [entry.row.id, entry.nested])).toEqual([
        ["parent", false],
        ["grandchild", true],
        ["child", true],
        ["orphan", false],
    ]);
    expect(groups[1]?.entries.map((entry) => entry.nested)).toEqual([false]);
});

test("a loop in parent links keeps every row", () => {
    const groups = groupSessions([row("a", "/p", { parentId: "b" }), row("b", "/p", { parentId: "a" })]);
    expect(groups[0]?.entries.map((entry) => entry.row.id).sort()).toEqual(["a", "b"]);
});

test("folder names and the waiting count", () => {
    expect(folderName("/Users/crow/Projects/vera")).toBe("vera");
    expect(folderName("C:\\ships\\brig\\")).toBe("brig");
    expect(folderName("/")).toBe("/");
    expect(waitingCount([row("a", "/p", { status: "waiting" }), row("b", "/p", { status: "working" })])).toBe(1);
});
