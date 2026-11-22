import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { EngineEventBus } from "../../src/engine/events.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel, type MessageChannel } from "../../src/engine/message-channel.ts";
import type { AgentUpdate } from "../../src/engine/protocol.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import type { EngineCommand } from "../../src/engine/timeline-control.ts";
import { ProviderFailureError } from "../../src/model/provider-failure.ts";
import { ModelEventStream } from "../../src/model/stream.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { SessionStore } from "../../src/store/session-store.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";

const failure = {
    kind: "timeout" as const,
    resolution: "retry" as const,
    message: "No response from faux for 300s",
};

function errorMessage(model: string): AssistantMessage {
    return {
        role: "assistant",
        content: [],
        source: { provider: "faux", api: "test", model },
        usage: emptyUsage(),
        stopReason: "error",
        errorMessage: failure.message,
    };
}

function completeMessage(model: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        source: { provider: "faux", api: "test", model },
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function pushFailure(stream: ModelEventStream, model: string): void {
    stream.push({
        type: "error",
        error: new ProviderFailureError(failure, new Error(failure.message)),
        message: errorMessage(model),
    });
}

test("@core a prompt after a failed turn runs when a delivery wake was queued during it", async () => {
    const root = mkdtempSync(join(tmpdir(), "vera-held-after-failure-"));
    const path = join(root, "session.jsonl");
    const store = await SessionStore.create(path, {
        sessionId: "held-after-failure",
        cwd: root,
    });
    const transport = createInProcessChannel();
    const channel = transport.client as MessageChannel<EngineCommand, AgentUpdate>;
    const events = new EngineEventBus();
    let discardedWakes = 0;
    const inbound = new InboundCommandRouter(transport.engine, events, {
        appendQueuedPrompt: (id, prompt) => store.appendQueuedPrompt(id, {
            content: prompt.content,
            ...(prompt.attachmentIds === undefined
                ? {}
                : { attachmentIds: prompt.attachmentIds }),
        }),
        removeQueuedPrompt: (id) => store.removeQueuedPrompt(id),
        onDeliveryTurnDiscarded: () => {
            discardedWakes += 1;
        },
    });
    const requests: ModelRequest[] = [];
    let firstStream!: ModelEventStream;
    let markFirstRequest!: () => void;
    const firstRequest = new Promise<void>((resolve) => {
        markFirstRequest = resolve;
    });
    let succeeding = false;
    const adapter: ModelAdapter = {
        stream(request) {
            requests.push(request);
            const stream = new ModelEventStream();
            if (succeeding) {
                stream.push({
                    type: "done",
                    message: completeMessage(request.model),
                });
                return stream;
            }
            if (requests.length === 1) {
                firstStream = stream;
                markFirstRequest();
                return stream;
            }
            pushFailure(stream, request.model);
            return stream;
        },
    };
    const state: RunTurnState = {
        messages: [...store.messages()],
        store,
        toolRuntime: new ToolRuntime(root),
        inbound,
        events,
        hooks: new ToolHooks(),
        approvalMode: "auto",
        loadOptionalContext: false,
        waitForModelRetry: async () => {},
    };

    try {
        channel.send({ type: "prompt", content: "first" });
        const firstTurn = runTurn(adapter, "faux", state);
        await firstRequest;
        // A completion lands during the turn and asks the host for a delivery turn.
        channel.send({ type: "trigger_delivery_turn" });
        await Bun.sleep(5);
        pushFailure(firstStream, "faux");

        const failed = await firstTurn;
        expect(failed.stopReason).toBe("error");
        // The outage exhausted the timeout policy: seven attempts.
        expect(requests.length).toBe(7);
        expect(discardedWakes).toBe(1);

        succeeding = true;
        channel.send({ type: "prompt", content: "second" });
        const secondTurn = runTurn(adapter, "faux", state);
        secondTurn.catch(() => {});
        const outcome = await Promise.race([
            secondTurn.then((message) =>
                message.stopReason === "stop" ? "started" as const : "failed" as const
            ),
            Bun.sleep(500).then(() => "held" as const),
        ]);
        expect(outcome).toBe("started");

        const reopened = await SessionStore.open(path);
        expect(reopened.queuedPrompts()).toEqual([]);
        expect(reopened.messages().flatMap((message) =>
            message.role !== "user"
                ? []
                : message.content.flatMap((block) =>
                    block.type === "text" ? [block.text] : []
                )
        )).toEqual(["first", "second"]);
    } finally {
        await inbound.stopReceivingCommands();
        await state.toolRuntime.close();
        rmSync(root, { recursive: true, force: true });
    }
});
