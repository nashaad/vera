import { expect, test } from "bun:test";

import { invokeTuiExperimentalAction } from "../../clients/tui/experimental-tui-actions.ts";

const context = {
    workspace: "/workspace",
    focused: false,
    theme: {
        text: "text",
        muted: "muted",
        accent: "accent",
        notice: "notice",
        success: "success",
        panel: "panel",
    },
    transcript: [],
};

test("experimental TUI actions request repaint after success and async failure", async () => {
    const failures: unknown[] = [];
    let repaints = 0;
    await invokeTuiExperimentalAction({
        action: "open",
        context,
        onAction: async () => {
            throw new Error("async action failed");
        },
        onFailure: (error) => failures.push(error),
        onRenderRequested: () => { repaints += 1; },
    });
    expect(failures).toHaveLength(1);
    expect(repaints).toBe(1);
});

test("experimental TUI actions isolate synchronous throws", async () => {
    const failures: unknown[] = [];
    let repaints = 0;
    await invokeTuiExperimentalAction({
        action: "open",
        context,
        onAction: () => {
            throw new Error("sync action failed");
        },
        onFailure: (error) => failures.push(error),
        onRenderRequested: () => { repaints += 1; },
    });
    expect(failures).toHaveLength(1);
    expect(repaints).toBe(1);
});
