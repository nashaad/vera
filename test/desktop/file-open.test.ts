import { afterEach, describe, expect, test } from "bun:test";

import { defaultLayout } from "../../clients/ui/src/layout/model.ts";
import { reduceLayout, type LayoutAction } from "../../clients/ui/src/layout/reducer.ts";
import { resolveLayout } from "../../clients/ui/src/layout/resolve.ts";
import { ContributionRegistry } from "../../clients/ui/src/registry/contributions.ts";
import { CORE_CONTAINERS, registerCoreContributions } from "../../clients/ui/src/registry/core.ts";
import { clearFileOpenForTest, firstNewSideLine, openFileInFiles, requestFileOpen, subscribeFileOpen } from "../../clients/ui/src/session/fileOpen.ts";

afterEach(() => clearFileOpenForTest());

describe("file open requests", () => {
    test("delivers the requested path and line to current subscribers", () => {
        const received: Array<[string, number | undefined]> = [];
        const unsubscribe = subscribeFileOpen("session-a", (path, line) => received.push([path, line]));

        requestFileOpen("session-a", "/repo/file.ts", 17);

        expect(received).toEqual([["/repo/file.ts", 17]]);
        unsubscribe();
    });

    test("retargets repeated opens of the same path", () => {
        const received: Array<[string, number | undefined]> = [];
        const unsubscribe = subscribeFileOpen("session-a", (path, line) => received.push([path, line]));

        requestFileOpen("session-a", "/repo/file.ts", 4);
        requestFileOpen("session-a", "/repo/file.ts", 19);

        expect(received).toEqual([["/repo/file.ts", 4], ["/repo/file.ts", 19]]);
        unsubscribe();
    });

    test("delivers one pending request when the session subscribes", () => {
        requestFileOpen("session-a", "/repo/file.ts", 9);
        const received: Array<[string, number | undefined]> = [];

        const unsubscribe = subscribeFileOpen("session-a", (path, line) => received.push([path, line]));

        expect(received).toEqual([["/repo/file.ts", 9]]);
        unsubscribe();
    });

    test("reveals the existing Files pane and delivers the target without adding a pane tab", () => {
        const registry = new ContributionRegistry();
        registerCoreContributions(registry);
        const contributions = registry.snapshot();
        let state = reduceLayout(defaultLayout(), { type: "openTab", container: CORE_CONTAINERS.files }, contributions);
        const filesTab = state.tabs[0]?.id;
        state = reduceLayout(state, { type: "openTab", container: CORE_CONTAINERS.review }, contributions);
        const actions: LayoutAction[] = [];
        const received: Array<[string, number | undefined]> = [];
        const unsubscribe = subscribeFileOpen("session-a", (path, line) => received.push([path, line]));

        openFileInFiles({
            layout: resolveLayout(state, contributions),
            dispatch: (action) => {
                actions.push(action);
                state = reduceLayout(state, action, contributions);
            },
        }, "session-a", "/repo/file.ts", 17);

        expect(received).toEqual([["/repo/file.ts", 17]]);
        expect(state.tabs.filter((tab) => tab.container === CORE_CONTAINERS.files)).toHaveLength(1);
        expect(state.locations.rightPane.active).toBe(filesTab);
        expect(actions.at(-1)).toEqual({ type: "activateContainer", container: CORE_CONTAINERS.files });
        unsubscribe();
    });

    test("targets the first hunk with new-side lines", () => {
        expect(firstNewSideLine([
            { additionStart: 2, additionCount: 0 },
            { additionStart: 14, additionCount: 3 },
        ])).toBe(14);
    });

    test("uses a valid line boundary when every hunk only removes lines", () => {
        expect(firstNewSideLine([{ additionStart: 0, additionCount: 0 }])).toBe(1);
        expect(firstNewSideLine([])).toBeUndefined();
    });
});
