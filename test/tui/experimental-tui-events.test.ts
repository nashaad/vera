import { expect, test } from "bun:test";

import { createTuiExperimentalEventBus } from "../../clients/tui/experimental-tui-events.ts";

test("experimental TUI events repaint after async listener settlement", async () => {
    let repaints = 0;
    let settled = false;
    const bus = createTuiExperimentalEventBus(
        () => {},
        () => { repaints += 1; },
    );
    bus.events.on("fixture", "agent_event", async () => {
        await Promise.resolve();
        settled = true;
    });

    bus.agentEvent({ type: "turn_finished" });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(true);
    expect(repaints).toBe(1);
});

test("experimental TUI events preserve transcript serialization failures", () => {
    const bus = createTuiExperimentalEventBus(() => {}, () => {});
    const transcript = [{ role: "user", text: "hello" }] as unknown as Array<{
        role: "user";
        text: string;
        loop?: unknown;
    }>;
    transcript[0]!.loop = transcript;

    expect(() => bus.transcriptChanged(transcript)).toThrow();
});
