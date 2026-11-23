import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
    DIFF_FILE_COPY_PATH,
    DIFF_FILE_OPEN,
    DIFF_FILE_TOGGLE,
    DiffFileMenu,
    fileMenuEntries,
    isAbsolutePath,
    runFileMenuCommand,
} from "../../clients/ui/src/session/DiffFileMenu.tsx";

test("@core diff file menu offers copy, open and collapse", () => {
    const closed = fileMenuEntries(false, true);
    expect(closed.map((entry) => entry.kind === "item" ? entry.label : "")).toEqual([
        "Copy path",
        "Open in default app",
        "Expand file",
    ]);
    expect(closed[1]).toMatchObject({ kind: "item", disabled: false });
    const open = fileMenuEntries(true, false);
    expect(open[1]).toMatchObject({ kind: "item", disabled: true });
    expect(open[2]).toMatchObject({ kind: "item", label: "Collapse file" });
});

test("@core diff file menu opens the recorded file itself and names it on failure", async () => {
    const opened: string[] = [];
    const notices: string[] = [];
    await runFileMenuCommand(DIFF_FILE_OPEN, "/Users/nash/crow.ts", {
        onToggle: () => {},
        reveal: async (path) => {
            opened.push(path);
            return false;
        },
        notify: (text) => { notices.push(text); },
    });
    expect(opened).toEqual(["/Users/nash/crow.ts"]);
    expect(notices).toEqual(["Could not open crow.ts"]);

    await runFileMenuCommand(DIFF_FILE_OPEN, "/Users/nash/gull.ts", {
        onToggle: () => {},
        reveal: async () => true,
        notify: (text) => { notices.push(text); },
    });
    expect(notices).toEqual(["Could not open crow.ts"]);

    const relative: string[] = [];
    await runFileMenuCommand(DIFF_FILE_OPEN, "src/crow.ts", {
        onToggle: () => {},
        reveal: async (path) => {
            relative.push(path);
            return true;
        },
    });
    expect(relative).toEqual([]);
});

test("@core diff file menu recognizes absolute paths for open", () => {
    expect(isAbsolutePath("/Users/nash/crow.ts")).toBe(true);
    expect(isAbsolutePath("C:\\crow\\nest.ts")).toBe(true);
    expect(isAbsolutePath("C:/crow/nest.ts")).toBe(true);
    expect(isAbsolutePath("\\\\ship\\share\\crow.ts")).toBe(true);
    expect(isAbsolutePath("src/crow.ts")).toBe(false);
    expect(isAbsolutePath("~/crow.ts")).toBe(false);
});

test("@core diff file menu copies the recorded path and reports a refusal", async () => {
    const copied: string[] = [];
    const notices: string[] = [];
    await runFileMenuCommand(DIFF_FILE_COPY_PATH, "src/crow.ts", {
        onToggle: () => {},
        copy: async (text) => {
            copied.push(text);
            return true;
        },
        notify: (text) => { notices.push(text); },
    });
    expect(copied).toEqual(["src/crow.ts"]);
    expect(notices).toEqual([]);

    await runFileMenuCommand(DIFF_FILE_COPY_PATH, "src/crow.ts", {
        onToggle: () => {},
        copy: async () => false,
        notify: (text) => { notices.push(text); },
    });
    expect(notices).toEqual(["The path could not be copied"]);
});

test("@core diff file menu toggles the file's open state", async () => {
    let toggled = 0;
    await runFileMenuCommand(DIFF_FILE_TOGGLE, "/Users/nash/crow.ts", {
        onToggle: () => { toggled += 1; },
    });
    expect(toggled).toBe(1);
});

test("@core diff file menu button is reachable and closed until opened", () => {
    const html = renderToStaticMarkup(createElement(DiffFileMenu, {
        path: "/Users/nash/crow.ts",
        open: false,
        onToggle: () => {},
        reveal: async () => true,
    }));
    expect(html).toContain('aria-label="File actions for /Users/nash/crow.ts"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('title="File actions"');
    expect(html).not.toContain('role="menu"');
});
