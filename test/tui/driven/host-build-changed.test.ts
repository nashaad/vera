import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/main.ts";
import type { TuiFlightEvent, TuiFlightRecorder } from "../../../clients/tui/flight-recorder.ts";
import { AsyncQueue } from "../../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import { HostBuildChangedError } from "../../../src/host/reconnecting-agent-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

const home = () => mkdtempSync(join(tmpdir(), "vera-host-build-changed-"));
const REFUSAL = "The Vera host is now build vera-kraken-2, and this TUI is build vera-crow-1.";

function droppingClient(failure: Error): TuiAgentClient {
    const updates = new AsyncQueue<AgentUpdate>();
    updates.push({ type: "history", entries: [{ kind: "assistant", text: "Ahoy from the crow's nest." }], seq: 0 });
    updates.push({ type: "status", state: "idle", seq: 1 });
    updates.fail(failure);
    return {
        agentId: "agent-1",
        async send(): Promise<void> {},
        receive: (signal) => updates.receive(signal),
        async detach(): Promise<void> {},
        close(): void {},
    };
}

function recordingFlightRecorder(events: TuiFlightEvent[]): TuiFlightRecorder {
    return {
        instanceId: "host-build-changed",
        logPath: "/dev/null",
        record: (event) => { events.push(event); },
        sessionEntered: () => {},
        close: () => {},
    };
}

test("a host that came back as another build stays disconnected and says to reopen, without a restart", async () => {
    const events: TuiFlightEvent[] = [];
    let restarts = 0;
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30,
        dependencies: () => ({
            client: droppingClient(new HostBuildChangedError("vera-crow-1", "vera-kraken-2")),
            reconnectSession: async () => {
                restarts += 1;
                throw new Error("the TUI should not restart onto another build");
            },
            flightRecorder: recordingFlightRecorder(events),
        }),
    });
    try {
        const pane = await session.waitForVisiblePane("Quit and reopen Vera to continue.");
        expect(pane).toContain(REFUSAL);
        expect(pane).toContain("disconnected: host is a different build · quit and reopen Vera · Ctrl+C quit");
        expect(pane).not.toContain("Ctrl+P reconnect");
        expect(pane).not.toContain("restarting host");
        expect(restarts).toBe(0);
        expect(events.filter((event) => event.type === "host_build_changed"))
            .toEqual([{ type: "host_build_changed", clientBuildId: "vera-crow-1", hostBuildId: "vera-kraken-2" }]);
    } finally { await session.close(); }
}, 15_000);

test("an automatic restart that finds another build refuses with the same message", async () => {
    let restarts = 0;
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30,
        dependencies: () => ({
            client: droppingClient(new Error("host connection closed")),
            reconnectSession: async () => {
                restarts += 1;
                throw new HostBuildChangedError("vera-crow-1", "vera-kraken-2");
            },
        }),
    });
    try {
        const pane = await session.waitForVisiblePane("Quit and reopen Vera to continue.");
        expect(pane).toContain(REFUSAL);
        expect(pane).toContain("disconnected: host is a different build");
        expect(pane).not.toContain("Could not reconnect");
        expect(restarts).toBe(1);
    } finally { await session.close(); }
}, 15_000);

test("Reconnect host after the refusal refuses again instead of starting another build's client", async () => {
    const events: TuiFlightEvent[] = [];
    let reconnects = 0;
    const session = await startTuiTestSession({ home: home(), width: 140, height: 30,
        dependencies: () => ({
            client: droppingClient(new HostBuildChangedError("vera-crow-1", "vera-kraken-2")),
            reconnectSession: async () => {
                reconnects += 1;
                throw new HostBuildChangedError("vera-crow-1", "vera-kraken-2");
            },
            flightRecorder: recordingFlightRecorder(events),
        }),
    });
    try {
        await session.waitForVisiblePane("Quit and reopen Vera to continue.");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("reconnect host");
        await session.waitForVisiblePane("Reconnect host");
        session.sendKey("Enter");
        const deadline = Date.now() + 5_000;
        while (events.filter((event) => event.type === "host_build_changed").length < 2 && Date.now() < deadline) {
            await session.settle();
        }
        const pane = await session.waitForVisiblePane("disconnected: host is a different build · quit and reopen Vera");
        expect(reconnects).toBe(1);
        expect(events.filter((event) => event.type === "host_build_changed")).toHaveLength(2);
        expect(pane).not.toContain("Could not reconnect");
        expect(pane).not.toContain("restarting host");
    } finally { await session.close(); }
}, 15_000);

test("diagnostics after the refusal show the refused build and not the old host process", async () => {
    const session = await startTuiTestSession({ home: home(), width: 140, height: 52,
        dependencies: () => ({
            client: droppingClient(new HostBuildChangedError("vera-crow-1", "vera-kraken-2")),
            build: {
                clientVersion: "vera-crow-1",
                hostBuildId: "vera-crow-1",
                hostPid: 4242,
                hostStartedAt: "2026-11-03T09:00:00.000Z",
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Quit and reopen Vera to continue.");
        session.sendText("/diagnostics");
        session.sendKey("Enter");
        await session.waitForVisiblePane("This conversation");
        session.sendKey("Down");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("BUILD");
        expect(pane).toContain("vera-kraken-2");
        expect(pane).not.toContain("4242");
    } finally { await session.close(); }
}, 15_000);
