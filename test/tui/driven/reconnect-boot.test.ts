import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/agent-client.ts";
import { createTuiFlightRecorder } from "../../../clients/tui/flight-recorder.ts";
import { createHomeClient } from "../../../clients/tui/home-client.ts";
import { AsyncQueue } from "../../../src/engine/async-queue.ts";
import type { AgentUpdate, ClientCommand } from "../../../src/engine/protocol.ts";
import { HostConnectionClosedError } from "../../../src/host/connection.ts";
import type { BootCheck } from "../../../src/host/boot.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

function home(): string {
    return mkdtempSync(join(tmpdir(), "vera-reconnect-boot-"));
}

function client(updates: AsyncQueue<AgentUpdate>, sent: ClientCommand[] = []): TuiAgentClient {
    return {
        agentId: "crow-session",
        async send(command) { sent.push(command); },
        receive: (signal) => updates.receive(signal),
        async detach() {},
        close() {},
    };
}

function initialUpdates(): AsyncQueue<AgentUpdate> {
    const updates = new AsyncQueue<AgentUpdate>();
    updates.push({ type: "history", entries: [{ kind: "user", text: "Original voyage" }], seq: 0 });
    return updates;
}

const checks: readonly BootCheck[] = [
    { label: "Home", status: "ok", detail: "safe home" },
    { label: "Runtime", status: "fixed", detail: "removed stale lock" },
    { label: "Host start", status: "ok", detail: "ready" },
];

test("@core reconnect shows one boot notice without stderr and records the checks", async () => {
    const root = home();
    const initial = initialUpdates();
    const recovered = new AsyncQueue<AgentUpdate>();
    const recorder = createTuiFlightRecorder({ runtimeDirectory: join(root, "runtime") });
    const stderr: string[] = [];
    const originalWrite = process.stderr.write;
    const session = await startTuiTestSession({
        home: root,
        width: 120,
        height: 35,
        dependencies: () => ({
            client: client(initial),
            flightRecorder: recorder,
            reconnectSession: async (_id, options) => {
                for (const check of checks) options?.boot?.onCheck?.(check);
                options?.boot?.render?.(checks.slice(0, 2));
                options?.boot?.render?.(checks);
                options?.boot?.onWaiting?.(123);
                return client(recovered);
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Original voyage");
        process.stderr.write = ((chunk: unknown) => { stderr.push(String(chunk)); return true; }) as typeof process.stderr.write;
        initial.fail(new HostConnectionClosedError(false));
        const before = await session.waitForVisiblePane("removed stale lock");
        expect(before).toContain("[ok]    Home: safe home");
        expect(before).toContain("[fixed] Runtime: removed stale lock");
        expect(before).toContain("[ok]    Host start: ready");
        expect(before.match(/removed stale lock/g)).toHaveLength(1);
        recovered.push({ type: "history", entries: [{ kind: "assistant", text: "Recovered voyage" }], seq: 0 });
        const after = await session.waitForVisiblePane("Recovered voyage");
        expect(after.match(/removed stale lock/g)).toHaveLength(1);
        expect(stderr).toEqual([]);
        await recorder.close("test");
        const events = readFileSync(recorder.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
        expect(events.filter((event) => event.type === "reconnect_boot_check").map(({ label, status, detail }) => ({ label, status, detail })))
            .toEqual(checks.map(({ label, status, detail }) => ({ label, status, detail })));
    } finally {
        process.stderr.write = originalWrite;
        await session.close();
        await recorder.close("test");
    }
}, 15_000);

test("a clean reconnect shows no boot notice", async () => {
    const initial = initialUpdates();
    const recovered = new AsyncQueue<AgentUpdate>();
    recovered.push({ type: "history", entries: [{ kind: "assistant", text: "Recovered voyage" }], seq: 0 });
    const session = await startTuiTestSession({
        home: home(),
        dependencies: () => ({
            client: client(initial),
            reconnectSession: async (_id, options) => {
                options?.boot?.onCheck?.(checks[0]!);
                options?.boot?.render?.([checks[0]!]);
                return client(recovered);
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Original voyage");
        initial.fail(new HostConnectionClosedError(false));
        const pane = await session.waitForVisiblePane("Recovered voyage");
        expect(pane).not.toContain("safe home");
        expect(pane).not.toContain("[ok]");
    } finally {
        await session.close();
    }
}, 15_000);

for (const choice of ["escape", "yes"] as const) {
    test(`@core reconnect boot question ${choice} answers locally after waiting`, async () => {
        const initial = initialUpdates();
        const recovered = new AsyncQueue<AgentUpdate>();
        recovered.push({ type: "history", entries: [{ kind: "assistant", text: "Recovered voyage" }], seq: 0 });
        const sent: ClientCommand[] = [];
        let answer: boolean | undefined;
        const session = await startTuiTestSession({
            home: home(),
            width: 100,
            height: 31,
            dependencies: () => ({
                client: client(initial, sent),
                sessionSwitchTimeoutMs: 400,
                reconnectSession: async (_id, options) => {
                    answer = await options!.boot!.confirm!({ id: "stash_runtime", text: "Move the runtime aside?" });
                    return client(recovered, sent);
                },
            }),
        });
        try {
            await session.waitForVisiblePane("Original voyage");
            initial.fail(new HostConnectionClosedError(false));
            const pane = await session.waitForVisiblePane("Move the runtime aside?");
            expect(pane).toContain("1. Yes");
            expect(pane).toContain("2. No");
            expect(pane).not.toContain("Other");
            await session.settle(600);
            expect(session.captureVisiblePane()).toContain("Move the runtime aside?");
            session.sendKey(choice === "escape" ? "Escape" : "Enter");
            await session.waitForVisiblePane("Recovered voyage");
            expect(answer).toBe(choice === "yes");
            expect(sent.some((command) => command.type === "ui_response")).toBe(false);
            session.sendText("A reply after startup checks");
            session.sendKey("Enter");
            await session.settle(100);
            const prompt = sent.find((command) => command.type === "prompt");
            expect(prompt).toMatchObject({
                type: "prompt",
                content: "A reply after startup checks",
            });
        } finally {
            await session.close();
        }
    }, 15_000);
}

test("a reconnect boot question takes focus from an open command palette", async () => {
    const initial = initialUpdates();
    const recovered = new AsyncQueue<AgentUpdate>();
    recovered.push({ type: "history", entries: [{ kind: "assistant", text: "Recovered voyage" }], seq: 0 });
    const gate = Promise.withResolvers<void>();
    let answer: boolean | undefined;
    const session = await startTuiTestSession({
        home: home(),
        dependencies: () => ({
            client: client(initial),
            reconnectSession: async (_id, options) => {
                await gate.promise;
                answer = await options!.boot!.confirm!({ id: "stash_runtime", text: "Move the runtime aside?" });
                return client(recovered);
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Original voyage");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        initial.fail(new HostConnectionClosedError(false));
        gate.resolve();
        const pane = await session.waitForVisiblePane("Move the runtime aside?");
        expect(pane).not.toContain("Commands 1/");
        session.sendKey("Escape");
        await session.waitForVisiblePane("Recovered voyage");
        expect(answer).toBe(false);
    } finally {
        gate.resolve();
        await session.close();
    }
}, 15_000);

test("a question arriving after the reconnect deadline is refused", async () => {
    const initial = initialUpdates();
    const gate = Promise.withResolvers<void>();
    let answer: boolean | undefined;
    const session = await startTuiTestSession({
        home: home(),
        dependencies: () => ({
            client: client(initial),
            sessionSwitchTimeoutMs: 200,
            reconnectSession: async (_id, options) => {
                await gate.promise;
                answer = await options!.boot!.confirm!({ id: "stash_runtime", text: "Late question?" });
                return client(new AsyncQueue<AgentUpdate>());
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Original voyage");
        initial.fail(new HostConnectionClosedError(false));
        await session.waitForVisiblePane("Could not reconnect: timed out");
        gate.resolve();
        await session.settle(100);
        expect(answer).toBe(false);
        expect(session.captureVisiblePane()).not.toContain("Late question?");
    } finally {
        gate.resolve();
        await session.close();
    }
}, 15_000);

test("closing the TUI answers a pending reconnect question no", async () => {
    const initial = initialUpdates();
    let answer: boolean | undefined;
    const session = await startTuiTestSession({
        home: home(),
        dependencies: () => ({
            client: client(initial),
            reconnectSession: async (_id, options) => {
                answer = await options!.boot!.confirm!({ id: "restart_running_host", text: "Restart the host?" });
                return client(new AsyncQueue<AgentUpdate>());
            },
        }),
    });
    try {
        await session.waitForVisiblePane("Original voyage");
        initial.fail(new HostConnectionClosedError(false));
        await session.waitForVisiblePane("Restart the host?");
        await session.close();
        expect(answer).toBe(false);
    } finally {
        await session.close();
    }
}, 15_000);

test("a home-screen reconnect shows a repaired boot notice", async () => {
    const session = await startTuiTestSession({
        home: home(),
        width: 120,
        dependencies: () => ({
            client: createHomeClient(process.cwd()),
            reconnectHome: async (options) => {
                for (const check of checks) options?.boot?.onCheck?.(check);
                options?.boot?.render?.(checks);
            },
        }),
    });
    try {
        await session.waitForVisiblePane("New conversation");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("reconnect host");
        await session.waitForVisiblePane("Reconnect host");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("removed stale lock");
        expect(pane).toContain("[fixed] Runtime: removed stale lock");
        expect(pane.match(/removed stale lock/g)).toHaveLength(1);
    } finally {
        await session.close();
    }
}, 15_000);
