import { expect, test } from "bun:test";

import { createTuiExperimentalEventBus } from "../../clients/tui/experimental-tui-events.ts";

test("experimental TUI events repaint after async listener settlement", async () => {
    const requests: string[] = [];
    let settled = false;
    const bus = createTuiExperimentalEventBus(
        () => {},
        (updateType) => { requests.push(updateType); },
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
    expect(requests).toEqual(["agent_event"]);
});

test("a synchronous listener requests its render before fire returns", () => {
    const requests: string[] = [];
    const bus = createTuiExperimentalEventBus(
        () => {},
        (updateType) => { requests.push(updateType); },
    );
    bus.events.on("fixture", "agent_event", () => {});

    bus.agentEvent({ type: "turn_finished" });
    expect(requests).toEqual(["agent_event"]);
});

test("experimental TUI transcript listeners fire only when a message changes", () => {
    const bus = createTuiExperimentalEventBus(() => {}, () => {});
    let fired = 0;
    bus.events.on("fixture", "transcript_changed", () => { fired += 1; });

    bus.transcriptChanged([{ role: "user", text: "where is the compass" }]);
    bus.transcriptChanged([{ role: "user", text: "where is the compass" }]);
    expect(fired).toBe(1);

    bus.transcriptChanged([
        { role: "user", text: "where is the compass" },
        { role: "assistant", text: "the crow" },
    ]);
    bus.transcriptChanged([
        { role: "user", text: "where is the compass" },
        { role: "assistant", text: "the crow has it" },
    ]);
    expect(fired).toBe(3);
});

test("agent events share one repaint token regardless of their update type", async () => {
    const requests: string[] = [];
    const bus = createTuiExperimentalEventBus(
        () => {},
        (updateType) => { requests.push(updateType); },
    );
    bus.events.on("fixture", "agent_event", () => {});

    bus.agentEvent({ type: "assistant_delta", text: "chunk" });
    bus.agentEvent({ type: "assistant_thinking", text: "chunk" });
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toEqual(["agent_event", "agent_event"]);

    bus.clear();
    bus.agentEvent({ type: "assistant_delta", text: "chunk" });
    await Promise.resolve();
    await Promise.resolve();
    expect(requests).toHaveLength(2);
});
