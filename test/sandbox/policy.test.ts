import { expect, test } from "bun:test";
import { join, resolve, sep } from "node:path";

import type { PermissionRule } from "../../src/engine/permissions.ts";
import { compileSandboxPolicy } from "../../src/sandbox/policy.ts";

const workspace = "/work/repo";
const scratch = "/state/scratch";
const temp = "/tmp";
const home = "/Users/me";

const GIT_ENTRIES = [
    join(workspace, ".git", "hooks"),
    join(workspace, ".git", "config"),
];

const PROJECT_ENTRIES = [
    `${join(workspace, ".vera", "config.json")}*`,
    `${join(workspace, ".vera", "rules")}*`,
];

const PROJECT_ENTRIES_LINUX = [
    join(workspace, ".vera", "config.json"),
    join(workspace, ".vera", "rules"),
];

function policy(
    rules: readonly PermissionRule[],
    network: "open" | "allowlist" = "open",
    sharedGitDir?: string,
    platform: NodeJS.Platform = "darwin",
) {
    return compileSandboxPolicy({
        workspace,
        platform,
        protectedFiles: ["shell-startup"],
        protectedDirectories: ["editor-folder", "tool/commands"],
        scratchDir: scratch,
        tempDir: temp,
        home,
        otherCheckouts: [],
        ...(sharedGitDir === undefined ? {} : { sharedGitDir }),
        config: {
            enabled: true,
            network,
            allowed_domains: [],
        },
        permissionRules: rules,
    });
}

function rule(
    when: PermissionRule["when"],
    then: PermissionRule["then"],
): PermissionRule {
    return { name: "r", when, then };
}

test("@core sandbox policy allows the workspace, scratch and temp folders to be written", () => {
    const compiled = policy([]);
    expect(new Set(compiled.filesystem.allowWrite)).toEqual(
        new Set([workspace, scratch, resolve(temp)]),
    );
    expect(compiled.filesystem.denyRead).toEqual([]);
});

test("@core sandbox policy only allows this session scratch under the Vera home", () => {
    const veraHome = "/state/vera";
    const ownScratch = join(veraHome, "runtime", "scratch", "session-a");
    const siblingScratch = join(veraHome, "runtime", "scratch", "session-b");
    const homeConfig = join(veraHome, "config.json");
    const sessions = join(veraHome, "runtime", "sessions");
    for (const platform of ["linux", "darwin"] as const) {
        const compiled = compileSandboxPolicy({
            workspace,
            platform,
            protectedFiles: [],
            protectedDirectories: [],
            scratchDir: ownScratch,
            tempDir: temp,
            home,
            otherCheckouts: [],
            config: { enabled: true, network: "open", allowed_domains: [] },
            permissionRules: [],
        });
        expect(compiled.filesystem.allowWrite).toEqual([workspace, resolve(temp), ownScratch]);
        const allowed = (path: string) => compiled.filesystem.allowWrite.some((root) =>
            path === root || path.startsWith(`${root}${sep}`));
        expect(allowed(join(ownScratch, "todo.md"))).toBe(true);
        for (const path of [homeConfig, join(sessions, "session-a.jsonl"), join(siblingScratch, "todo.md")]) {
            expect(allowed(path)).toBe(false);
        }
        expect(compiled.filesystem.denyWrite).not.toContain(veraHome);
        expect(compiled.filesystem.denyWrite).not.toContain(`${veraHome}*`);
    }
});

test("@core sandbox policy adds a folder named by a path-only allow rule", () => {
    for (const then of ["allow"] as const) {
        const compiled = policy([
            rule({ path: "/data/loot" }, then),
            rule({ path: "/data/read-only", verb: "read" }, then),
            rule({ path: "/data/write", verb: "write" }, then),
            rule({ path: "/data/delete", verb: "delete" }, then),
        ]);
        expect(compiled.filesystem.allowWrite).toContain("/data/loot");
        expect(compiled.filesystem.allowWrite).toContain("/data/write");
        expect(compiled.filesystem.allowWrite).toContain("/data/delete");
        expect(compiled.filesystem.allowWrite).not.toContain("/data/read-only");
    }
});

test("@core sandbox policy ignores an allow rule with a tool or executable condition", () => {
    const compiled = policy([
        rule({ path: "/data/by-tool", tool: "bash" }, "allow"),
        rule({ path: "/data/by-exec", executable: "git" }, "allow"),
        rule({ path: "/data/by-glob", pathGlob: "*.plunder" }, "allow"),
    ]);
    expect(compiled.filesystem.allowWrite).toEqual(
        expect.arrayContaining([workspace, scratch, resolve(temp)]),
    );
    for (const path of ["/data/by-tool", "/data/by-exec", "/data/by-glob"]) {
        expect(compiled.filesystem.allowWrite).not.toContain(path);
    }
    expect(compiled.filesystem.allowWrite).toHaveLength(3);
});

test("@core sandbox policy denies writes a deny rule names", () => {
    const compiled = policy([rule({ path: "/data/locked" }, "deny")]);
    expect(compiled.filesystem.denyWrite).toContain("/data/locked");
    expect(compiled.filesystem.denyRead).toEqual(expect.arrayContaining(["/data/locked"]));
});

test("@core sandbox policy puts an ask path in the write deny list", () => {
    const compiled = policy([rule({ path: "/data/ask", verb: "write" }, "ask")]);
    expect(compiled.filesystem.denyWrite).toContain("/data/ask");
    expect(compiled.filesystem.denyRead).toEqual([]);
});

test("@core sandbox policy denies reads a deny rule names", () => {
    const compiled = policy([rule({ path: "/data/secret", verb: "read" }, "deny")]);
    expect(compiled.filesystem.denyRead).toEqual(["/data/secret"]);
    expect(compiled.filesystem.denyWrite).not.toContain("/data/secret");
});

test("@core sandbox policy applies a deny rule with an executable to every covered command", () => {
    const compiled = policy([
        rule({ path: "/data/exec", executable: "cat", verb: "read" }, "deny"),
        rule({ path: "/data/tool", tool: "bash", verb: "write" }, "deny"),
    ]);
    expect(compiled.filesystem.denyRead).toContain("/data/exec");
    expect(compiled.filesystem.denyWrite).toContain("/data/tool");
});

test("@core sandbox policy denies writes to another worktree nested in the workspace", () => {
    const compiled = compileSandboxPolicy({
        workspace,
        platform: "linux",
        protectedFiles: [],
        protectedDirectories: [],
        tempDir: temp,
        home,
        otherCheckouts: [join(workspace, ".worktrees", "other"), "/elsewhere/repo"],
        config: { enabled: true, network: "open", allowed_domains: [] },
        permissionRules: [],
    });
    expect(compiled.filesystem.denyWrite).toContain(
        join(workspace, ".worktrees", "other"),
    );
});

test("@core sandbox policy keeps a main checkout's git hooks and config denied at the workspace", () => {
    expect(policy([]).filesystem.denyWrite).toEqual(
        expect.arrayContaining(GIT_ENTRIES),
    );
});

test("@core sandbox policy protects the runtime's names at the workspace, as paths and as patterns", () => {
    const denyWrite = new Set(policy([]).filesystem.denyWrite);
    expect(denyWrite).toContain(join(workspace, "shell-startup"));
    expect(denyWrite).toContain(join(workspace, "**", "shell-startup"));
    for (const name of ["editor-folder", "tool/commands"]) {
        expect(denyWrite).toContain(join(workspace, name));
        expect(denyWrite).toContain(join(workspace, "**", name, "**"));
    }
    expect(denyWrite).toContain(join(workspace, "**", "tool/commands", "**"));
    expect(denyWrite).toContain(join(workspace, "**", ".git", "hooks", "**"));
    expect(denyWrite).toContain(join(workspace, "**", ".git", "config"));
});

test("@core sandbox policy gives Linux the literal paths only", () => {
    const denyWrite = new Set(
        policy([], "open", undefined, "linux").filesystem.denyWrite,
    );
    expect(denyWrite).toEqual(new Set([
        ...GIT_ENTRIES,
        ...PROJECT_ENTRIES_LINUX,
        join(workspace, "shell-startup"),
        join(workspace, "editor-folder"),
        join(workspace, "tool/commands"),
    ]));
});

test("@core sandbox policy passes srt only absolute paths", () => {
    const compiled = policy(
        [rule({ path: "/data/secret", verb: "read" }, "deny")],
        "open",
        "/main/.git",
    );
    for (const list of [
        compiled.filesystem.allowWrite,
        compiled.filesystem.denyRead,
        compiled.filesystem.denyWrite,
    ]) {
        for (const entry of list) expect(entry.startsWith("/")).toBe(true);
    }
});

test("@core sandbox policy makes a linked worktree's shared git folder writable and protects it with the full set", () => {
    const shared = "/main/.git";
    const compiled = policy([], "open", shared);
    const denyWrite = new Set(compiled.filesystem.denyWrite);
    expect(compiled.filesystem.allowWrite).toEqual(
        expect.arrayContaining([workspace, shared]),
    );
    expect([...denyWrite]).toEqual(expect.arrayContaining([
        ...GIT_ENTRIES,
        join(shared, "hooks"),
        join(shared, "config"),
        join(shared, "shell-startup"),
        join(shared, "editor-folder"),
        join(shared, "tool/commands"),
        join(shared, "**", "shell-startup"),
        join(shared, "**", "editor-folder", "**"),
    ]));
    expect(denyWrite).toContain(join(shared, "**", "tool/commands", "**"));
});

test("@core sandbox policy does not deny the checkout that holds the workspace", () => {
    // A repository under the temp folder: the main checkout is not nested in
    // the worktree, and denying it would also make its git directory read-only.
    const holder = "/tmp/holder";
    const worktree = join(holder, "wt");
    const compiled = compileSandboxPolicy({
        workspace: worktree,
        platform: "linux",
        protectedFiles: [],
        protectedDirectories: [],
        tempDir: "/tmp",
        home,
        otherCheckouts: [holder, join(holder, "sibling")],
        sharedGitDir: join(holder, ".git"),
        config: { enabled: true, network: "open", allowed_domains: [] },
        permissionRules: [],
    });
    expect(compiled.filesystem.allowWrite).toContain(join(holder, ".git"));
    expect(compiled.filesystem.denyWrite).not.toContain(holder);
    expect(compiled.filesystem.denyWrite).toContain(join(holder, "sibling"));
});

test("@core sandbox policy denies the project's Vera config and rules, existing or not", () => {
    const denyWrite = new Set(policy([]).filesystem.denyWrite);
    for (const path of PROJECT_ENTRIES) expect(denyWrite).toContain(path);
    // The rest of `.vera` stays writable: skills, agents and the model pool.
    expect(denyWrite).not.toContain(join(workspace, ".vera"));
    expect(denyWrite).not.toContain(join(workspace, ".vera", "skills"));
    expect(denyWrite).not.toContain(join(workspace, ".vera", "pool.json"));
});

test("@core sandbox policy compiles the project settings at the root the caller names", () => {
    const root = "/elsewhere/project";
    const compiled = compileSandboxPolicy({
        workspace,
        projectRoot: root,
        platform: "linux",
        protectedFiles: [],
        protectedDirectories: [],
        tempDir: temp,
        home,
        otherCheckouts: [],
        config: { enabled: true, network: "open", allowed_domains: [] },
        permissionRules: [],
    });
    expect(compiled.filesystem.denyWrite).toContain(
        join(root, ".vera", "config.json"),
    );
    expect(compiled.filesystem.denyWrite).toContain(join(root, ".vera", "rules"));
});

test("@core sandbox policy adds scanned nested paths to the write deny list", () => {
    const scanned = [
        join(workspace, "sub", ".git", "hooks"),
        join(workspace, "sub", ".git", "config"),
        join(workspace, "sub", ".vscode"),
    ];
    const compiled = compileSandboxPolicy({
        workspace,
        platform: "linux",
        protectedFiles: [],
        protectedDirectories: [],
        tempDir: temp,
        home,
        otherCheckouts: [],
        scannedWriteDenies: scanned,
        config: { enabled: true, network: "open", allowed_domains: [] },
        permissionRules: [],
    });
    expect(compiled.filesystem.denyWrite).toEqual(
        expect.arrayContaining(scanned),
    );
});

test("@core sandbox policy holds no network filter when the network is open", () => {
    expect(policy([], "open").network).toBeUndefined();
});

test("@core sandbox policy carries the allowed hosts when the network is an allowlist", () => {
    const compiled = compileSandboxPolicy({
        workspace,
        platform: "darwin",
        protectedFiles: [],
        protectedDirectories: [],
        tempDir: temp,
        home,
        otherCheckouts: [],
        config: {
            enabled: true,
            network: "allowlist",
            allowed_domains: ["github.com"],
        },
        permissionRules: [],
    });
    expect(compiled.network).toEqual({
        allowedDomains: ["github.com"],
        deniedDomains: [],
    });
});

test("@core sandbox policy expands ~ and .. in rules the way permission_rules does", () => {
    const compiled = policy([
        rule({ path: "~/plunder", verb: "read" }, "deny"),
        rule({ path: "/data/../booty", verb: "write" }, "deny"),
        rule({ path: "relative/path", verb: "read" }, "deny"),
    ]);
    expect(compiled.filesystem.denyRead).toEqual([join(home, "plunder")]);
    expect(compiled.filesystem.denyWrite).toContain(resolve("/data/../booty"));
});
