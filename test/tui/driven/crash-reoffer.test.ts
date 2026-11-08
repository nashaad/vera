import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/main.ts";
import { AsyncQueue } from "../../../src/engine/async-queue.ts";
import type { AgentUpdate, ClientCommand, HistoryUpdate } from "../../../src/engine/protocol.ts";
import { PromptRejectedError } from "../../../src/host/attached-client.ts";
import { HostBuildChangedError } from "../../../src/host/reconnecting-agent-client.ts";
import { startTuiTestSession } from "../../support/tui-harness.ts";

function history(): HistoryUpdate {
    return {
        type: "history", seq: 0,
        entries: [{ kind: "harness", text: "Vera crashed before this turn finished.", tone: "soft" }],
        unsentPrompts: [
            { content: "first crow" },
            { content: "second crow", attachmentIds: ["image-1"] },
            { content: "third crow" },
        ],
    };
}

function fake() {
    const updates = new AsyncQueue<AgentUpdate>();
    const sent: ClientCommand[] = [];
    const client: TuiAgentClient = {
        async send(command) { sent.push(command); },
        receive(signal) { return updates.receive(signal); },
        async detach() {},
        close() {},
    };
    return { updates, sent, client };
}

test("a crash re-offers the earliest prompt once without sending it", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-crash-reoffer-"));
    const source = fake();
    source.updates.push(history());
    const session = await startTuiTestSession({ home, dependencies: () => ({ client: source.client }) });
    try {
        const pane = await session.waitForVisiblePane("first crow");
        expect(pane).toContain("Vera crashed before this turn finished.");
        expect(source.sent.filter((command) => command.type === "prompt")).toEqual([]);
        session.sendText(" edited");
        await session.waitForVisiblePane("first crow edited");
        source.updates.push(history());
        await session.settle(200);
        expect(session.captureVisiblePane()).toContain("first crow edited");
        session.sendKey("Escape");
        await session.settle();
        source.updates.push(history());
        await session.settle(200);
        expect(session.captureVisiblePane()).not.toContain("first crow");
    } finally {
        await session.close();
    }
}, 20_000);

test("a draft survives history navigation and each recovered prompt is reachable with its image", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-crash-reoffer-draft-"));
    const source = fake();
    source.updates.push(history());
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({ client: source.client, initialDraft: { text: "deck draft", attachmentIds: [] } }),
    });
    try {
        await session.waitForVisiblePane("deck draft");
        session.sendKey("Up");
        await session.waitForVisiblePane("third crow");
        session.sendKey("Up");
        const image = await session.waitForVisiblePane("second crow");
        expect(image).toContain("[Image 1]");
        session.sendKey("Up");
        await session.waitForVisiblePane("first crow");
        session.sendKey("Up");
        await session.waitForVisiblePane("first crow");
        session.sendKey("Down");
        session.sendKey("Down");
        session.sendKey("Down");
        await session.waitForVisiblePane("deck draft");
        expect(source.sent.filter((command) => command.type === "prompt")).toEqual([]);
    } finally {
        await session.close();
    }
}, 20_000);

test("a rejected queued prompt stays in the composer for retry", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-crash-reoffer-retry-"));
    const source = fake();
    let fail = true;
    const client: TuiAgentClient = {
        ...source.client,
        async send(command) {
            if (command.type === "prompt" && fail) throw new PromptRejectedError("Could not save the queued prompt.");
            source.sent.push(command);
        },
    };
    source.updates.push({ type: "history", seq: 0, entries: [] });
    const session = await startTuiTestSession({ home, dependencies: () => ({ client }) });
    try {
        await session.waitForVisiblePane("Message Vera");
        session.sendText("check the rigging");
        await session.waitForVisiblePane("check the rigging");
        session.sendKey("Enter");
        const rejected = await session.waitForVisiblePane("Could not save the queued prompt.");
        expect(rejected).toContain("check the rigging");
        fail = false;
        session.sendKey("Enter");
        await session.waitForVisiblePaneWhere(() => source.sent.some((command) => command.type === "prompt"), "retried prompt");
    } finally {
        await session.close();
    }
}, 20_000);

for (const attachmentIds of [[], ["image-1"]] as const) {
    const label = attachmentIds.length === 0 ? "text" : "image";
    for (const failure of ["rejected", "connection", "build"] as const) {
        test(`${label} submission preserves the draft after a ${failure} failure`, async () => {
            const home = mkdtempSync(join(tmpdir(), "vera-submit-failure-"));
            const source = fake();
            const sent: ClientCommand[] = [];
            const client: TuiAgentClient = {
                ...source.client,
                agentId: "crow",
                async send(command) {
                    if (command.type !== "prompt") return;
                    sent.push(command);
                    if (failure === "rejected") throw new PromptRejectedError("Could not save the queued prompt.");
                    if (failure === "build") throw new HostBuildChangedError("vera-crow-1", "vera-kraken-2");
                    throw new Error("Lost the connection to the host.");
                },
            };
            source.updates.push({ type: "history", seq: 0, entries: [] });
            const session = await startTuiTestSession({
                home,
                width: 140,
                dependencies: () => ({ client, initialDraft: { text: "check the rigging", attachmentIds } }),
            });
            try {
                await session.waitForVisiblePane("check the rigging");
                session.sendKey("Enter");
                const expected = failure === "rejected"
                    ? "Could not save the queued prompt."
                    : failure === "build"
                    ? "Quit and reopen Vera to continue."
                    : "Lost the connection to the host.";
                const pane = await session.waitForVisiblePane(expected);
                expect(pane).toContain("check the rigging");
                expect(pane.split(expected)).toHaveLength(2);
                expect(sent).toHaveLength(1);
                if (attachmentIds.length > 0) {
                    expect(sent[0]).toMatchObject({ attachmentIds: ["image-1"] });
                    if (failure === "rejected") expect(pane).toContain("[Image 1]");
                }
                if (failure === "connection") {
                    expect(pane).toContain("disconnected");
                    expect(pane).toContain("Ctrl+L restart");
                } else if (failure === "build") {
                    expect(pane).toContain("host is a different build");
                } else {
                    expect(pane).not.toContain("disconnected");
                }
            } finally {
                await session.close();
            }
        }, 20_000);
    }
}

test("a dropped prompt submission automatically reconnects with the draft intact", async () => {
    const home = mkdtempSync(join(tmpdir(), "vera-submit-reconnect-"));
    const source = fake();
    const reattached = fake();
    let reconnects = 0;
    source.updates.push({ type: "history", seq: 0, entries: [] });
    reattached.updates.push({ type: "history", seq: 0, entries: [{ kind: "assistant", text: "Host reconnected." }] });
    const client: TuiAgentClient = {
        ...source.client,
        agentId: "crow",
        async send(command) {
            if (command.type === "prompt") throw new Error("Lost the connection to the host.");
        },
    };
    const session = await startTuiTestSession({
        home,
        dependencies: () => ({
            client,
            initialDraft: { text: "check the rigging", attachmentIds: [] },
            reconnectSession: async () => {
                reconnects += 1;
                return reattached.client;
            },
        }),
    });
    try {
        await session.waitForVisiblePane("check the rigging");
        session.sendKey("Enter");
        const pane = await session.waitForVisiblePane("Host reconnected.");
        expect(reconnects).toBe(1);
        expect(pane).toContain("check the rigging");
        expect(pane).not.toContain("Lost the connection to the host.");
    } finally {
        await session.close();
    }
}, 20_000);
