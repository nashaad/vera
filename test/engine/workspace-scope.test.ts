import { afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";

import {
    BUILT_IN_PERMISSION_MODES,
    decideToolPermission,
    extractPermissionActions,
    inspectPermissions,
    isPermissionInspection,
    type PermissionOutcome,
    type PermissionPreference,
    type PermissionRule,
} from "../../src/engine/permissions.ts";
import { collectReviewerPathFacts } from "../../src/engine/reviewer-path-facts.ts";
import { linkedWorktreeSharedDirectory, workspaceScope } from "../../src/engine/workspace-scope.ts";
import type { HookToolCall } from "../../src/sdk/hooks.ts";
import { initBashParser } from "../../src/tools/bash-parser.ts";
import {
    addSubmodule,
    addWorktree,
    git,
    removeGitRepositories,
    repository,
} from "../support/git-repositories.ts";

type Mode = "ask" | "auto" | "full_access" | "readonly";

beforeAll(async () => {
    await initBashParser();
});

afterEach(removeGitRepositories);

test("@core auto asks, not the reviewer, for a write from a worktree session into the main checkout", () => {
    const repo = repository();
    const session = addWorktree(repo, "a");
    const sibling = addWorktree(repo, "b");

    expect(write("auto", session, join(session, "src", "new.ts"))).toBe("allow");
    expect(write("auto", session, join(repo, "src", "new.ts"))).toBe("ask");
    expect(write("auto", session, join(sibling, "src", "new.ts"))).toBe("ask");
    expect(write("auto", repo, join(repo, "src", "new.ts"))).toBe("allow");
    expect(write("auto", repo, join(sibling, "src", "new.ts"))).toBe("ask");
    expect(write("auto", session, join(repo, "src", "a.ts"), "edit")).toBe("ask");
});

test("@core a write into another worktree asks under ask and is still allowed in full_access", () => {
    const repo = repository();
    const session = addWorktree(repo, "a");
    const target = join(repo, "src", "new.ts");

    expect(write("ask", session, target)).toBe("ask");
    expect(write("ask", session, join(session, "src", "new.ts"))).toBe("allow");
    expect(write("full_access", session, target)).toBe("allow");
    expect(write("readonly", session, target)).toBe("deny");
});

test("auto still sends other outside-workspace writes to the reviewer", () => {
    const repo = repository();
    const session = addWorktree(repo, "a");
    const elsewhere = join(repo, "..", "elsewhere");

    expect(write("auto", session, join(elsewhere, "new.ts"))).toBe("review");
    expect(write("ask", session, join(elsewhere, "new.ts"))).toBe("ask");
    expect(write("auto", repo, join(elsewhere, "new.ts"))).toBe("review");
});

test("a write into another worktree nested under the workspace follows the same rule", () => {
    const repo = repository();
    const nested = addWorktree(repo, "nested");
    const target = join(nested, "src", "new.ts");

    expect(write("auto", repo, target)).toBe("ask");
    expect(write("ask", repo, target)).toBe("ask");
    expect(write("full_access", repo, target)).toBe("allow");
    expect(write("readonly", repo, target)).toBe("deny");
});

test("a shell write into another worktree follows the same rule as a file write", () => {
    const repo = repository();
    const session = addWorktree(repo, "a");
    const sibling = addWorktree(repo, "b");
    const nested = join(repo, ".worktrees", "b");
    const redirect = (mode: Mode, workspace: string, target: string) =>
        shell(mode, workspace, `printf x > ${target}`);

    expect(redirect("auto", session, join(repo, "out.txt"))).toBe("ask");
    expect(redirect("auto", session, join(sibling, "out.txt"))).toBe("ask");
    expect(redirect("auto", repo, join(nested, "out.txt"))).toBe("ask");
    expect(redirect("auto", session, join(session, "out.txt"))).toBe("allow");
    expect(redirect("auto", session, join(repo, "..", "elsewhere", "out.txt"))).toBe("review");
    expect(redirect("ask", session, join(repo, "out.txt"))).toBe("ask");
    expect(redirect("full_access", session, join(repo, "out.txt"))).toBe("allow");
    expect(shell("auto", session, "printf x > out.txt")).toBe("allow");
    expect(shell("auto", session, `rm ${join(repo, "src", "a.ts")}`)).toBe("ask");
    expect(shell("auto", repo, `rm ${join(nested, "src", "a.ts")}`)).toBe("ask");
    expect(shell("auto", session, `rm ${join(repo, "..", "elsewhere", "a.ts")}`)).toBe("review");
    expect(shell("auto", session, `cat ${join(repo, "src", "a.ts")}`)).toBe("allow");
});

test("a read from another worktree is not asked about", () => {
    const repo = repository();
    const session = addWorktree(repo, "a");
    const read = decideToolPermission(
        "auto",
        toolCall("read", { path: join(repo, "src", "a.ts") }),
        session,
        [],
        { homeDirectory: repo },
    );

    expect(read.behavior).toBe("allow");
});

test("a worktree of a different repository is not another worktree of this one", () => {
    const repo = repository();
    const other = repository();
    const foreign = addWorktree(other, "foreign");

    expect(write("auto", repo, join(other, "src", "new.ts"))).toBe("review");
    expect(write("auto", repo, join(foreign, "src", "new.ts"))).toBe("review");
    expect(workspaceScope(join(foreign, "src", "a.ts"), repo)).toBe("outside_workspace");
});

test("workspaceScope marks a nested checkout of the same repository outside and other nested repositories inside", () => {
    const repo = repository();
    const nested = addWorktree(repo, "nested");
    const submodule = addSubmodule(repo, "vendor");
    const clone = join(repo, "clone");
    git(repo, ["init", "-q", clone]);
    const unrelated = repository();
    const foreignNested = join(repo, "foreign");
    git(unrelated, ["worktree", "add", "-q", "-b", "foreign", foreignNested]);

    expect(workspaceScope(join(nested, "src", "a.ts"), repo)).toBe("outside_workspace");
    expect(workspaceScope(nested, repo)).toBe("outside_workspace");
    expect(workspaceScope(join(nested, "missing", "dir", "a.ts"), repo)).toBe("outside_workspace");
    expect(workspaceScope(join(repo, "src", "a.ts"), repo)).toBe("workspace");
    expect(workspaceScope(repo, repo)).toBe("workspace");
    expect(workspaceScope(join(submodule, "a.txt"), repo)).toBe("workspace");
    expect(workspaceScope(join(clone, "a.txt"), repo)).toBe("workspace");
    expect(workspaceScope(join(foreignNested, "a.ts"), repo)).toBe("workspace");
    expect(workspaceScope(join(nested, "src", "a.ts"), nested)).toBe("workspace");
    expect(workspaceScope(join(repo, "..", "elsewhere.txt"), repo)).toBe("outside_workspace");
});

test("linkedWorktreeSharedDirectory finds the shared git folder only for a linked worktree", () => {
    const repo = repository();
    const worktree = addWorktree(repo, "a");
    const submodule = addSubmodule(repo, "vendor");

    expect(linkedWorktreeSharedDirectory(repo)).toBeUndefined();
    expect(linkedWorktreeSharedDirectory(join(repo, "src"))).toBeUndefined();
    expect(linkedWorktreeSharedDirectory(submodule)).toBeUndefined();
    expect(linkedWorktreeSharedDirectory(worktree)).toBe(join(repo, ".git"));
    expect(linkedWorktreeSharedDirectory(join(worktree, "src"))).toBe(
        join(repo, ".git"),
    );
});

test("a workspace subfolder keeps its own checkout inside and the others outside", () => {
    const repo = repository();
    const session = addWorktree(repo, "a");
    const folder = join(session, "src");

    expect(workspaceScope(join(folder, "a.ts"), folder)).toBe("workspace");
    expect(workspaceScope(join(session, "other.ts"), folder)).toBe("outside_workspace");
    expect(write("auto", folder, join(session, "other.ts"))).toBe("review");
    expect(write("auto", folder, join(repo, "src", "new.ts"))).toBe("ask");
});

test("reviewer path facts report outside_workspace for another worktree", async () => {
    const repo = repository();
    const nested = addWorktree(repo, "nested");
    const path = join(nested, "src", "a.ts");

    const facts = await collectReviewerPathFacts(
        repo,
        { id: "call_1", name: "write", input: { path } },
        [{
            action: { tool: "write", verb: "write", path, scope: "workspace" },
            outcome: "ask",
            rule: "default",
        }],
    );

    expect(facts[0]?.scope).toBe("outside_workspace");
});

test("the auto rule travels in the permission inspection", () => {
    const inspection = inspectPermissions("auto");

    expect(isPermissionInspection(inspection)).toBe(true);
    expect(inspection?.selected.rules).toContainEqual({
        name: "routine.other_worktree_write",
        when: { verb: "write", otherWorktree: true },
        then: "ask",
    });
    expect(inspection?.selected.rules).toContainEqual({
        name: "routine.other_worktree_delete",
        when: { verb: "delete", otherWorktree: true },
        then: "ask",
    });
    expect(BUILT_IN_PERMISSION_MODES.ask.rules.map((rule) => rule.name))
        .not.toContain("routine.other_worktree_write");
});

test("a broad rule allow does not lift the other-worktree ask", () => {
    const repo = repository();
    const session = addWorktree(repo, "a");
    const sibling = addWorktree(repo, "b");
    const target = join(sibling, "src", "new.ts");
    const broad: readonly PermissionRule[] = [{
        name: "permission_rules.0",
        when: { verb: "write", path: join(repo, "..") },
        then: "allow",
    }];

    for (const mode of ["ask", "auto"] as const) {
        expect(decideWithRules(mode, session, target, broad)).toBe("ask");
    }

    // Always on that prompt still covers the path it named.
    const always: readonly PermissionPreference[] = [{
        id: "preference-1",
        when: { verb: "write", path: join(sibling, "src") },
        createdAt: "2026-11-14T00:00:00.000Z",
    }];
    expect(decideWithRules("auto", session, target, broad, always)).toBe("allow");
});

test("no rule allow lifts the other-worktree ask", () => {
    const repo = repository();
    const session = addWorktree(repo, "a");
    const sibling = addWorktree(repo, "b");
    const target = join(sibling, "src", "new.ts");
    const exact: readonly PermissionRule[] = [{
        name: "permission_rules.0",
        when: { verb: "write", path: target },
        then: "allow",
    }];

    expect(write("auto", session, target)).toBe("ask");
    for (const mode of ["ask", "auto"] as const) {
        expect(decideWithRules(mode, session, target, exact)).toBe("ask");
    }
});

test("@core a declared write root lifts a file-tool write from review and ask but never a shell write", () => {
    const repo = repository();
    const session = addWorktree(repo, "a");
    const root = join(dirname(repo), "shared-root");
    mkdirSync(root);
    const target = join(root, "notes.txt");

    expect(write("auto", session, target)).toBe("review");
    expect(write("auto", session, target, "write", [root])).toBe("allow");
    expect(write("ask", session, target)).toBe("ask");
    expect(write("ask", session, target, "write", [root])).toBe("allow");
    expect(write("readonly", session, target, "write", [root])).toBe("deny");
    expect(write("auto", session, target, "edit", [root])).toBe("allow");
    expect(write("auto", session, join(root, "other.txt"), "write", [root]))
        .toBe("allow");
    expect(write("auto", session, join(root, "..", "outside.txt"), "write", [root]))
        .toBe("review");

    expect(shell("auto", session, `printf x > ${target}`)).toBe("review");
    expect(shellWithRoots("auto", session, `printf x > ${target}`, [root]))
        .toBe("review");
    expect(shellWithRoots("ask", session, `printf x > ${target}`, [root]))
        .toBe("ask");
});

test("@core explicit deny and ask rules win over a write root", () => {
    const repo = repository();
    const session = addWorktree(repo, "a");
    const root = join(dirname(repo), "shared-root");
    mkdirSync(root);
    const target = join(root, "notes.txt");
    const deny: readonly PermissionRule[] = [{
        name: "permission_rules.0",
        when: { verb: "write", path: target },
        then: "deny",
    }];
    const ask: readonly PermissionRule[] = [{
        name: "permission_rules.1",
        when: { verb: "write", path: target },
        then: "ask",
    }];

    expect(decideWithRules("auto", session, target, [], [], [root]))
        .toBe("allow");
    expect(decideWithRules("auto", session, target, deny, [], [root]))
        .toBe("deny");
    expect(decideWithRules("auto", session, target, ask, [], [root]))
        .toBe("ask");
    expect(decideWithRules("ask", session, target, deny, [], [root]))
        .toBe("deny");
});

test("a write root inside another worktree does not lift its ask", () => {
    const repo = repository();
    const session = addWorktree(repo, "a");
    const sibling = addWorktree(repo, "b");
    const target = join(sibling, "src", "new.ts");

    expect(write("auto", session, target, "write", [sibling])).toBe("ask");
    expect(write("ask", session, target, "write", [sibling])).toBe("ask");
});

test("a symlink under a write root does not borrow its authority", () => {
    const repo = repository();
    const session = addWorktree(repo, "a");
    const root = join(dirname(repo), "shared-root");
    const outside = join(dirname(repo), "outside-root");
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(outside, join(root, "escape"));

    expect(write("auto", session, join(root, "escape", "new.ts"), "write", [root]))
        .toBe("review");
});

test("reviewer path facts mark a rooted write as authorized_root", async () => {
    const repo = repository();
    const session = addWorktree(repo, "a");
    const root = join(dirname(repo), "shared-root");
    mkdirSync(root);
    const path = join(root, "notes.txt");
    const call = { id: "call_1", name: "write", input: { path, content: "x" } };
    const actions = extractPermissionActions({
        toolCall: call,
        workspace: session,
        homeDirectory: session,
        writeRoots: [root],
    });
    const facts = await collectReviewerPathFacts(
        session,
        call,
        actions.map((action) => ({
            action,
            outcome: "allow" as const,
            rule: "routine.write_root_write",
        })),
    );
    const plainFacts = await collectReviewerPathFacts(
        session,
        call,
        extractPermissionActions({
            toolCall: call,
            workspace: session,
            homeDirectory: session,
        }).map((action) => ({
            action,
            outcome: "review" as const,
            rule: "auto.default",
        })),
    );

    expect(facts[0]?.scope).toBe("authorized_root");
    expect(plainFacts[0]?.scope).toBe("outside_workspace");
});

test("the ask and auto inspections list the write-root rule", () => {
    for (const mode of ["ask", "auto"] as const) {
        const inspection = inspectPermissions(mode);
        expect(isPermissionInspection(inspection)).toBe(true);
        expect(inspection?.selected.rules).toContainEqual({
            name: "routine.write_root_write",
            when: { verb: "write", writeRoot: true },
            then: "allow",
        });
    }
});

function decideWithRules(
    mode: Mode,
    workspace: string,
    path: string,
    rules: readonly PermissionRule[],
    preferences: readonly PermissionPreference[] = [],
    writeRoots: readonly string[] = [],
): PermissionOutcome {
    return decideToolPermission(
        mode,
        toolCall("write", { path, content: "x" }),
        workspace,
        [],
        {
            homeDirectory: workspace,
            permissionRules: rules,
            permissionPreferences: preferences,
            ...(writeRoots.length === 0 ? {} : { writeRoots }),
        },
    ).behavior;
}

function write(
    mode: Mode,
    workspace: string,
    path: string,
    tool: "write" | "edit" = "write",
    writeRoots: readonly string[] = [],
): PermissionOutcome {
    const input: HookToolCall["input"] = tool === "write"
        ? { path, content: "x" }
        : { path, old_string: "a", new_string: "b" };
    return decideToolPermission(
        mode,
        toolCall(tool, input),
        workspace,
        [],
        {
            homeDirectory: workspace,
            ...(writeRoots.length === 0 ? {} : { writeRoots }),
        },
    ).behavior;
}

function shellWithRoots(
    mode: Mode,
    workspace: string,
    command: string,
    writeRoots: readonly string[],
): PermissionOutcome {
    return decideToolPermission(
        mode,
        toolCall("bash", { command }),
        workspace,
        [],
        { homeDirectory: workspace, writeRoots },
    ).behavior;
}

function shell(mode: Mode, workspace: string, command: string): PermissionOutcome {
    return decideToolPermission(
        mode,
        toolCall("bash", { command }),
        workspace,
        [],
        { homeDirectory: workspace },
    ).behavior;
}

function toolCall(name: string, input: HookToolCall["input"]): HookToolCall {
    return { id: "call_1", name, input };
}
