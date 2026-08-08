import { expect, test } from "bun:test";

import { workspaceKey } from "../src/workspace-key.ts";

test("a path becomes its own readable key", () => {
    expect(workspaceKey("/Users/nash/Projects/vera"))
        .toBe("-Users-nash-Projects-vera");
});

test("spaces, dots, and runs of separators collapse to one dash", () => {
    expect(workspaceKey("/Users/nash/Mobile Documents/iCloud~md~obsidian"))
        .toBe("-Users-nash-Mobile-Documents-iCloud-md-obsidian");
    expect(workspaceKey("/Users/nash/.config")).toBe("-Users-nash-config");
});

test("two directories that flatten alike share a key", () => {
    // Accepted cost of a readable key. The failure is two workspaces sharing
    // state, not lost data, and it takes a directory named for a path.
    expect(workspaceKey("/Projects/vera")).toBe(workspaceKey("/Projects-vera"));
});

test("a key never comes back empty", () => {
    expect(workspaceKey("/")).toBe("-");
    expect(workspaceKey("")).toBe("-");
});
