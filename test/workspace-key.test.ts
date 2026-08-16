import { expect, test } from "bun:test";

import { workspaceKey } from "../src/workspace-key.ts";

test("a path becomes its own readable key", () => {
    expect(workspaceKey("/Users/you/Projects/app"))
        .toBe("-Users-you-Projects-app");
});

test("spaces, dots, and runs of separators collapse to one dash", () => {
    expect(workspaceKey("/Users/you/Mobile Documents/iCloud~md~obsidian"))
        .toBe("-Users-you-Mobile-Documents-iCloud-md-obsidian");
    expect(workspaceKey("/Users/you/.config")).toBe("-Users-you-config");
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

test("a worktree keys as its parent, a double dash, and its name", () => {
    expect(workspaceKey("/Users/you/Projects/app/.worktrees/fix"))
        .toBe("-Users-you-Projects-app--fix");
});

test("the double dash marks only the worktree join", () => {
    // Every other run of separators collapses, so a key holds at most one `--`
    // and it always means the same thing.
    expect(workspaceKey("/Users/you/Projects/app -- old"))
        .toBe("-Users-you-Projects-app-old");
    expect(workspaceKey("/Users/you/Projects/a.b/.worktrees/x..y"))
        .toBe("-Users-you-Projects-a-b--x-y");
});

test("a nested worktree marks the innermost one", () => {
    expect(workspaceKey("/a/.worktrees/b/.worktrees/c"))
        .toBe("-a-worktrees-b--c");
});

test("a bare .worktrees directory flattens like any other path", () => {
    expect(workspaceKey("/Users/you/Projects/app/.worktrees"))
        .toBe("-Users-you-Projects-app-worktrees");
    expect(workspaceKey("/Users/you/Projects/app/.worktrees/"))
        .toBe("-Users-you-Projects-app-worktrees-");
});
