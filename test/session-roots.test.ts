import { expect, test } from "bun:test";

import { sessionRootIds } from "../src/session-roots.ts";

interface Row {
    readonly id: string;
    readonly parent?: string;
}

test("listed descendants resolve to the same root regardless of row order", () => {
    const rows: Row[] = [
        { id: "grandchild", parent: "child" },
        { id: "orphan", parent: "absent" },
        { id: "child", parent: "parent" },
        { id: "parent" },
    ];
    const roots = sessionRootIds(rows, (row) => row.parent);
    expect(rows.map((row) => roots.get(row.id))).toEqual(["parent", "orphan", "parent", "parent"]);
});

test("a grouping boundary stops the walk at the nearest pinned ancestor", () => {
    const rows: Row[] = [
        { id: "grandchild", parent: "child" },
        { id: "parent" },
        { id: "child", parent: "parent" },
    ];
    const roots = sessionRootIds(rows, (row) => row.parent, (row) => row.id === "child");
    expect(rows.map((row) => roots.get(row.id))).toEqual(["child", "parent", "child"]);
});

test("cycles and their descendants remain separate roots regardless of row order", () => {
    const rows: Row[] = [
        { id: "child", parent: "a" },
        { id: "a", parent: "b" },
        { id: "b", parent: "a" },
        { id: "other", parent: "a" },
    ];
    const roots = sessionRootIds(rows, (row) => row.parent);
    expect(rows.map((row) => roots.get(row.id))).toEqual(["child", "a", "b", "other"]);
});

test("a long reversed ancestry resolves without recursion", () => {
    const rows: Row[] = Array.from({ length: 40_000 }, (_, index) => ({
        id: `s${index}`,
        ...(index === 0 ? {} : { parent: `s${index - 1}` }),
    })).reverse();
    const roots = sessionRootIds(rows, (row) => row.parent);
    expect(roots.size).toBe(40_000);
    expect(roots.get("s39999")).toBe("s0");
    expect(roots.get("s0")).toBe("s0");
});
