import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { startTui } from "../../clients/tui/main.ts";
import type { TuiAgentClient } from "../../clients/tui/agent-client.ts";
import type {
    AgentUpdate,
    TranscriptEntry,
} from "../../src/engine/protocol.ts";
import type {
    TuiFlightEvent,
    TuiFlightRecorder,
} from "../../clients/tui/flight-recorder.ts";

const REPLAY_ENTRIES = 400;

function recordingFlightRecorder(
    events: TuiFlightEvent[],
): TuiFlightRecorder {
    return {
        instanceId: "test",
        logPath: "/dev/null",
        record: (event) => {
            events.push(event);
        },
        sessionEntered: () => {},
        close: () => {},
    };
}

function transcript(): TranscriptEntry[] {
    const entries: TranscriptEntry[] = [];
    for (let index = 0; index < REPLAY_ENTRIES; index += 1) {
        entries.push({ kind: "user", text: `prompt ${index}` });
        entries.push({ kind: "assistant", text: `answer ${index}` });
    }
    return entries;
}

/** Replays a large history, then stalls so the TUI keeps running. */
function replayingClient(): TuiAgentClient {
    const queued: AgentUpdate[] = [
        { type: "history", entries: transcript(), seq: 0 },
    ];
    for (let index = 0; index < 40; index += 1) {
        queued.push({
            type: "history",
            entries: transcript(),
            seq: 0,
        });
    }
    return {
        agentId: "replay",
        workspace: process.cwd(),
        async send(): Promise<void> {},
        async receive(): Promise<AgentUpdate> {
            const next = queued.shift();
            if (next !== undefined) return next;
            return await new Promise<AgentUpdate>(() => {});
        },
        async detach(): Promise<void> {},
        close(): void {},
    };
}

test("a large replay does not storm focus events", async () => {
    const events: TuiFlightEvent[] = [];
    const setup = await createTestRenderer({ width: 100, height: 35 });
    const exit = startTui({
        client: replayingClient(),
        copyText: async () => undefined,
        createRenderer: async () => setup.renderer,
        flightRecorder: recordingFlightRecorder(events),
    });

    for (let pass = 0; pass < 60; pass += 1) {
        await Bun.sleep(20);
        await setup.renderOnce();
        if (setup.captureCharFrame().includes("answer 399")) break;
    }

    const focusEvents = events.filter((event) =>
        event.type === "focus_changed"
    );
    expect(focusEvents.length).toBeLessThan(10);

    setup.renderer.stop();
    void exit.catch(() => undefined);
}, 20_000);
