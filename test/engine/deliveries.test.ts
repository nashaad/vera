import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineEventBus } from "../../src/engine/events.ts";
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
import { SessionStore } from "../../src/store/session-store.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

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
    const state: RunTurnState = {
        messages: [...store.messages()],
        store,
        deliveryInbox: store,
        toolRuntime: new ToolRuntime(root),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "approve_for_me",
    };

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
                content: [{ type: "text", text: "What finished?" }],
            },
        ]);
        expect(store.pendingDeliveries()).toEqual([]);
        expect((await SessionStore.open(path)).pendingDeliveries()).toEqual([]);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
