import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
    formatContextRouteReminder,
    globMatches,
    loadContextRoutes,
    payloadsForSuccessfulReads,
    workspaceRelativePath,
} from "../../src/engine/context-routes.ts";

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

test("formatContextRouteReminder uses Contents of path then the body", () => {
    expect(formatContextRouteReminder([
        {
            injectPath: "context-routes/api.md",
            displayPath: ".vera/context-routes/api.md",
            content: "Use the shared error helper.",
        },
        {
            injectPath: "context-routes/web.md",
            displayPath: ".vera/context-routes/web.md",
            content: "Keep the web client a sibling.",
        },
    ])).toBe(
        "Contents of .vera/context-routes/api.md:\n\n"
            + "Use the shared error helper.\n\n"
            + "Contents of .vera/context-routes/web.md:\n\n"
            + "Keep the web client a sibling.",
    );
});

test("loadContextRoutes ignores about_to_run rows and keeps read rows", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "vera-routes-"));
    try {
        mkdirSync(join(workspace, ".vera"), { recursive: true });
        writeFileSync(
            join(workspace, ".vera", "context-routes.yaml"),
            [
                "routes:",
                "  - trigger:",
                "      read: src/api/**",
                "    consequence:",
                "      inject: context-routes/api.md",
                "  - trigger:",
                "      about_to_run: bun test",
                "      in: test/tui/**",
                "    consequence:",
                "      inject: context-routes/tui-tests.md",
                "",
            ].join("\n"),
        );
        expect(await loadContextRoutes(workspace)).toEqual([
            {
                readGlob: "src/api/**",
                injectRelative: "context-routes/api.md",
            },
        ]);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("an escaped inject path is skipped without disabling sibling routes", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "vera-routes-"));
    try {
        mkdirSync(join(workspace, ".vera"), { recursive: true });
        writeFileSync(
            join(workspace, ".vera", "context-routes.yaml"),
            [
                "routes:",
                "  - trigger:",
                "      read: src/api/**",
                "    consequence:",
                "      inject: context-routes/../secrets.md",
                "  - trigger:",
                "      read: src/web/**",
                "    consequence:",
                "      inject: not-in-context-routes.md",
                "  - trigger:",
                "      read: src/api/**",
                "    consequence:",
                "      inject: context-routes/api.md",
                "",
            ].join("\n"),
        );
        expect(await loadContextRoutes(workspace)).toEqual([
            {
                readGlob: "src/api/**",
                injectRelative: "context-routes/api.md",
            },
        ]);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("payloadsForSuccessfulReads collects matching files once in router order", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "vera-routes-"));
    try {
        mkdirSync(join(workspace, "src", "api"), { recursive: true });
        mkdirSync(join(workspace, ".vera", "context-routes"), { recursive: true });
        writeFileSync(
            join(workspace, ".vera", "context-routes.yaml"),
            [
                "routes:",
                "  - trigger:",
                "      read: src/api/**",
                "    consequence:",
                "      inject: context-routes/api.md",
                "  - trigger:",
                "      read: src/web/**",
                "    consequence:",
                "      inject: context-routes/web.md",
                "",
            ].join("\n"),
        );
        writeFileSync(
            join(workspace, ".vera", "context-routes", "api.md"),
            "Use the shared error helper.\n",
        );
        writeFileSync(
            join(workspace, ".vera", "context-routes", "web.md"),
            "Keep the web client a sibling.\n",
        );
        const first = await payloadsForSuccessfulReads(
            workspace,
            ["src/api/handler.ts", "src/api/nested/db.ts"],
            new Set(),
        );
        expect(first).toEqual([
            {
                injectPath: "context-routes/api.md",
                displayPath: ".vera/context-routes/api.md",
                content: "Use the shared error helper.\n",
            },
        ]);
        const both = await payloadsForSuccessfulReads(
            workspace,
            ["src/api/handler.ts", "src/web/app.ts"],
            new Set(),
        );
        expect(both?.map((payload) => payload.injectPath)).toEqual([
            "context-routes/api.md",
            "context-routes/web.md",
        ]);
        const skipped = await payloadsForSuccessfulReads(
            workspace,
            ["src/api/handler.ts"],
            new Set(["context-routes/api.md"]),
        );
        expect(skipped).toEqual([]);
        const missingPayload = await payloadsForSuccessfulReads(
            workspace,
            ["src/web/app.ts"],
            new Set(),
        );
        writeFileSync(
            join(workspace, ".vera", "context-routes.yaml"),
            [
                "routes:",
                "  - trigger:",
                "      read: src/api/**",
                "    consequence:",
                "      inject: context-routes/missing.md",
                "",
            ].join("\n"),
        );
        expect(await payloadsForSuccessfulReads(
            workspace,
            ["src/api/handler.ts"],
            new Set(),
        )).toEqual([]);
        expect(missingPayload?.map((payload) => payload.injectPath)).toEqual([
            "context-routes/web.md",
        ]);
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});

test("a missing yaml is empty routes and a corrupt yaml is fail closed", async () => {
    const workspace = mkdtempSync(join(tmpdir(), "vera-routes-"));
    try {
        expect(await loadContextRoutes(workspace)).toEqual([]);
        mkdirSync(join(workspace, ".vera"), { recursive: true });
        writeFileSync(join(workspace, ".vera", "context-routes.yaml"), "routes: [\n");
        expect(await loadContextRoutes(workspace)).toBeUndefined();
    } finally {
        rmSync(workspace, { recursive: true, force: true });
    }
});
