import { afterEach, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";

import {
    BUILT_IN_PERMISSION_MODES,
    decideToolPermission,
    inspectPermissions,
    isPermissionInspection,
    type PermissionOutcome,
} from "../../src/engine/permissions.ts";
import { collectReviewerPathFacts } from "../../src/engine/reviewer-path-facts.ts";
import { workspaceScope } from "../../src/engine/workspace-scope.ts";
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

function write(
    mode: Mode,
    workspace: string,
    path: string,
    tool: "write" | "edit" = "write",
): PermissionOutcome {
    const input: HookToolCall["input"] = tool === "write"
        ? { path, content: "x" }
        : { path, old_string: "a", new_string: "b" };
    return decideToolPermission(
        mode,
        toolCall(tool, input),
        workspace,
        [],
        { homeDirectory: workspace },
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
