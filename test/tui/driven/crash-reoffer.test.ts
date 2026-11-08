import { expect, test } from "bun:test";
import { join } from "node:path";

import type { TuiAgentClient } from "../../../clients/tui/main.ts";
import { AsyncQueue } from "../../../src/engine/async-queue.ts";
import { createProtocolEncoder, type AgentUpdate, type ClientCommand, type HistoryUpdate } from "../../../src/engine/protocol.ts";
import { PromptRejectedError } from "../../../src/host/attached-client.ts";
import { HostBuildChangedError } from "../../../src/host/reconnecting-agent-client.ts";
import { emptyUsage } from "../../../src/model/types.ts";
import { CRASHED_TOOL_RESULT, CRASH_CUT_MESSAGE, CRASH_QUEUED_PROMPTS_MESSAGE, SessionStore } from "../../../src/store/session-store.ts";
import { createStubTuiHome } from "../../support/stub-tui-home.ts";
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

test("a partly saved tool batch re-offers its surviving queued prompts", async () => {
    const home = createStubTuiHome("vera-crash-batch-reoffer-");
    const path = join(home, "session.jsonl");
    const store = await SessionStore.create(path, { sessionId: "crow", cwd: home });
    const sha256 = "a".repeat(64);
    const imageId = `${sha256}.png`;
    await store.appendAttachment({ id: imageId, name: "map.png", mediaType: "image/png", bytes: 123, width: 10, height: 20, sha256 });
    await store.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect the ship" }] }, { turnStart: true });
    const call = await store.appendMessage({
        role: "assistant", content: [
            { type: "tool_call", id: "fast", name: "read", input: {} },
            { type: "tool_call", id: "slow", name: "read", input: {} },
        ],
        source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(), stopReason: "tool_use",
    });
    await store.appendMessage({
        role: "tool_result", toolCallId: "fast", toolName: "read",
        content: [{ type: "text", text: "The deck is clear." }], isError: false,
    });
    const notice = await store.appendHarnessMessage("Crew notice", "soft", call.id);
    expect(notice.afterMessageId).toBe(call.id);
    await store.appendQueuedPrompt("first", { content: "Check the sails" });
    await store.appendQueuedPrompt("second", { content: "Inspect the map", attachmentIds: [imageId] });
    expect(await store.repairCrashedTurn()).toBe(true);
    const reopened = await SessionStore.open(path);
    expect(await reopened.repairCrashedTurn()).toBe(false);
    const source = fake();
    let projected: HistoryUpdate | undefined;
    const encoder = createProtocolEncoder({
        send(update) { if (update.type === "history") projected = update; },
    }, undefined, () => reopened.projectedHarnessMessages(), undefined, undefined, undefined, () => reopened.unsentPrompts());
    encoder.checkpoint(reopened.messages(), reopened.activeMessageStamps());
    expect(projected).toBeDefined();
    expect(projected!.entries.filter((entry) => entry.kind === "tool_result")).toMatchObject([
        { output: "The deck is clear.", isError: false },
        { output: CRASHED_TOOL_RESULT, isError: true },
    ]);
    expect(projected!.unsentPrompts).toEqual([
        { content: "Check the sails" }, { content: "Inspect the map", attachmentIds: [imageId] },
    ]);
    source.updates.push({ type: "history", entries: [], seq: 0 });
    const session = await startTuiTestSession({ home, dependencies: () => ({ client: source.client }) });
    try {
        await session.waitForVisiblePane("Message Vera");
        source.updates.push(projected!);
        const pane = await session.waitForVisiblePaneWhere(
            (value) => value.includes("Check the sails") && value.includes("Vera crashed before this turn finished."),
            "recovered prompt and crash line",
        );
        expect(pane).toContain("Vera crashed before this turn finished.");
        session.sendKey("Up");
        expect(await session.waitForVisiblePane("Inspect the map")).toContain("[Image 1]");
        expect(source.sent.filter((command) => command.type === "prompt")).toEqual([]);
    } finally {
        await session.close();
    }
}, 20_000);

test("queued prompts after a completed reply return under their own notice", async () => {
    const home = createStubTuiHome("vera-queued-reoffer-");
    const store = await SessionStore.create(join(home, "session.jsonl"), { sessionId: "crow", cwd: home });
    await store.appendMessage({ role: "user", content: [{ type: "text", text: "Inspect the ship" }] }, { turnStart: true });
    await store.appendQueuedPrompt("first", { content: "Check the sails" });
    await store.appendQueuedPrompt("second", { content: "Inspect the map" });
    await store.appendMessage({
        role: "assistant", content: [{ type: "text", text: "The deck is clear." }],
        source: { provider: "faux", api: "scripted", model: "test" }, usage: emptyUsage(),
        stopReason: "stop", turnTiming: { durationMs: 1, finishedAt: 1 },
    });
    expect(await store.repairCrashedTurn()).toBe(true);
    const reopened = await SessionStore.open(store.path);
    let projected: HistoryUpdate | undefined;
    const encoder = createProtocolEncoder({
        send(update) { if (update.type === "history") projected = update; },
    }, undefined, () => reopened.projectedHarnessMessages(), undefined, undefined, undefined, () => reopened.unsentPrompts());
    encoder.checkpoint(reopened.messages(), reopened.activeMessageStamps());
    expect(projected?.entries.slice(-2)).toMatchObject([
        { kind: "assistant", text: "The deck is clear." },
        { kind: "harness", text: CRASH_QUEUED_PROMPTS_MESSAGE, tone: "soft" },
    ]);
    const source = fake();
    source.updates.push(projected!);
    const session = await startTuiTestSession({ home, dependencies: () => ({ client: source.client }) });
    try {
        const pane = await session.waitForVisiblePaneWhere(
            (value) => value.includes("Check the sails") && value.includes(CRASH_QUEUED_PROMPTS_MESSAGE),
            "recovered queue and notice",
        );
        expect(pane).not.toContain(CRASH_CUT_MESSAGE);
        session.sendKey("Up");
        expect(await session.waitForVisiblePane("Inspect the map")).toContain("Inspect the map");
        expect(source.sent.filter((command) => command.type === "prompt")).toEqual([]);
    } finally {
        await session.close();
    }
}, 20_000);

test("a crash re-offers the earliest prompt once without sending it", async () => {
    const home = createStubTuiHome("vera-crash-reoffer-");
    const source = fake();
    source.updates.push(history());
    const session = await startTuiTestSession({ home, dependencies: () => ({ client: source.client }) });
    try {
        const pane = await session.waitForVisiblePaneWhere(
            (value) => value.includes("first crow") && value.includes("Vera crashed before this turn finished."),
            "recovered prompt and crash line",
        );
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
    const home = createStubTuiHome("vera-crash-reoffer-draft-");
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
    const home = createStubTuiHome("vera-crash-reoffer-retry-");
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
            const home = createStubTuiHome("vera-submit-failure-");
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
    const home = createStubTuiHome("vera-submit-reconnect-");
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
