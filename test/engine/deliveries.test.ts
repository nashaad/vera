import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineEventBus } from "../../src/engine/events.ts";
import { rewindConversationBefore } from "../../src/engine/conversation-rewind.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import {
    SessionStore,
    type SessionDeliveryEntry,
} from "../../src/store/session-store.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

test("the next real prompt drains a delivery preserved across restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-delivery-"));
    const path = join(root, "parent.jsonl");
    const original = await SessionStore.create(path, {
        sessionId: "parent-1",
        cwd: root,
    });
    await original.recordDelivery({
        id: "delivery-1",
        sourceAgentId: "background-1",
        content: "Tests pass <cleanly> & quickly.",
    });
    await original.recordDelivery({
        id: "attention-1",
        sourceAgentId: "background-2",
        content: "Which parser is canonical?",
        kind: "attention",
    });
    const store = await SessionStore.open(path);
    const response: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "I saw the result." }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([response]);
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            return faux.stream(request);
        },
    };
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const state = {
        messages: [...store.messages()],
        store,
        deliveryInbox: store,
        toolRuntime: new ToolRuntime(root),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
    } satisfies RunTurnState;

    try {
        const turn = runTurn(adapter, "test", state);
        await Bun.sleep(10);
        expect(requests).toHaveLength(0);

        channel.client.send({ type: "prompt", content: "What finished?" });
        while ((await channel.client.receive()).type !== "turn_finished") {
            // Drain protocol updates until the prompted turn completes.
        }
        expect(await turn).toEqual(response);

        expect(requests[0]?.messages).toEqual([
            {
                role: "user",
                internal: true,
                content: [{
                    type: "text",
                    text: [
                        "<task_notification>",
                        "  <delivery_id>delivery-1</delivery_id>",
                        "  <agent_id>background-1</agent_id>",
                        "  <status>completed</status>",
                        "  <summary>Tests pass &lt;cleanly&gt; &amp; quickly.</summary>",
                        "</task_notification>",
                    ].join("\n"),
                }],
            },
            {
                role: "user",
                internal: true,
                content: [{
                    type: "text",
                    text: [
                        "<agent_message>",
                        "  <delivery_id>attention-1</delivery_id>",
                        "  <agent_id>background-2</agent_id>",
                        "  <status>attention</status>",
                        "  <message>Which parser is canonical?</message>",
                        "</agent_message>",
                    ].join("\n"),
                }],
            },
            {
                role: "user",
                content: [{ type: "text", text: "What finished?" }],
            },
        ]);
        expect(store.pendingDeliveries()).toEqual([]);
        expect((await SessionStore.open(path)).pendingDeliveries()).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("a failed delivery append leaves live context unchanged", async () => {
    const delivery: SessionDeliveryEntry = {
        type: "delivery",
        id: "delivery-1",
        sourceAgentId: "background-1",
        content: "Finished.",
        timestamp: "2026-07-19T12:00:00.000Z",
    };
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        deliveryInbox: {
            pendingDeliveries: () => [delivery],
            appendDeliveryMessage: () =>
                Promise.reject(new Error("delivery append failed")),
        },
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
    };
    let modelCalled = false;
    const adapter: ModelAdapter = {
        stream() {
            modelCalled = true;
            throw new Error("model should not run");
        },
    };

    channel.client.send({ type: "prompt", content: "continue" });
    await expect(runTurn(adapter, "test", state)).rejects.toThrow(
        "delivery append failed",
    );
    expect(state.messages).toEqual([]);
    expect(modelCalled).toBe(false);
});

test("rewind redelivers an abandoned completion once on the new branch", async () => {
    const root = await mkdtemp(join(tmpdir(), "vera-delivery-rewind-"));
    const path = join(root, "parent.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "parent-1",
        cwd: root,
        createId: values(
            "message-1",
            "message-2",
            "message-3",
            "message-4",
            "message-5",
        ),
    });
    const firstPrompt = {
        role: "user" as const,
        content: [{ type: "text" as const, text: "Start the work." }],
    };
    const firstBoundary = await store.appendMessage(firstPrompt);
    await store.appendMessage(response("Work started."));
    await store.recordDelivery({
        id: "delivery-1",
        sourceAgentId: "background-1",
        content: "Background work finished.",
    });

    const faux = new FauxAdapter([
        response("I saw the first delivery."),
        response("I saw the redelivery."),
    ]);
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            return faux.stream(request);
        },
    };
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const protocol = createProtocolEncoder(channel.engine);
    events.subscribe(protocol);
    const state = {
        messages: [...store.messages()],
        store,
        deliveryInbox: store,
        toolRuntime: new ToolRuntime(root),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
    } satisfies RunTurnState;

    try {
        const firstTurn = runTurn(adapter, "test", state);
        await Bun.sleep(10);
        channel.client.send({ type: "prompt", content: "What finished?" });
        while ((await channel.client.receive()).type !== "turn_finished") {
            // Drain protocol updates until the prompted turn completes.
        }
        await firstTurn;

        await rewindConversationBefore(state, protocol, firstBoundary.id);
        const reopened = await SessionStore.open(path, {
            createId: values(
                "message-6",
                "message-7",
                "message-8",
                "message-9",
            ),
        });
        expect(reopened.pendingDeliveries()).toHaveLength(1);
        await reopened.recordDelivery({
            id: "delivery-2",
            sourceAgentId: "background-2",
            content: "Newer background work finished.",
        });
        expect(reopened.pendingDeliveries().map((delivery) => delivery.id))
            .toEqual(["delivery-1", "delivery-2"]);

        const replacementChannel = createInProcessChannel();
        const replacementEvents = new EngineEventBus();
        replacementEvents.subscribe(
            createProtocolEncoder(replacementChannel.engine),
        );
        const replacementState = {
            messages: [...reopened.messages()],
            store: reopened,
            deliveryInbox: reopened,
            toolRuntime: new ToolRuntime(root),
            inbound: new InboundCommandRouter(
                replacementChannel.engine,
                replacementEvents,
            ),
            events: replacementEvents,
            hooks: new ToolHooks(),
            approvalMode: "auto",
        } satisfies RunTurnState;
        const replacementTurn = runTurn(adapter, "test", replacementState);
        await Bun.sleep(10);
        replacementChannel.client.send({
            type: "prompt",
            content: "Continue on the replacement branch.",
        });
        while (
            (await replacementChannel.client.receive()).type
                !== "turn_finished"
        ) {
            // Drain replacement-turn updates after the simulated restart.
        }
        await replacementTurn;

        expect(requests[1]?.messages).toEqual([
            {
                role: "user",
                internal: true,
                content: [{
                    type: "text",
                    text: [
                        "<task_notification>",
                        "  <delivery_id>delivery-1</delivery_id>",
                        "  <agent_id>background-1</agent_id>",
                        "  <status>completed</status>",
                        "  <summary>Background work finished.</summary>",
                        "</task_notification>",
                    ].join("\n"),
                }],
            },
            {
                role: "user",
                internal: true,
                content: [{
                    type: "text",
                    text: [
                        "<task_notification>",
                        "  <delivery_id>delivery-2</delivery_id>",
                        "  <agent_id>background-2</agent_id>",
                        "  <status>completed</status>",
                        "  <summary>Newer background work finished.</summary>",
                        "</task_notification>",
                    ].join("\n"),
                }],
            },
            {
                role: "user",
                content: [{
                    type: "text",
                    text: "Continue on the replacement branch.",
                }],
            },
        ]);
        expect(
            reopened.activeEntries().filter(
                (entry) => entry.deliveryId === "delivery-1",
            ),
        ).toHaveLength(1);
        expect(
            reopened.entries().filter(
                (entry) => entry.deliveryId === "delivery-1",
            ),
        ).toHaveLength(2);
        expect(
            reopened.activeEntries().filter(
                (entry) => entry.deliveryId === "delivery-2",
            ),
        ).toHaveLength(1);
        expect((await SessionStore.open(path)).pendingDeliveries()).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

function response(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function values<T>(...items: T[]): () => T {
    return () => {
        const item = items.shift();
        if (item === undefined) {
            throw new Error("No scripted value remains");
        }
        return item;
    };
}
