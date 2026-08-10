import { expect, test } from "bun:test";

import {
    isTuiExperimentalViewVisible,
    tuiExperimentalViewSignature,
} from "../../clients/tui/experimental-tui-view-state.ts";

test("experimental TUI view state isolates visibility failures", () => {
    const failures: string[] = [];
    expect(isTuiExperimentalViewVisible({
        extensionId: "broken",
        visible: () => {
            throw new Error("visibility failed");
        },
        onFailure: (extensionId, message) => {
            failures.push(`${extensionId}:${message}`);
        },
    })).toBe(false);
    expect(failures).toEqual(["broken:visibility failed"]);
});

test("experimental TUI view state signatures include render inputs", () => {
    const signature = tuiExperimentalViewSignature(
        { kind: "text", text: "hello" },
        true,
        {
            text: "text",
            muted: "muted",
            accent: "accent",
            notice: "notice",
            success: "success",
            panel: "panel",
        },
    );
    expect(signature).toContain("hello");
    expect(signature).toContain("true");
});
