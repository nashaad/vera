import { expect, test } from "bun:test";

import { createTuiExperimentalEventBus } from "../../clients/tui/experimental-tui-events.ts";
import { STREAM_RENDER_INTERVAL_MS } from "../../clients/tui/frame-budget.ts";

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

test("experimental TUI stream deltas repaint once per render interval", async () => {
    let repaints = 0;
    const bus = createTuiExperimentalEventBus(
        () => {},
        () => { repaints += 1; },
    );
    bus.events.on("fixture", "agent_event", () => {});

    for (let index = 0; index < 200; index += 1) {
        bus.agentEvent({ type: "assistant_delta", text: "chunk" });
        bus.agentEvent({ type: "assistant_thinking", text: "chunk" });
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(repaints).toBe(0);

    await Bun.sleep(STREAM_RENDER_INTERVAL_MS * 3);
    expect(repaints).toBe(1);
    bus.clear();
});

test("experimental TUI events other than stream deltas repaint at once", async () => {
    let repaints = 0;
    const bus = createTuiExperimentalEventBus(
        () => {},
        () => { repaints += 1; },
    );
    bus.events.on("fixture", "agent_event", () => {});
    bus.events.on("fixture", "conversation_changed", () => {});

    bus.agentEvent({ type: "assistant_delta", text: "chunk" });
    bus.agentEvent({ type: "tool_started", tool: "read" });
    await Promise.resolve();
    await Promise.resolve();
    expect(repaints).toBe(1);

    bus.conversationChanged();
    await Promise.resolve();
    await Promise.resolve();
    expect(repaints).toBe(2);
    bus.clear();
});
