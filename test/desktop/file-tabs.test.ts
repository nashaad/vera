import { describe, expect, test } from "bun:test";

import {
    activateFileTab,
    closeAllFileTabs,
    closeFileTab,
    DEFAULT_FILE_MENU_SETTINGS,
    emptyFileTabs,
    fileTabLabels,
    FILE_TAB_LIMIT,
    openFileTab,
    setFileTabMode,
    updateFileMenuSettings,
} from "../../clients/ui/src/views/file-tabs.ts";

describe("Files tabs", () => {
    test("@core a preview is replaced by the next preview, while kept opens remain", () => {
        let state = emptyFileTabs();
        state = openFileTab(state, "/work/src/one.ts", { preview: true });
        state = openFileTab(state, "/work/src/two.ts", { preview: true });
        expect(state.tabs.map((tab) => tab.path)).toEqual(["/work/src/two.ts"]);
        state = openFileTab(state, "/work/src/two.ts", { keep: true });
        state = openFileTab(state, "/work/src/three.ts", { preview: true });
        expect(state.tabs.map((tab) => [tab.path, tab.preview])).toEqual([
            ["/work/src/two.ts", false],
            ["/work/src/three.ts", true],
        ]);
    });

    test("opening an existing kept tab does not close the current preview", () => {
        let state = openFileTab(emptyFileTabs(), "/work/kept.ts", { keep: true });
        state = openFileTab(state, "/work/preview.ts", { preview: true });
        state = openFileTab(state, "/work/kept.ts", { preview: true });
        expect(state.tabs.map((tab) => [tab.path, tab.preview])).toEqual([
            ["/work/kept.ts", false],
            ["/work/preview.ts", true],
        ]);
    });

    test("a requested open keeps a preview, and preview-off opens are kept", () => {
        let state = openFileTab(emptyFileTabs(), "/work/a.ts", { preview: true });
        state = openFileTab(state, "/work/a.ts", { keep: true });
        state = openFileTab(state, "/work/b.ts");
        expect(state.tabs.map((tab) => tab.preview)).toEqual([false, false]);
    });

    test("@core the cap evicts the least recently used kept tab and protects active", () => {
        let state = emptyFileTabs();
        for (let index = 0; index < FILE_TAB_LIMIT; index += 1) {
            state = openFileTab(state, `/work/${index}.ts`);
        }
        state = activateFileTab(state, "/work/0.ts");
        state = openFileTab(state, "/work/new.ts");
        expect(state.tabs).toHaveLength(FILE_TAB_LIMIT);
        expect(state.tabs.some((tab) => tab.path === "/work/0.ts")).toBe(true);
        expect(state.tabs.some((tab) => tab.path === "/work/1.ts")).toBe(false);
        expect(state.activePath).toBe("/work/new.ts");
    });

    test("Source and Preview mode stays with an open tab and is released on close", () => {
        let state = openFileTab(emptyFileTabs(), "/work/a.html");
        expect(state.tabs[0]?.mode).toBe("source");
        state = setFileTabMode(state, "/work/a.html", "preview");
        state = openFileTab(state, "/work/b.html");
        state = activateFileTab(state, "/work/a.html");
        expect(state.tabs.find((tab) => tab.path === "/work/a.html")?.mode).toBe("preview");
        state = closeFileTab(state, "/work/a.html");
        state = openFileTab(state, "/work/a.html");
        expect(state.tabs.find((tab) => tab.path === "/work/a.html")?.mode).toBe("source");
    });

    test("closing tabs selects the most recently used remaining tab; close-all clears", () => {
        let state = emptyFileTabs();
        state = openFileTab(state, "/work/a.ts");
        state = openFileTab(state, "/work/b.ts");
        state = activateFileTab(state, "/work/a.ts");
        state = closeFileTab(state, "/work/a.ts");
        expect(state.activePath).toBe("/work/b.ts");
        state = closeAllFileTabs(state);
        expect(state.tabs).toEqual([]);
        expect(state.activePath).toBeNull();
    });

    test("labels add the shortest parent suffix only for basename collisions", () => {
        expect(fileTabLabels(["/a/src/index.ts", "/b/test/index.ts", "/a/readme.md"])).toEqual([
            { path: "/a/src/index.ts", label: "src/index.ts" },
            { path: "/b/test/index.ts", label: "test/index.ts" },
            { path: "/a/readme.md", label: "readme.md" },
        ]);
    });
});

describe("Files menu settings", () => {
    test("defaults to preview tabs, word wrap, a right tree, and tab size four", () => {
        expect(DEFAULT_FILE_MENU_SETTINGS).toEqual({
            previewTabs: true,
            wordWrap: true,
            treePosition: "right",
            scrollPastEnd: false,
            tabSize: 4,
        });
    });

    test("updates allowed menu settings without exposing excluded options", () => {
        expect(updateFileMenuSettings(DEFAULT_FILE_MENU_SETTINGS, {
            previewTabs: false,
            treePosition: "left",
            scrollPastEnd: true,
            tabSize: 8,
        })).toEqual({
            previewTabs: false,
            wordWrap: true,
            treePosition: "left",
            scrollPastEnd: true,
            tabSize: 8,
        });
    });
});
