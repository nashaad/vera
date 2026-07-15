import { expect, test } from "bun:test";

import { ToolRuntime } from "../../src/tools/runtime.ts";

test("file mutations execute in queue order", async () => {
    const runtime = new ToolRuntime("/unused");
    const events: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
        releaseFirst = resolve;
    });

    const first = runtime.enqueueFileMutation(async () => {
        events.push("first started");
        await firstCanFinish;
        events.push("first finished");
    });
    const second = runtime.enqueueFileMutation(async () => {
        events.push("second started");
    });

    await Promise.resolve();
    expect(events).toEqual(["first started"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
        "first started",
        "first finished",
        "second started",
    ]);
});

test("a failed file mutation does not block the queue", async () => {
    const runtime = new ToolRuntime("/unused");
    const failed = runtime.enqueueFileMutation(async () => {
        throw new Error("failed mutation");
    });
    const recovered = runtime.enqueueFileMutation(async () => "completed");

    expect(failed).rejects.toThrow("failed mutation");
    expect(await recovered).toBe("completed");
});
