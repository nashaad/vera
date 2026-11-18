import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/agent-client.ts";
import { assertInstalledBuild } from "../../../clients/tui/installed-build.ts";
import { AsyncQueue } from "../../../src/engine/async-queue.ts";
import type { AgentUpdate } from "../../../src/engine/protocol.ts";
import type { HostStopWaitEvent } from "../../../src/host/protocol.ts";
import { HostBuildChangedError } from "../../../src/host/reconnecting-agent-client.ts";
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
                clientBuildId: "same-build",
                installedBuildId: () => "same-build",
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
    let attachOnly: unknown;
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-idle-restart-")),
        dependencies: () => ({
            client: initial.client,
            reconnectSession: async (_agentId, options) => {
                restarts += 1;
                attachOnly = Reflect.get(options ?? {}, "attachOnly");
                return recovered.client;
            },
        }),
    });
    try {
        await session.waitForVisiblePane("First crow voyage");
        initial.notice({ type: "host_stop_wait_cleared", reason: "stopped" });
        initial.notice({ type: "host_restarting", build_id: "next-build" });
        initial.drop();
        await session.waitForVisiblePane("Crow voyage after restart");
        expect(restarts).toBe(1);
        expect(attachOnly).toBeUndefined();
    } finally {
        await session.close();
    }
}, 15_000);

test("@core a pending relaunch reconnects without starting an old host", async () => {
    const initial = controlledClient("First crow voyage");
    const recovered = controlledClient("Crow voyage after restart");
    let starts = 0;
    let attempts = 0;
    let releaseRelaunch: (() => void) | undefined;
    const relaunch = new Promise<void>((resolve) => { releaseRelaunch = resolve; });
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-relaunch-reconnect-")),
        dependencies: () => ({
            client: initial.client,
            relaunchTui: async () => { await relaunch; },
            reconnectSession: async (_agentId, options) => {
                attempts += 1;
                if (Reflect.get(options ?? {}, "attachOnly") !== true) starts += 1;
                return recovered.client;
            },
        }),
    });
    try {
        await session.waitForVisiblePane("First crow voyage");
        initial.notice({ type: "host_stop_wait_cleared", reason: "stopped" });
        initial.notice({ type: "host_restarting", build_id: "next-build" });
        initial.drop();
        await session.waitForVisiblePane("Crow voyage after restart");
        expect(attempts).toBe(1);
        expect(starts).toBe(0);
    } finally {
        releaseRelaunch?.();
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

for (const method of ["Ctrl+L", "Reconnect host"] as const) {
    for (const launcher of [true, false]) {
        test(`${method} with a changed installed build ${launcher ? "relaunches" : "refuses"}`, async () => {
            const initial = controlledClient("First crow voyage");
            const recovered = controlledClient("Crow voyage reconnected");
            let starts = 0;
            const requests: unknown[] = [];
            const session = await startTuiTestSession({
                home: mkdtempSync(join(tmpdir(), "vera-cold-reconnect-")),
                width: 140,
                waitTimeoutMs: 2_000,
                dependencies: () => ({
                    client: initial.client,
                    clientBuildId: "old-build",
                    installedBuildId: () => "new-build",
                    ...(launcher ? { relaunchTui: async (request) => { requests.push(request); } } : {}),
                    reconnectSession: async () => { starts += 1; return recovered.client; },
                }),
            });
            try {
                await session.waitForVisiblePane("First crow voyage");
                session.sendText("unsent crow draft");
                initial.notice({ type: "host_stop_wait_cleared", reason: "stopped" });
                initial.drop();
                await session.waitForVisiblePane("The host stopped.");
                if (method === "Ctrl+L") {
                    session.sendKey("C-l");
                } else {
                    session.sendKey("C-p");
                    await session.waitForVisiblePane("Commands");
                    session.sendText("reconnect host");
                    await session.waitForVisiblePane("Reconnect host");
                    session.sendKey("Enter");
                }
                if (launcher) {
                    await session.settle(300);
                    expect(requests).toEqual([{ sessionId: "crow-session", draft: expect.objectContaining({ text: "unsent crow draft" }) }]);
                } else {
                    const pane = await session.waitForVisiblePane("The installed Vera is now build new-build, and this TUI is build old-build.");
                    expect(pane).toContain("Quit and reopen Vera to continue.");
                    expect(pane).toContain("disconnected: installed Vera is a different build · quit and reopen Vera · Ctrl+C quit");
                }
                expect(starts).toBe(0);
            } finally {
                await session.close();
            }
        }, 15_000);
    }
}


test("a live different-build host keeps the existing host refusal", async () => {
    const initial = controlledClient("First crow voyage");
    let starts = 0;
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-cold-live-host-")),
        width: 140,
        waitTimeoutMs: 2_000,
        dependencies: () => ({
            client: initial.client,
            clientBuildId: "old-build",
            installedBuildId: () => "new-build",
            refuseOtherHostBuild: async () => { throw new HostBuildChangedError("old-build", "other-host"); },
            reconnectSession: async () => { starts += 1; return initial.client; },
        }),
    });
    try {
        await session.waitForVisiblePane("First crow voyage");
        initial.notice({ type: "host_stop_wait_cleared", reason: "stopped" });
        initial.drop();
        await session.waitForVisiblePane("The host stopped.");
        session.sendKey("C-l");
        const pane = await session.waitForVisiblePane("The Vera host is now build other-host, and this TUI is build old-build.");
        expect(pane).toContain("disconnected: host is a different build · quit and reopen Vera · Ctrl+C quit");
        expect(pane).not.toContain("The installed Vera is now build");
        expect(starts).toBe(0);
    } finally {
        await session.close();
    }
}, 15_000);

for (const launcher of [true, false]) {
    test(`automatic recovery with a changed installed build ${launcher ? "relaunches" : "refuses"}`, async () => {
        const initial = controlledClient("First crow voyage");
        const requests: unknown[] = [];
        let starts = 0;
        const session = await startTuiTestSession({
            home: mkdtempSync(join(tmpdir(), "vera-auto-build-")),
            width: 140,
            waitTimeoutMs: 2_000,
            dependencies: () => ({
                client: initial.client,
                clientBuildId: "old-build",
                installedBuildId: () => "new-build",
                ...(launcher ? { relaunchTui: async (request) => { requests.push(request); } } : {}),
                reconnectSession: async () => { starts += 1; return initial.client; },
            }),
        });
        try {
            await session.waitForVisiblePane("First crow voyage");
            session.sendText("unsent crow draft");
            initial.drop();
            if (launcher) {
                await session.settle(300);
                expect(requests).toEqual([{ sessionId: "crow-session", draft: expect.objectContaining({ text: "unsent crow draft" }) }]);
            } else {
                const pane = await session.waitForVisiblePane("The installed Vera is now build new-build, and this TUI is build old-build.");
                expect(pane).toContain("disconnected: installed Vera is a different build · quit and reopen Vera · Ctrl+C quit");
            }
            expect(starts).toBe(0);
        } finally {
            await session.close();
        }
    }, 15_000);
}

test("automatic recovery rechecks the installed build before starting a host", async () => {
    const initial = controlledClient("First crow voyage");
    const requests: unknown[] = [];
    let starts = 0;
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-auto-recheck-")),
        dependencies: () => ({
            client: initial.client,
            clientBuildId: "old-build",
            installedBuildId: () => "old-build",
            relaunchTui: async (request) => { requests.push(request); },
            reconnectSession: async () => {
                assertInstalledBuild("old-build", "new-build");
                starts += 1;
                return initial.client;
            },
        }),
    });
    try {
        await session.waitForVisiblePane("First crow voyage");
        session.sendText("unsent crow draft");
        initial.drop();
        await session.settle(300);
        expect(requests).toEqual([{ sessionId: "crow-session", draft: expect.objectContaining({ text: "unsent crow draft" }) }]);
        expect(starts).toBe(0);
    } finally {
        await session.close();
    }
}, 15_000);

test("a planned stop restores raw input after automatic recovery", async () => {
    const initial = controlledClient("First crow voyage");
    const recovered = controlledClient("Crow voyage reconnected");
    let raw = true;
    let logicalRaw = true;
    const modeChanges: boolean[] = [];
    const session = await startTuiTestSession({
        home: mkdtempSync(join(tmpdir(), "vera-stop-raw-input-")),
        dependencies: (renderer) => {
            Object.defineProperty(renderer.stdin, "isTTY", { value: true, configurable: true });
            renderer.stdin.setRawMode = (enabled: boolean) => {
                modeChanges.push(enabled);
                if (logicalRaw !== enabled) {
                    logicalRaw = enabled;
                    raw = enabled;
                }
                return renderer.stdin;
            };
            return {
                client: initial.client,
                reconnectSession: async () => {
                    raw = false;
                    modeChanges.length = 0;
                    return recovered.client;
                },
            };
        },
    });
    try {
        await session.waitForVisiblePane("First crow voyage");
        initial.drop();
        await session.waitForVisiblePane("Crow voyage reconnected");
        recovered.notice({ type: "host_stop_wait_cleared", reason: "stopped" });
        recovered.drop();
        await session.waitForVisiblePane("The host stopped.");
        expect(raw).toBe(true);
        expect(modeChanges).toEqual([false, true]);
    } finally {
        await session.close();
    }
}, 15_000);
