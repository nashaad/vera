import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    alwaysOnRules,
    formatRuleReminder,
    globMatches,
    loadRules,
    rulesForReadPaths,
    workspaceRelativePath,
    type Rule,
} from "../../src/engine/rules.ts";

function workspaceWithRules(
    files: Readonly<Record<string, string>>,
    scope: "user" | "project" = "project",
): { readonly dir: string; readonly directories: { user: string; project: string } } {
    const root = mkdtempSync(join(tmpdir(), "vera-rules-"));
    const dir = scope === "project"
        ? join(root, ".vera", "rules")
        : join(root, "home-rules");
    mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
        writeFileSync(join(dir, name), body);
    }
    return {
        dir: root,
        directories: {
            user: scope === "user" ? dir : join(root, "absent-user"),
            project: scope === "project" ? dir : join(root, "absent-project"),
        },
    };
}

test("src/api/** matches nested files and misses siblings", () => {
    expect(globMatches("src/api/**", "src/api/handler.ts")).toBe(true);
    expect(globMatches("src/api/**", "src/api/nested/db.ts")).toBe(true);
    expect(globMatches("src/api/**", "src/web/app.ts")).toBe(false);
    expect(globMatches("src/api/**", "src/api.ts")).toBe(false);
    expect(globMatches("src/api/*.ts", "src/api/handler.ts")).toBe(true);
    expect(globMatches("src/api/*.ts", "src/api/nested/db.ts")).toBe(false);
});

test("workspaceRelativePath rejects paths outside the workspace", () => {
    const workspace = "/tmp/workspace";
    expect(workspaceRelativePath(workspace, "src/api/a.ts")).toBe("src/api/a.ts");
    expect(workspaceRelativePath(workspace, join(workspace, "src/api/a.ts")))
        .toBe("src/api/a.ts");
    expect(workspaceRelativePath(workspace, "/elsewhere/a.ts")).toBeUndefined();
});

test("formatRuleReminder uses Contents of path then the body", () => {
    const rules = [
        {
            scope: "project",
            path: "/w/.vera/rules/api.md",
            displayPath: ".vera/rules/api.md",
            paths: ["src/api/**"],
            body: "Use the shared error helper.\n",
        },
        {
            scope: "project",
            path: "/w/.vera/rules/web.md",
            displayPath: ".vera/rules/web.md",
            paths: ["src/web/**"],
            body: "Keep the web client a sibling.\n",
        },
    ] as const satisfies readonly Rule[];
    expect(formatRuleReminder(rules)).toBe(
        "Contents of .vera/rules/api.md:\n\n"
            + "Use the shared error helper.\n\n"
            + "Contents of .vera/rules/web.md:\n\n"
            + "Keep the web client a sibling.",
    );
});

test("frontmatter paths are parsed and the body drops the fence", async () => {
    const { dir, directories } = workspaceWithRules({
        "api.md": '---\npaths:\n  - "src/api/**"\n---\n\n# API\n\nUse the helper.\n',
    });
    try {
        const { rules, warnings } = await loadRules(directories);
        expect(warnings).toEqual([]);
        expect(rules).toHaveLength(1);
        expect(rules[0]?.paths).toEqual(["src/api/**"]);
        expect(rules[0]?.body).toBe("# API\n\nUse the helper.\n");
        expect(rules[0]?.displayPath).toBe(".vera/rules/api.md");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("no frontmatter and empty paths both mean always on", async () => {
    const { dir, directories } = workspaceWithRules({
        "bare.md": "# Bare\n\nAlways on.\n",
        "empty.md": "---\n---\n\n# Empty\n",
    });
    try {
        const { rules } = await loadRules(directories);
        expect(rules.map((rule) => rule.paths)).toEqual([[], []]);
        expect(alwaysOnRules(rules, "project")).toHaveLength(2);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("rules load in file name order, user scope before project", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-rules-"));
    try {
        const user = join(root, "home", "rules");
        const project = join(root, "work", ".vera", "rules");
        mkdirSync(user, { recursive: true });
        mkdirSync(project, { recursive: true });
        writeFileSync(join(user, "zz.md"), "user zz\n");
        writeFileSync(join(user, "aa.md"), "user aa\n");
        writeFileSync(join(project, "mm.md"), "project mm\n");
        const { rules } = await loadRules({ user, project });
        expect(rules.map((rule) => rule.displayPath)).toEqual([
            "<home>/rules/aa.md",
            "<home>/rules/zz.md",
            ".vera/rules/mm.md",
        ]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a rule whose frontmatter is not a paths list is skipped with a warning", async () => {
    const { dir, directories } = workspaceWithRules({
        "bad.md": "---\npaths: 17\n---\n\nnope\n",
        "good.md": '---\npaths:\n  - "src/**"\n---\n\nyes\n',
    });
    try {
        const { rules, warnings } = await loadRules(directories);
        expect(rules.map((rule) => rule.displayPath)).toEqual([".vera/rules/good.md"]);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]!.scope).toBe("project");
        expect(warnings[0]!.message).toContain(".vera/rules/bad.md");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("a missing rules directory is no rules and no warning", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-rules-"));
    try {
        expect(await loadRules({
            user: join(root, "absent-user"),
            project: join(root, "absent-project"),
        })).toEqual({ rules: [], warnings: [] });
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("only non-empty files match a read, once, and always-on rules never do", async () => {
    const { dir, directories } = workspaceWithRules({
        "always.md": "# Always\n",
        "api.md": '---\npaths:\n  - "src/api/**"\n---\n\napi\n',
        "web.md": '---\npaths:\n  - "src/web/**"\n---\n\nweb\n',
    });
    try {
        const { rules } = await loadRules(directories);
        const workspace = "/w";
        const first = rulesForReadPaths(
            rules,
            workspace,
            ["src/api/handler.ts", "src/api/nested/db.ts"],
            new Set(),
        );
        expect(first.map((rule) => rule.displayPath)).toEqual([".vera/rules/api.md"]);
        const both = rulesForReadPaths(
            rules,
            workspace,
            ["src/api/handler.ts", "src/web/app.ts"],
            new Set(),
        );
        expect(both.map((rule) => rule.displayPath)).toEqual([
            ".vera/rules/api.md",
            ".vera/rules/web.md",
        ]);
        expect(rulesForReadPaths(
            rules,
            workspace,
            ["src/api/handler.ts"],
            new Set([first[0]!.path]),
        )).toEqual([]);
        expect(rulesForReadPaths(rules, workspace, ["/elsewhere/a.ts"], new Set()))
            .toEqual([]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("alwaysOnRules filters by scope and skips path-scoped rules", async () => {
    const { dir, directories } = workspaceWithRules({
        "always.md": "always\n",
        "scoped.md": '---\npaths:\n  - "src/**"\n---\n\nscoped\n',
    });
    try {
        const { rules } = await loadRules(directories);
        expect(alwaysOnRules(rules, "project").map((rule) => rule.body))
            .toEqual(["always\n"]);
        expect(alwaysOnRules(rules, "user")).toEqual([]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
