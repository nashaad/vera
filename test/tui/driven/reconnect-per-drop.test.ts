import { expect, jest, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/agent-client.ts";
import { requestAgentSettings } from "../../../clients/tui/main/diagnostics-ops.ts";
import type { TuiRuntime } from "../../../clients/tui/main/runtime.ts";
import { AsyncQueue } from "../../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

interface ControlledClient {
    readonly client: TuiAgentClient;
    drop(): void;
    reconnectTransparently(): void;
}

function controlledClient(label: string): ControlledClient {
    let updates = new AsyncQueue<AgentUpdate>();
    let transparentUpdates: AsyncQueue<AgentUpdate> | undefined;
    let sequence = 0;
    let announced = false;
    updates.push({ type: "history", entries: [], seq: sequence++ });

    function announce(): void {
        if (announced) return;
        announced = true;
        setTimeout(() => {
            updates.push({
                type: "history",
                entries: [{ kind: "assistant", text: `${label} healthy` }],
                seq: sequence++,
            });
        }, 0);
    }

    return {
        client: {
            agentId: "agent-1",
            async send(command): Promise<void> {
                if (command.type === "get_model_settings") {
                    updates.push({
                        type: "model_settings_rejected",
                        requestId: command.requestId,
                        reason: "unavailable",
                        seq: sequence++,
                    });
                    announce();
                } else if (command.type === "prompt") {
                    updates.push({ type: "user_prompt", content: command.content, seq: sequence++ });
                    updates.push({ type: "turn_finished", seq: sequence++ });
                    updates.push({
                        type: "history",
                        entries: [{ kind: "assistant", text: `${label} turn completed` }],
                        seq: sequence++,
                    });
                }
            },
            async receive(signal): Promise<AgentUpdate> {
                try {
                    return await updates.receive(signal);
                } catch (error) {
                    if (transparentUpdates === undefined) throw error;
                    updates = transparentUpdates;
                    transparentUpdates = undefined;
                    return updates.receive(signal);
                }
            },
            async detach(): Promise<void> {},
            close(): void {},
        },
        drop() {
            updates.fail(new Error(`${label} host dropped`));
        },
        reconnectTransparently() {
            transparentUpdates = new AsyncQueue<AgentUpdate>();
            transparentUpdates.push({
                type: "history",
                entries: [{ kind: "assistant", text: `${label} transparently reattached` }],
                seq: sequence++,
            });
            updates.fail(new Error("transport interrupted"));
        },
    };
}

function dyingClient(): TuiAgentClient {
    const updates = new AsyncQueue<AgentUpdate>();
    updates.push({ type: "history", entries: [], seq: 0 });
    updates.push({ type: "status", state: "idle", seq: 1 });
    updates.push({
        type: "model_settings_rejected",
        requestId: "earlier-request",
        reason: "unavailable",
        seq: 2,
    });
    updates.fail(new Error("replacement died before becoming healthy"));
    return {
        agentId: "agent-1",
        async send(): Promise<void> {},
        receive: (signal) => updates.receive(signal),
        async detach(): Promise<void> {},
        close(): void {},
    };
}

function interruptedProbeClient(): ControlledClient {
    let updates = new AsyncQueue<AgentUpdate>();
    let nextUpdates: AsyncQueue<AgentUpdate> | undefined;
    let reattached = false;
    let sequence = 0;
    updates.push({
        type: "history",
        entries: [{ kind: "assistant", text: "replacement awaiting reply" }],
        seq: sequence++,
    });
    return {
        client: {
            agentId: "agent-1",
            async send(command): Promise<void> {
                if (command.type !== "get_model_settings" || !reattached) return;
                updates.push({
                    type: "model_settings_rejected",
                    requestId: command.requestId,
                    reason: "unavailable",
                    seq: sequence++,
                });
                updates.push({
                    type: "history",
                    entries: [{ kind: "assistant", text: "replacement healthy after retry" }],
                    seq: sequence++,
                });
            },
            async receive(signal): Promise<AgentUpdate> {
                try {
                    return await updates.receive(signal);
                } catch (error) {
                    if (nextUpdates === undefined) throw error;
                    updates = nextUpdates;
                    nextUpdates = undefined;
                    return updates.receive(signal);
                }
            },
            async detach(): Promise<void> {},
            close(): void {},
        },
        drop() {
            updates.fail(new Error("replacement host dropped"));
        },
        reconnectTransparently() {
            reattached = true;
            nextUpdates = new AsyncQueue<AgentUpdate>();
            nextUpdates.push({ type: "status", state: "working", seq: sequence++ });
            updates.fail(new Error("transport interrupted before the reply"));
        },
    };
}

function home(): string {
    return mkdtempSync(join(tmpdir(), "vera-tui-per-drop-"));
}

function unansweredSettingsClient(): {
    readonly client: TuiAgentClient;
    readonly requests: string[];
    readonly runtime: TuiRuntime;
} {
    const requests: string[] = [];
    const client: TuiAgentClient = {
        agentId: "agent-1",
        async send(command): Promise<void> {
            if (command.type === "get_model_settings") requests.push(command.requestId);
        },
        async receive(): Promise<AgentUpdate> {
            throw new Error("No updates are expected");
        },
        async detach(): Promise<void> {},
        close(): void {},
    };
    const runtime = {
        client,
        hostReconnectAttempted: true,
        sessionSwitchPending: false,
        shuttingDown: false,
        connectionFailed: false,
    } as TuiRuntime;
    return { client, requests, runtime };
}

async function advanceProbeTimers(steps: number): Promise<void> {
    for (let step = 0; step < steps; step += 1) {
        jest.advanceTimersByTime(500);
        await Promise.resolve();
    }
}

test("an unanswered health probe stops after ten resends", async () => {
    jest.useFakeTimers();
    try {
        const { client, requests, runtime } = unansweredSettingsClient();
        requestAgentSettings(runtime, client);
        await advanceProbeTimers(10);
        expect(requests).toHaveLength(11);
        expect(new Set(requests).size).toBe(1);
        expect(runtime.hostReconnectAttempted).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
        await advanceProbeTimers(2);
        expect(requests).toHaveLength(11);
    } finally {
        jest.useRealTimers();
    }
});

test("another settings request does not restart the probe budget", async () => {
    jest.useFakeTimers();
    try {
        const { client, requests, runtime } = unansweredSettingsClient();
        requestAgentSettings(runtime, client);
        await advanceProbeTimers(5);
        requestAgentSettings(runtime, client);
        await advanceProbeTimers(5);
        expect(requests).toHaveLength(12);
        expect(new Set(requests).size).toBe(2);
        expect(runtime.hostReconnectAttempted).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
        requestAgentSettings(runtime, client);
        expect(requests).toHaveLength(13);
        expect(jest.getTimerCount()).toBe(0);
    } finally {
        jest.useRealTimers();
    }
});

test("a pending session switch cannot keep the probe timer alive", async () => {
    jest.useFakeTimers();
    try {
        const { client, requests, runtime } = unansweredSettingsClient();
        requestAgentSettings(runtime, client);
        runtime.sessionSwitchPending = true;
        await advanceProbeTimers(10);
        expect(requests).toHaveLength(1);
        expect(runtime.hostReconnectAttempted).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
    } finally {
        jest.useRealTimers();
    }
});

test("a previous probe cannot resume when a reconnect reuses its client", async () => {
    jest.useFakeTimers();
    try {
        const { client, requests, runtime } = unansweredSettingsClient();
        requestAgentSettings(runtime, client);
        await advanceProbeTimers(3);
        runtime.hostReconnectProbeId = undefined;
        runtime.hostReconnectProbe = undefined;
        requestAgentSettings(runtime, client);
        await advanceProbeTimers(10);
        expect(requests).toHaveLength(15);
        expect(runtime.hostReconnectAttempted).toBe(true);
        expect(jest.getTimerCount()).toBe(0);
    } finally {
        jest.useRealTimers();
    }
});

test("each drop after a healthy reattach gets one automatic restart", async () => {
    const initial = controlledClient("initial");
    const first = controlledClient("first");
    const second = controlledClient("second");
    const clients = [first, second];
    let restarts = 0;
    const session = await startTuiTestSession({
        home: home(),
        dependencies: () => ({
            client: initial.client,
            reconnectSession: async () => clients[restarts++]!.client,
        }),
    });
    try {
        await session.waitForVisiblePane("initial healthy");
        initial.drop();
        await session.waitForVisiblePane("first healthy");
        expect(restarts).toBe(1);

        session.sendText("A pirate crow returns");
        session.sendKey("Enter");
        await session.waitForVisiblePane("first turn completed");
        first.drop();
        await session.waitForVisiblePane("second healthy");
        expect(restarts).toBe(2);
    } finally {
        await session.close();
    }
}, 15_000);

test("a replacement that dies before a fresh health reply does not loop", async () => {
    const initial = controlledClient("initial");
    let restarts = 0;
    const session = await startTuiTestSession({
        home: home(),
        dependencies: () => ({
            client: initial.client,
            reconnectSession: async () => {
                restarts += 1;
                if (restarts > 1) throw new Error("unexpected second restart");
                return dyingClient();
            },
        }),
    });
    try {
        await session.waitForVisiblePane("initial healthy");
        initial.drop();
        const pane = await session.waitForVisiblePaneWhere(
            (value) => value.includes("replacement died before becoming healthy")
                || value.includes("unexpected second restart"),
            "replacement failure",
        );
        expect(pane).toContain("replacement died before becoming healthy");
        expect(pane).toContain("disconnected");
        expect(restarts).toBe(1);
    } finally {
        await session.close();
    }
}, 15_000);

for (const method of ["Ctrl+L", "Reconnect host"] as const) {
    test(`${method} re-arms the automatic restart after recovery`, async () => {
        const initial = controlledClient("initial");
        const manual = controlledClient("manual");
        const next = controlledClient("next");
        const calls: Array<{ readonly confirmWedge?: boolean } | undefined> = [];
        const session = await startTuiTestSession({
            home: home(),
            dependencies: () => ({
                client: initial.client,
                reconnectSession: async (_agentId, options) => {
                    calls.push(options);
                    if (calls.length === 1) throw new Error("host unavailable");
                    return calls.length === 2 ? manual.client : next.client;
                },
            }),
        });
        try {
            await session.waitForVisiblePane("initial healthy");
            initial.drop();
            await session.waitForVisiblePane("host unavailable");
            if (method === "Ctrl+L") {
                session.sendKey("C-l");
            } else {
                session.sendKey("C-p");
                await session.waitForVisiblePane("Commands");
                session.sendText("reconnect host");
                await session.waitForVisiblePane("Reconnect host");
                session.sendKey("Enter");
            }
            await session.waitForVisiblePane("manual healthy");
            expect(calls).toHaveLength(2);
            expect(calls[1]?.confirmWedge).toBe(true);

            manual.drop();
            await session.waitForVisiblePane("next healthy");
            expect(calls).toHaveLength(3);
            expect(calls[2]?.confirmWedge).toBeUndefined();
        } finally {
            await session.close();
        }
    }, 15_000);
}

test("a transparent reattach leaves a later drop eligible for automatic restart", async () => {
    const initial = controlledClient("initial");
    const first = controlledClient("first");
    const second = controlledClient("second");
    const clients = [first, second];
    let restarts = 0;
    const session = await startTuiTestSession({
        home: home(),
        dependencies: () => ({
            client: initial.client,
            reconnectSession: async () => clients[restarts++]!.client,
        }),
    });
    try {
        await session.waitForVisiblePane("initial healthy");
        initial.drop();
        await session.waitForVisiblePane("first healthy");
        first.reconnectTransparently();
        await session.waitForVisiblePane("first transparently reattached");
        expect(restarts).toBe(1);
        first.drop();
        await session.waitForVisiblePane("second healthy");
        expect(restarts).toBe(2);
    } finally {
        await session.close();
    }
}, 15_000);

test("an interrupted health request is retried after a transparent reattach", async () => {
    const initial = controlledClient("initial");
    const first = interruptedProbeClient();
    const second = controlledClient("second");
    const clients = [first, second];
    let restarts = 0;
    const session = await startTuiTestSession({
        home: home(),
        dependencies: () => ({
            client: initial.client,
            reconnectSession: async () => clients[restarts++]!.client,
        }),
    });
    try {
        await session.waitForVisiblePane("initial healthy");
        initial.drop();
        await session.waitForVisiblePane("replacement awaiting reply");
        first.reconnectTransparently();
        await session.waitForVisiblePane("replacement healthy after retry");
        first.drop();
        await session.waitForVisiblePane("second healthy");
        expect(restarts).toBe(2);
    } finally {
        await session.close();
    }
}, 15_000);
