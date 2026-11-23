import { expect, test } from "bun:test";

import { CHATS_TITLE, folderName, rowFolderName, rowFolderPath, waitingCount } from "../../clients/ui/src/protocol/sessionGroups.ts";
import type { SessionRow } from "../../clients/ui/src/protocol/sessions.ts";
import { buildSidebarTree, sidebarRowEntries, type SidebarNode, type SidebarTree } from "../../clients/ui/src/protocol/sidebarTree.ts";

function row(id: string, workspace: string, extra: Partial<SessionRow> = {}): SessionRow {
    return { id, name: id, workspace, status: "idle", live: false, chat: false, ...extra };
}

function nodeShape(node: SidebarNode): unknown {
    return [node.row.id, node.children.map(nodeShape)];
}

function shape(tree: SidebarTree): unknown {
    return tree.sections.map((section) => [section.title, section.kind, section.folderRow, section.nodes.map(nodeShape)]);
}

test("@core grouping follows the folder, flat and single-row table", () => {
    const rows = [
        row("a", "/p/crow"),
        row("b", "/p/crow"),
        row("match", "/p/parrot", { name: "parrot" }),
        row("named", "/p/heron", { name: "Trace the reef" }),
    ];
    expect(shape(buildSidebarTree(rows, [], "none"))).toEqual([
        ["", "flat", false, [["a", []], ["b", []], ["match", []], ["named", []]]],
    ]);
    expect(shape(buildSidebarTree(rows, [], "folder"))).toEqual([
        ["crow", "folder", false, [["a", []], ["b", []]]],
        ["parrot", "folder", true, [["match", []]]],
        ["heron", "folder", false, [["named", []]]],
    ]);
});

test("@core every subagent sits under its direct parent at any depth", () => {
    const rows = [
        row("grandchild", "/elsewhere", { parentId: "child" }),
        row("parent", "/p"),
        row("other", "/q", { parentId: "parent" }),
        row("child", "/p", { parentId: "parent" }),
        row("great", "/x", { parentId: "grandchild" }),
        row("orphan", "/p", { parentId: "gone" }),
    ];
    const tree = buildSidebarTree(rows, [], "folder");
    expect(tree.sections.map((section) => [section.title, section.nodes.map(nodeShape)])).toEqual([
        ["p", [["parent", [["other", []], ["child", [["grandchild", [["great", []]]]]]]], ["orphan", []]]],
    ]);
    expect(sidebarRowEntries(tree).map((entry) => [entry.row.id, entry.nested])).toEqual([
        ["parent", false],
        ["other", true],
        ["child", true],
        ["grandchild", true],
        ["great", true],
        ["orphan", false],
    ]);
});

test("@core only top-level sessions are pinned, in pin order, with their descendants", () => {
    const rows = [
        row("a", "/p"),
        row("parent", "/p"),
        row("kid", "/q", { parentId: "parent" }),
        row("b", "/r"),
    ];
    const tree = buildSidebarTree(rows, ["b", "kid", "gone", "parent", "b"], "folder");
    expect(tree.sections.map((section) => [section.title, section.nodes.map(nodeShape)])).toEqual([
        ["Pinned", [["b", []], ["parent", [["kid", []]]]]],
        ["p", [["a", []]]],
    ]);
});

test("@core a stale pin stays in the file and is ignored when rendering", () => {
    const rows = [row("a", "/p"), row("b", "/p")];
    const pins = ["gone", "b"];
    expect(shape(buildSidebarTree(rows, pins, "none"))).toEqual([
        ["Pinned", "pinned", false, [["b", []]]],
        ["", "flat", false, [["a", []]]],
    ]);
    expect(pins).toEqual(["gone", "b"]);
});

test("unpinning returns a root to the host's order", () => {
    const rows = [row("first", "/p"), row("second", "/p"), row("third", "/p")];
    expect(shape(buildSidebarTree(rows, ["second"], "none"))).toEqual([
        ["Pinned", "pinned", false, [["second", []]]],
        ["", "flat", false, [["first", []], ["third", []]]],
    ]);
    expect(shape(buildSidebarTree(rows, [], "none"))).toEqual([
        ["", "flat", false, [["first", []], ["second", []], ["third", []]]],
    ]);
});

test("pinning one of two sessions keeps the folder heading and the sibling's own name", () => {
    const rows = [row("one", "/p/crow"), row("two", "/p/crow", { name: "Two crows" })];
    const tree = buildSidebarTree(rows, ["one"], "folder");
    expect(shape(tree)).toEqual([
        ["Pinned", "pinned", false, [["one", []]]],
        ["crow", "folder", false, [["two", []]]],
    ]);
});

test("a folder heading disappears when all its sessions are pinned", () => {
    const tree = buildSidebarTree([row("only", "/p/crow")], ["only"], "folder");
    expect(shape(tree)).toEqual([["Pinned", "pinned", false, [["only", []]]]]);
});

test("a pinned child does not leave its parent", () => {
    const rows = [row("parent", "/p"), row("kid", "/p", { parentId: "parent" })];
    const tree = buildSidebarTree(rows, ["kid"], "none");
    expect(shape(tree)).toEqual([
        ["", "flat", false, [["parent", [["kid", []]]]]],
    ]);
});

test("@core chats keep one Chats heading under Folder and join the flat list under None", () => {
    const folder = "/h/sessions/c1.jsonl.files";
    const rows = [
        row("c1", folder, { chat: true }),
        row("kid", folder, { parentId: "c1" }),
        row("a", "/p/crow"),
        row("c2", folder, { chat: true }),
    ];
    expect(shape(buildSidebarTree(rows, [], "folder"))).toEqual([
        [CHATS_TITLE, "chats", false, [["c1", [["kid", []]]], ["c2", []]]],
        ["crow", "folder", false, [["a", []]]],
    ]);
    expect(shape(buildSidebarTree(rows, [], "none"))).toEqual([
        ["", "flat", false, [["c1", [["kid", []]]], ["a", []], ["c2", []]]],
    ]);
});

test("@core archived families sit last, keep their nesting and their pins wait in the file", () => {
    const rows = [
        row("folder", "/p"),
        row("parent", "/chat.files", { chat: true, archived: true }),
        row("child", "/q", { parentId: "parent" }),
        row("grandchild", "/q", { parentId: "child", status: "waiting" }),
    ];
    const pins = ["child", "parent"];
    const tree = buildSidebarTree(rows, pins, "folder");
    expect(shape(tree)).toEqual([
        ["p", "folder", false, [["folder", []]]],
        ["Archived", "archived", false, [["parent", [["child", [["grandchild", []]]]]]]],
    ]);
    expect(tree.sections[1]?.nodes[0]?.children[0]?.archiveRoot.id).toBe("parent");
    expect(pins).toEqual(["child", "parent"]);
    expect(waitingCount(rows)).toBe(1);
    const restored = buildSidebarTree(rows.map((entry) => ({ ...entry, archived: false })), pins, "folder");
    expect(shape(restored)).toEqual([
        ["Pinned", "pinned", false, [["parent", [["child", [["grandchild", []]]]]]]],
        ["p", "folder", false, [["folder", []]]],
    ]);
});

test("a descendant marked archived takes its whole family with it", () => {
    const rows = [row("parent", "/p"), row("kid", "/p", { parentId: "parent", archived: true })];
    const tree = buildSidebarTree(rows, ["parent"], "none");
    expect(shape(tree)).toEqual([
        ["Archived", "archived", false, [["parent", [["kid", []]]]]],
    ]);
});

test("archived roots are not promoted to Pinned", () => {
    const rows = [row("old", "/p", { archived: true }), row("new", "/p")];
    const tree = buildSidebarTree(rows, ["old"], "folder");
    expect(shape(tree)).toEqual([
        ["p", "folder", false, [["new", []]]],
        ["Archived", "archived", false, [["old", []]]],
    ]);
});

test("a child in another folder follows its parent, and an absent parent leaves a root", () => {
    const tree = buildSidebarTree([
        row("other", "/q", { parentId: "parent" }),
        row("parent", "/p"),
        row("orphan", "/r", { parentId: "gone" }),
    ], [], "folder");
    expect(shape(tree)).toEqual([
        ["p", "folder", false, [["parent", [["other", []]]]]],
        ["r", "folder", false, [["orphan", []]]],
    ]);
});

test("a loop in parent links lists every row once as a root", () => {
    const rows = [
        row("a", "/p", { parentId: "b" }),
        row("b", "/p", { parentId: "a" }),
        row("c", "/q", { parentId: "a" }),
    ];
    const tree = buildSidebarTree(rows, [], "none");
    const ids = sidebarRowEntries(tree).map((entry) => entry.row.id);
    expect(ids.sort()).toEqual(["a", "b", "c"]);
});

test("folder names, chat names and the waiting count", () => {
    const chat = row("c", "/h/sessions/c.jsonl.files", { chat: true });
    expect(rowFolderName(chat)).toBe("Chat");
    expect(rowFolderPath(chat)).toBeUndefined();
    expect(rowFolderName(row("a", "/p/crow"))).toBe("crow");
    expect(rowFolderPath(row("a", "/p/crow"))).toBe("/p/crow");
    expect(rowFolderPath(row("a", ""))).toBeUndefined();
    expect(folderName("/Users/crow/Projects/vera")).toBe("vera");
    expect(folderName("C:\\ships\\brig\\")).toBe("brig");
    expect(folderName("/")).toBe("/");
    expect(waitingCount([row("a", "/p", { status: "waiting" }), row("b", "/p", { status: "working" })])).toBe(1);
});
