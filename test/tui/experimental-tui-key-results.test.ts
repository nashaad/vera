import { expect, test } from "bun:test";

import { settleTuiExperimentalKeyResult } from "../../clients/tui/experimental-tui-key-results.ts";

test("experimental TUI key results repaint after sync and async handling", async () => {
    let repaints = 0;
    expect(settleTuiExperimentalKeyResult(true, {
        onRenderRequested: () => { repaints += 1; },
        onFailure() {},
    })).toBe(true);
    expect(settleTuiExperimentalKeyResult(Promise.resolve(false), {
        onRenderRequested: () => { repaints += 1; },
        onFailure() {},
    })).toBe(true);
    await Promise.resolve();
    expect(repaints).toBe(2);
});

test("experimental TUI key results report async failures", async () => {
    const failures: unknown[] = [];
    const handled = settleTuiExperimentalKeyResult(
        Promise.reject(new Error("key failed")),
        {
            onRenderRequested() {},
            onFailure: (error) => failures.push(error),
        },
    );
    expect(handled).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(failures).toHaveLength(1);
});
