import { expect, test } from "bun:test";

import { CHATS_TITLE, folderName, groupSessions, PINNED_TITLE, rowFolderName, rowFolderPath, type SessionGroup, waitingCount } from "../../clients/ui/src/protocol/sessionGroups.ts";
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

function shape(group: SessionGroup | undefined): unknown {
    return group?.entries.map((entry) => [entry.row.id, entry.nested, entry.nestedCount]);
}

test("a child follows its parent, one level deep, in host order", () => {
    const groups = groupSessions([
        row("grandchild", "/p", { parentId: "child" }),
        row("parent", "/p"),
        row("child", "/p", { parentId: "parent" }),
        row("orphan", "/p", { parentId: "gone" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(shape(groups[0])).toEqual([
        ["parent", false, 2],
        ["grandchild", true, 0],
        ["child", true, 0],
        ["orphan", false, 0],
    ]);
});

test("a child in another folder is listed under its parent, not in a group of its own", () => {
    const groups = groupSessions([
        row("other", "/q", { parentId: "parent" }),
        row("parent", "/p"),
    ]);
    expect(groups.map((group) => group.title)).toEqual(["p"]);
    expect(shape(groups[0])).toEqual([["parent", false, 1], ["other", true, 0]]);
});

test("@core a subagent of a chat is nested under it in Chats, not in a group named by the chat folder", () => {
    const folder = "/h/sessions/c1.jsonl.files";
    const groups = groupSessions([
        row("kid", folder, { parentId: "c1" }),
        row("a", "/p/crow"),
        row("c1", folder, { chat: true }),
    ]);
    expect(groups.map((group) => [group.title, group.chats])).toEqual([[CHATS_TITLE, true], ["crow", false]]);
    expect(groups.some((group) => group.workspace === folder)).toBe(false);
    expect(shape(groups[0])).toEqual([["c1", false, 1], ["kid", true, 0]]);
    expect(shape(groups[1])).toEqual([["a", false, 0]]);
});

test("a grandchild of a chat sits under the chat, whatever folders the rows report", () => {
    const groups = groupSessions([
        row("c1", "/h/c1.files", { chat: true }),
        row("kid", "/h/c1.files", { parentId: "c1" }),
        row("grandkid", "/elsewhere", { parentId: "kid" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(shape(groups[0])).toEqual([["c1", false, 2], ["kid", true, 0], ["grandkid", true, 0]]);
});

test("a parent whose rows were paged out leaves its child as a root in its own group", () => {
    const groups = groupSessions([row("a", "/p"), row("child", "/q", { parentId: "gone" })]);
    expect(groups.map((group) => [group.title, shape(group)])).toEqual([
        ["p", [["a", false, 0]]],
        ["q", [["child", false, 0]]],
    ]);
});

test("a loop in parent links keeps every row", () => {
    const groups = groupSessions([row("a", "/p", { parentId: "b" }), row("b", "/p", { parentId: "a" })]);
    expect(groups[0]?.entries.map((entry) => entry.row.id).sort()).toEqual(["a", "b"]);
    expect(groups[0]?.entries.every((entry) => !entry.nested)).toBe(true);
});

test("a child of a loop lists on its own and every row appears once", () => {
    const groups = groupSessions([
        row("a", "/p", { parentId: "b" }),
        row("b", "/p", { parentId: "a" }),
        row("c", "/q", { parentId: "a" }),
    ]);
    const ids = groups.flatMap((group) => group.entries.map((entry) => entry.row.id));
    expect(ids.sort()).toEqual(["a", "b", "c"]);
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

test("@core pinned sessions sit first in pin order and leave their own group", () => {
    const groups = groupSessions([
        row("a", "/p/crow"),
        row("c1", "/h/c1.jsonl.files", { chat: true }),
        row("b", "/p/crow"),
        row("kid", "/p/crow", { parentId: "b" }),
    ], ["kid", "gone", "c1"]);
    expect(groups.map((group) => [group.title, group.workspace, group.entries.map((entry) => [entry.row.id, entry.nested])])).toEqual([
        [PINNED_TITLE, "", [["kid", false], ["c1", false]]],
        ["crow", "/p/crow", [["a", false], ["b", false]]],
    ]);
    expect(groups[0]?.key).not.toBe(groups[1]?.key);
    expect(groupSessions([row("a", "/p")], ["gone"]).map((group) => group.title)).toEqual(["p"]);
});

test("a pinned parent takes its children into Pinned in host order, whatever their folder", () => {
    const groups = groupSessions([
        row("a", "/p"),
        row("kid2", "/q", { parentId: "parent" }),
        row("parent", "/p"),
        row("kid1", "/p", { parentId: "parent" }),
        row("grandkid", "/p", { parentId: "kid1" }),
    ], ["parent"]);
    expect(groups.map((group) => [group.title, shape(group)])).toEqual([
        [PINNED_TITLE, [["parent", false, 3], ["kid2", true, 0], ["kid1", true, 0], ["grandkid", true, 0]]],
        ["p", [["a", false, 0]]],
    ]);
});

test("a pinned child shows in Pinned on its own and not again under its parent", () => {
    const groups = groupSessions([
        row("parent", "/p"),
        row("kid1", "/p", { parentId: "parent" }),
        row("kid2", "/p", { parentId: "parent" }),
    ], ["kid2"]);
    expect(groups.map((group) => [group.title, shape(group)])).toEqual([
        [PINNED_TITLE, [["kid2", false, 0]]],
        ["p", [["parent", false, 1], ["kid1", true, 0]]],
    ]);
});

test("a pinned parent and its pinned child are both rows in Pinned, and the child keeps its own subagents", () => {
    const groups = groupSessions([
        row("parent", "/p"),
        row("kid", "/p", { parentId: "parent" }),
        row("grandkid", "/p", { parentId: "kid" }),
    ], ["parent", "kid"]);
    expect(groups).toHaveLength(1);
    expect(shape(groups[0])).toEqual([["parent", false, 0], ["kid", false, 1], ["grandkid", true, 0]]);
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
