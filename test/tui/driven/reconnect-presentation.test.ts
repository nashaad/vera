import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/agent-client.ts";
import type { TuiFlightEvent, TuiFlightRecorder } from "../../../clients/tui/flight-recorder.ts";
import { disconnectedRecoveryHint } from "../../../clients/tui/main.ts";
import { AsyncQueue } from "../../../src/engine/async-queue.ts";
import type { AgentUpdate, TranscriptEntry } from "../../../src/engine/protocol.ts";
import { HostConnectionClosedError } from "../../../src/host/connection.ts";
import { HostReplacementBusyError } from "../../../src/host/discovery.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

function home(): string {
    return mkdtempSync(join(tmpdir(), "vera-reconnect-presentation-"));
}

function clientFor(updates: AsyncQueue<AgentUpdate>): TuiAgentClient {
    return {
        agentId: "crow-session",
        async send(): Promise<void> {},
        receive: (signal) => updates.receive(signal),
        async detach(): Promise<void> {},
        close(): void {},
    };
}

function workedRows(pane: string): string[] {
    return [...pane.matchAll(/Worked for (?:\d+m \d+s|\d+s)/g)].map((match) => match[0]);
}

function recorder(events: TuiFlightEvent[]): TuiFlightRecorder {
    return {
        instanceId: "crow",
        logPath: "",
        record: (event) => { events.push(event); },
        sessionEntered() {},
        close() {},
    };
}

test("automatic restart stops live timers and keeps the conversation visible until history arrives", async () => {
    const initial = new AsyncQueue<AgentUpdate>();
    initial.push({ type: "history", entries: [], seq: 0 });
    initial.push({ type: "user_prompt", content: "A crow starts a slow voyage", seq: 1 });
    initial.push({ type: "assistant_thinking", text: "An unrecorded course", seq: 2 });
    initial.push({ type: "tool_started", tool: "bash", args: { command: "sleep 60" }, seq: 3 });
    const next = new AsyncQueue<AgentUpdate>();
    const restart = Promise.withResolvers<TuiAgentClient>();
    const events: TuiFlightEvent[] = [];
    const session = await startTuiTestSession({
        home: home(),
        width: 140,
        height: 40,
        dependencies: () => ({
            client: clientFor(initial),
            disabledIncludedExtensions: ["vera.diff"],
            reconnectSession: async () => restart.promise,
            flightRecorder: recorder(events),
        }),
    });
    try {
        await session.waitForVisiblePane("running bash");
        initial.fail(new HostConnectionClosedError(false));
        const disconnected = await session.waitForVisiblePane("reconnecting…");
        expect(disconnected).toContain("A crow starts a slow voyage");
        expect(disconnected).toContain("Reasoning summary");
        expect(disconnected).not.toContain("Working (");
        expect(disconnected).not.toContain("running bash");
        expect(disconnected).not.toContain("Lost the connection to the host.");
        await session.settle(1_200);
        const waiting = session.captureVisiblePane();
        expect(waiting).not.toContain("Working (");
        expect(waiting).not.toContain("running bash");
        expect(waiting).toContain("reconnecting…");

        restart.resolve(clientFor(next));
        await session.settle(250);
        const beforeHistory = session.captureVisiblePane();
        expect(beforeHistory).toContain("A crow starts a slow voyage");
        expect(beforeHistory).not.toContain("Start a conversation with Vera.");
        expect(beforeHistory).not.toContain("Lost the connection to the host.");
        next.push({
            type: "history",
            entries: [
                { kind: "user", text: "A crow starts a slow voyage" },
                { kind: "harness", tone: "error", text: "Vera crashed before this turn finished." },
            ],
            seq: 0,
        });
        const recovered = await session.waitForVisiblePane("Vera crashed before this turn finished.");
        expect(recovered).not.toContain("Start a conversation with Vera.");
        expect(recovered).not.toContain("Lost the connection to the host.");
        expect(recovered).not.toContain("Reasoning summary");
        expect(events.filter((event) => event.type === "host_connection_lost")).toHaveLength(1);
        expect(events.filter((event) => event.type === "host_restart_outcome"))
            .toEqual([expect.objectContaining({ outcome: "completed" })]);
    } finally {
        await session.close();
    }
}, 15_000);

test("a failed automatic restart reports the lost connection and its outcome once", async () => {
    const updates = new AsyncQueue<AgentUpdate>();
    updates.push({ type: "history", entries: [{ kind: "user", text: "Crow voyage" }], seq: 0 });
    const events: TuiFlightEvent[] = [];
    const session = await startTuiTestSession({
        home: home(),
        width: 140,
        dependencies: () => ({
            client: clientFor(updates),
            disabledIncludedExtensions: ["vera.diff"],
            reconnectSession: async () => { throw new Error("host unavailable"); },
            flightRecorder: recorder(events),
        }),
    });
    try {
        await session.waitForVisiblePane("Crow voyage");
        updates.fail(new HostConnectionClosedError(false));
        const pane = await session.waitForVisiblePane("host unavailable");
        expect(pane).toContain("Lost the connection to the host.");
        expect(pane).toContain("disconnected");
        expect(events.filter((event) => event.type === "host_connection_lost")).toHaveLength(1);
        expect(events.filter((event) => event.type === "host_restart_outcome"))
            .toEqual([expect.objectContaining({ outcome: "failed" })]);
    } finally {
        await session.close();
    }
}, 15_000);

for (const mode of ["automatic", "manual"] as const) {
    for (const reopened of [false, true]) {
        test(`${mode} reattach preserves ${reopened ? "reopened" : "live"} divider durations${mode === "manual" ? " without saved short timing" : ""}`, async () => {
            const now = Date.now();
            const oldTiming = { durationMs: 3_000, finishedAt: now - 3_000 };
            const longTiming = { durationMs: 360_000, finishedAt: now - 2_000 };
            const shortTiming = { durationMs: 300, finishedAt: now - 1_000 };
            const oldEntries: TranscriptEntry[] = reopened ? [
                { kind: "user", text: "An earlier voyage" },
                { kind: "assistant", text: "Earlier crow reply", turnTiming: oldTiming },
            ] : [];
            const entries: TranscriptEntry[] = [
                ...oldEntries,
                { kind: "user", text: "A long voyage" },
                { kind: "assistant", text: "Long crow reply", turnTiming: longTiming },
                { kind: "user", text: "A short voyage" },
                {
                    kind: "assistant",
                    text: "Short crow reply",
                    ...(mode === "automatic" ? { turnTiming: shortTiming } : {}),
                },
            ];
            const initial = new AsyncQueue<AgentUpdate>();
            initial.push({ type: "history", status: "idle", entries: oldEntries, seq: 0 });
            initial.push({ type: "user_prompt", content: "A long voyage", seq: 1 });
            initial.push({ type: "assistant_delta", text: "Long crow reply", seq: 2 });
            initial.push({ type: "turn_finished", turnTiming: longTiming, seq: 3 });
            initial.push({ type: "user_prompt", content: "A short voyage", seq: 4 });
            initial.push({ type: "assistant_delta", text: "Short crow reply", seq: 5 });
            initial.push({ type: "turn_finished", turnTiming: shortTiming, seq: 6 });
            const reattached = new AsyncQueue<AgentUpdate>();
            reattached.push({ type: "history", status: "idle", entries, seq: 0 });
            reattached.push({ type: "notice", key: "ready", count: 1, text: "Reattached to the crow", seq: 1 });
            let attempts = 0;
            const session = await startTuiTestSession({
                home: home(),
                width: 140,
                height: 45,
                dependencies: () => ({
                    client: clientFor(initial),
                    disabledIncludedExtensions: ["vera.diff"],
                    reconnectSession: async () => {
                        attempts += 1;
                        if (mode === "manual" && attempts === 1) throw new Error("Host unavailable");
                        return clientFor(reattached);
                    },
                }),
            });
            try {
                const before = await session.waitForVisiblePane("Short crow reply");
                const expected = reopened ? ["Worked for 3s", "Worked for 6m 00s"] : ["Worked for 6m 00s"];
                expect(workedRows(before)).toEqual(expected);
                initial.fail(new DOMException("The operation timed out.", "TimeoutError"));
                if (mode === "manual") {
                    await session.waitForVisiblePane("Host unavailable");
                    session.sendKey("C-l");
                }
                const after = await session.waitForVisiblePaneWhere(
                    (pane) => pane.includes("Reattached to the crow")
                        && pane.includes("Long crow reply")
                        && pane.includes("Short crow reply"),
                    "reattached conversation",
                );
                expect(workedRows(after)).toEqual(expected);
                expect(after).toContain("Long crow reply");
                expect(after).toContain("Short crow reply");
            } finally {
                await session.close();
            }
        }, 15_000);
    }
}

for (const scenario of [
    { name: "reconnect deadline", error: new DOMException("The operation timed out.", "TimeoutError"), expected: "Lost the connection to the host." },
    { name: "another connection failure", error: new Error("The crow lost its socket"), expected: "The crow lost its socket." },
    { name: "an unrelated error with timeout text", error: new Error("The operation timed out."), expected: "The operation timed out." },
] as const) {
    test(`${scenario.name} shows the right disconnected reason`, async () => {
        const updates = new AsyncQueue<AgentUpdate>();
        updates.push({ type: "history", entries: [], seq: 0 });
        const session = await startTuiTestSession({
            home: home(),
            width: 140,
            dependencies: () => ({ client: clientFor(updates), disabledIncludedExtensions: ["vera.diff"] }),
        });
        try {
            await session.settle(50);
            updates.fail(scenario.error);
            const pane = await session.waitForVisiblePaneWhere(
                (value) => value.includes(scenario.expected)
                    || (scenario.name === "reconnect deadline" && value.includes("The operation timed out.")),
                "disconnected reason",
            );
            expect(pane).toContain(scenario.expected);
            expect(pane.replace(/\s+/g, "")).toContain(disconnectedRecoveryHint().replace(/\s+/g, ""));
            expect(pane).toContain("disconnected");
            expect(pane).toContain("ERROR");
            if (scenario.name === "reconnect deadline") expect(pane).not.toContain("The operation timed out.");
        } finally {
            await session.close();
        }
    }, 15_000);
}

test("a busy reconnect remains an error while the session stays connected", async () => {
    const updates = new AsyncQueue<AgentUpdate>();
    updates.push({ type: "history", entries: [{ kind: "assistant", text: "Still connected" }], seq: 0 });
    const session = await startTuiTestSession({
        home: home(),
        width: 140,
        dependencies: () => ({
            client: clientFor(updates),
            disabledIncludedExtensions: ["vera.diff"],
            reconnectSession: async () => { throw new HostReplacementBusyError(); },
        }),
    });
    try {
        await session.waitForVisiblePane("Still connected");
        session.sendKey("C-p");
        await session.waitForVisiblePane("Commands");
        session.sendText("reconnect host");
        await session.waitForVisiblePane("Reconnect host");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("Could not restart the host: other work is still using it.");
        expect(pane).toContain("ERROR");
        expect(pane).not.toContain("disconnected ·");
    } finally {
        await session.close();
    }
}, 15_000);

test("a busy automatic restart retains the lost connection and the busy error", async () => {
    const updates = new AsyncQueue<AgentUpdate>();
    updates.push({ type: "history", entries: [{ kind: "user", text: "Crow voyage" }], seq: 0 });
    const session = await startTuiTestSession({
        home: home(),
        width: 140,
        dependencies: () => ({
            client: clientFor(updates),
            disabledIncludedExtensions: ["vera.diff"],
            reconnectSession: async () => { throw new HostReplacementBusyError(); },
        }),
    });
    try {
        await session.waitForVisiblePane("Crow voyage");
        updates.fail(new HostConnectionClosedError(false));
        const pane = await session.waitForVisiblePane("Could not restart the host: other work is still using it.");
        expect(pane).toContain("Lost the connection to the host.");
        expect(pane).toContain("ERROR");
        expect(pane).toContain("disconnected");
    } finally {
        await session.close();
    }
}, 15_000);
