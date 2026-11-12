import { expect, test } from "bun:test";

import { CHATS_TITLE, folderName, groupSessions, rowFolderName, rowFolderPath, waitingCount } from "../../clients/ui/src/protocol/sessionGroups.ts";
import type { SessionRow } from "../../clients/ui/src/protocol/sessions.ts";

function row(id: string, workspace: string, extra: Partial<SessionRow> = {}): SessionRow {
    return { id, name: id, workspace, status: "idle", live: false, chat: false, ...extra };
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

test("@core chats share one Chats group that opens no workspace, ordered by its newest session", () => {
    const groups = groupSessions([
        row("a", "/p/crow"),
        row("c1", "/h/sessions/c1.jsonl.files", { chat: true }),
        row("b", "/p/parrot"),
        row("c2", "/h/sessions/c2.jsonl.files", { chat: true }),
    ]);
    expect(groups.map((group) => [group.title, group.chats, group.workspace, group.entries.map((entry) => entry.row.id)])).toEqual([
        ["crow", false, "/p/crow", ["a"]],
        [CHATS_TITLE, true, "", ["c1", "c2"]],
        ["parrot", false, "/p/parrot", ["b"]],
    ]);
    expect(new Set(groups.map((group) => group.key)).size).toBe(3);
});

test("a chat group sits first when its session is the newest, and a folder called chats is not a chat", () => {
    const groups = groupSessions([row("c1", "/h/c1.jsonl.files", { chat: true }), row("x", "chats"), row("y", "")]);
    expect(groups.map((group) => [group.title, group.chats])).toEqual([[CHATS_TITLE, true], ["chats", false], ["No folder", false]]);
});

test("a chat names itself Chat and has no folder path to show", () => {
    const chat = row("c", "/h/sessions/c.jsonl.files", { chat: true });
    expect(rowFolderName(chat)).toBe("Chat");
    expect(rowFolderPath(chat)).toBeUndefined();
    expect(rowFolderName(row("a", "/p/crow"))).toBe("crow");
    expect(rowFolderPath(row("a", "/p/crow"))).toBe("/p/crow");
    expect(rowFolderPath(row("a", ""))).toBeUndefined();
});

test("folder names and the waiting count", () => {
    expect(folderName("/Users/crow/Projects/vera")).toBe("vera");
    expect(folderName("C:\\ships\\brig\\")).toBe("brig");
    expect(folderName("/")).toBe("/");
    expect(waitingCount([row("a", "/p", { status: "waiting" }), row("b", "/p", { status: "working" })])).toBe(1);
});
