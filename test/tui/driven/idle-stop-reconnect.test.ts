import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/agent-client.ts";
import { AsyncQueue } from "../../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import type { HostStopWaitEvent } from "../../../src/host/protocol.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

function controlledClient(label: string) {
    const updates = new AsyncQueue<AgentUpdate>();
    updates.push({ type: "history", entries: [{ kind: "assistant", text: label }], seq: 0 });
    const listeners = new Set<(event: HostStopWaitEvent) => void>();
    const client: TuiAgentClient = {
        agentId: "crow-session",
        async send() {},
        receive: (signal) => updates.receive(signal),
        onStopWait(listener) {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        async detach() {},
        close() {},
    };
    return {
        client,
        notice: (event: HostStopWaitEvent) => { for (const listener of listeners) listener(event); },
        drop: () => updates.fail(new Error("Host connection closed")),
    };
}

for (const method of ["Ctrl+L", "Reconnect host"] as const) {
    test(`idle stop waits for ${method} before reconnecting`, async () => {
        const initial = controlledClient("First crow voyage");
        const recovered = controlledClient("Crow voyage reconnected");
        let restarts = 0;
        const session = await startTuiTestSession({
            home: mkdtempSync(join(tmpdir(), "vera-idle-stop-")),
            dependencies: () => ({
                client: initial.client,
                reconnectSession: async () => { restarts += 1; return recovered.client; },
            }),
        });
        try {
            await session.waitForVisiblePane("First crow voyage");
            initial.notice({ type: "host_stop_wait_cleared", reason: "stopped" });
            initial.drop();
            const pane = await session.waitForVisiblePane("The host stopped.");
            expect(pane).toContain("host stopped");
            await session.settle(400);
            expect(restarts).toBe(0);
            if (method === "Ctrl+L") {
                session.sendKey("C-l");
            } else {
                session.sendKey("C-p");
                await session.waitForVisiblePane("Commands");
                session.sendText("reconnect host");
                await session.waitForVisiblePane("Reconnect host");
                session.sendKey("Enter");
            }
            await session.waitForVisiblePane("Crow voyage reconnected");
            expect(restarts).toBe(1);
        } finally {
            await session.close();
        }
    }, 15_000);
}

test("a restart notice after an idle stop still reconnects", async () => {
    const initial = controlledClient("First crow voyage");
    const recovered = controlledClient("Crow voyage after restart");
    let restarts = 0;
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-idle-restart-")),
        dependencies: () => ({
            client: initial.client,
            reconnectSession: async () => { restarts += 1; return recovered.client; },
        }),
    });
    try {
        await session.waitForVisiblePane("First crow voyage");
        initial.notice({ type: "host_stop_wait_cleared", reason: "stopped" });
        initial.notice({ type: "host_restarting", build_id: "next-build" });
        initial.drop();
        await session.waitForVisiblePane("Crow voyage after restart");
        expect(restarts).toBe(1);
    } finally {
        await session.close();
    }
}, 15_000);

test("a second stop in the same TUI names the current waiting session", async () => {
    const initial = controlledClient("First voyage");
    const recovered = controlledClient("Second voyage");
    let cuts = 0;
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-repeat-stop-")),
        waitTimeoutMs: 2_000,
        dependencies: () => ({
            client: initial.client,
            reconnectSession: async () => recovered.client,
            cutStopWait: async () => { cuts += 1; return { type: "cut_stop_wait_done", cut: [], failed: [] }; },
        }),
    });
    try {
        await session.waitForVisiblePane("First voyage");
        initial.notice({
            type: "host_stop_wait", kind: "stop",
            waiting_on: [{ session_id: "first-session", name: null, status: "working" }],
        });
        await session.waitForVisiblePane("Waiting for first-session.");
        initial.notice({
            type: "host_stop_wait", kind: "stop",
            waiting_on: [{ session_id: "updated-session", name: null, status: "working" }],
        });
        await session.waitForVisiblePane("Waiting for updated-session.");
        session.sendKey("Down");
        session.sendKey("Escape");
        initial.notice({ type: "host_stop_wait_cleared", reason: "stopped" });
        initial.drop();
        await session.waitForVisiblePane("The host stopped.");
        session.sendKey("C-l");
        await session.waitForVisiblePane("Second voyage");
        recovered.notice({
            type: "host_stop_wait", kind: "stop",
            waiting_on: [{ session_id: "second-session", name: null, status: "working" }],
        });
        const pane = await session.waitForVisiblePane("Waiting for second-session.");
        expect(pane).not.toContain("Waiting for first-session.");
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere((text) => !text.includes("Vera is stopping."), "stop card dismissed");
        expect(cuts).toBe(0);
    } finally {
        await session.close();
    }
}, 15_000);
