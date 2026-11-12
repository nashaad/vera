import { expect, test } from "bun:test";

import { EngineEventBus } from "../../src/engine/events.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import type { InProcessChannel } from "../../src/engine/message-channel.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

// The offered tool list is part of the cached request prefix. These tests keep
// its changes to the moments the prompt cache contract allows.

const SOURCE = { provider: "faux", api: "scripted", model: "test" } as const;

function toolResponse(
    id: string,
    name: string,
    input: Readonly<Record<string, unknown>>,
): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "tool_call", id, name, input }],
        source: SOURCE,
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}

function assistantText(text: string): AssistantMessage {
    return {
        role: "assistant",
        content: [{ type: "text", text }],
        source: SOURCE,
        usage: emptyUsage(),
        stopReason: "stop",
    };
}

function capturingAdapter(
    responses: readonly AssistantMessage[],
    capture: (request: ModelRequest) => void,
): ModelAdapter {
    const faux = new FauxAdapter(responses);
    return {
        stream(request) {
            capture(request);
            return faux.stream(request);
        },
    };
}

function testState(
    channel: InProcessChannel,
    events: EngineEventBus,
    hooks: ToolHooks,
    approvalMode: "auto" | "readonly",
): RunTurnState {
    return {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(process.cwd()),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks,
        approvalMode,
    };
}

async function drainUntilFinished(channel: InProcessChannel): Promise<void> {
    while (true) {
        const update = await channel.client.receive();
        if (update.type === "turn_finished") return;
    }
}

function offeredNames(request: ModelRequest): string[] {
    return (request.tools ?? []).map((tool) => tool.name);
}

test("a pre_turn hook narrows the tools for a prompt that arrives mid-turn", async () => {
    const hooks = new ToolHooks();
    hooks.registerPreTurn((payload) => {
        if (payload.arrivedDuringTurn) {
            return {
                power: "mutate",
                tools: payload.tools.filter((name) => name !== "read"),
            };
        }
        return { power: "observe" };
    });

    const requests: ModelRequest[] = [];
    const adapter = capturingAdapter(
        [
            toolResponse("call_1", "bash", { command: "sleep 0.3" }),
            assistantText("done"),
        ],
        (request) => {
            requests.push(request);
            if (requests.length === 1) {
                channel.client.send({ type: "prompt", content: "and this" });
            }
        },
    );
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const state = testState(channel, events, hooks, "auto");
    channel.client.send({ type: "prompt", content: "first" });
    const turn = runTurn(adapter, "test", state);
    await drainUntilFinished(channel);
    await turn;

    expect(requests).toHaveLength(2);
    expect(offeredNames(requests[0]!)).toContain("read");
    expect(offeredNames(requests[1]!)).not.toContain("read");
});

test("a delivery turn after a refusal offers the same tools as the turn before it", async () => {
    const denied = { command: "echo hi > /tmp/vera-tool-list-prefix.txt" };
    const requests: ModelRequest[] = [];
    const adapterFor = (responses: readonly AssistantMessage[]): ModelAdapter =>
        capturingAdapter(responses, (request) => {
            requests.push(request);
        });
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const state = testState(channel, events, new ToolHooks(), "readonly");

    channel.client.send({ type: "prompt", content: "try the write" });
    const first = runTurn(
        adapterFor([
            toolResponse("call_1", "bash", denied),
            toolResponse("call_2", "bash", denied),
            toolResponse("call_3", "bash", denied),
            assistantText("done"),
        ]),
        "test",
        state,
    );
    await drainUntilFinished(channel);
    await first;

    (channel.client as unknown as { send(command: unknown): void })
        .send({ type: "trigger_delivery_turn" });
    const second = runTurn(
        adapterFor([assistantText("delivered")]),
        "test",
        state,
    );
    await drainUntilFinished(channel);
    await second;

    expect(requests).toHaveLength(5);
    expect(offeredNames(requests[4]!)).toEqual(offeredNames(requests[3]!));
});
