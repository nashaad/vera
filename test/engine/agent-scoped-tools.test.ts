import { expect, test } from "bun:test";

import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import type { RegisteredTool } from "../../src/tools/types.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

const helpOnly: RegisteredTool = {
    agents: ["help"],
    definition: {
        name: "help_only",
        description: "Help only",
        inputSchema: { type: "object", properties: {} },
    },
    async execute() {
        return { kind: "output", output: "ran", isError: false };
    },
};

const done: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: "done" }],
    source: { provider: "faux", api: "scripted", model: "test" },
    usage: emptyUsage(),
    stopReason: "stop",
};

async function offeredTo(agent: string | undefined): Promise<readonly string[]> {
    const faux = new FauxAdapter([done]);
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
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime("/tmp"),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "full_access",
        extensionTools: [helpOnly],
        ...(agent === undefined ? {} : {
            readSelectedAgent: () => ({ name: agent, instructions: "x" }),
        }),
    };
    channel.client.send({ type: "prompt", content: "hello" });
    const turn = runTurn(adapter, "test", state);
    while ((await channel.client.receive()).type !== "turn_finished") {
        // Drain the turn.
    }
    await turn;
    return requests[0]?.tools?.map((tool) => tool.name) ?? [];
}

test("an agent-scoped tool reaches the model only while its agent is selected", async () => {
    expect(await offeredTo("help")).toContain("help_only");
    expect(await offeredTo("chat")).not.toContain("help_only");
    expect(await offeredTo(undefined)).not.toContain("help_only");
});
