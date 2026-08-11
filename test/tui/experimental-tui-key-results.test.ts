import { expect, test } from "bun:test";

import { settleTuiExperimentalKeyResult } from "../../clients/tui/experimental-tui-key-results.ts";

test("experimental TUI key results repaint and preserve sync passthrough", () => {
    let repaints = 0;
    expect(settleTuiExperimentalKeyResult(true, {
        onRenderRequested: () => { repaints += 1; },
        onFailure() {},
    })).toBe(true);
    expect(settleTuiExperimentalKeyResult(false, {
        onRenderRequested: () => { repaints += 1; },
        onFailure() {},
    })).toBe(false);
    expect(repaints).toBe(2);
});

test("experimental TUI key results reject runtime promises without swallowing input", async () => {
    const failures: string[] = [];
    let repaints = 0;
    const invalidResult = Promise.reject(new Error("async key failed"));
    expect(settleTuiExperimentalKeyResult(
        invalidResult as unknown as boolean,
        {
            onRenderRequested: () => { repaints += 1; },
            onFailure: (error) => failures.push(String(error)),
        },
    )).toBe(false);
    await Promise.resolve();
    await Promise.resolve();
    expect(failures[0]).toContain("must return synchronously");
    expect(failures[1]).toContain("async key failed");
    expect(repaints).toBe(2);
});
