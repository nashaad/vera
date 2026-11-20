import { expect, test } from "bun:test";

import { EngineEventBus, type EngineEvent } from "../../src/engine/events.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { createProtocolEncoder, type AgentUpdate } from "../../src/engine/protocol.ts";
import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { emptyUsage, type AssistantMessage, type ModelAdapter, type ModelRequest } from "../../src/model/types.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

test("@core observed exit survives hooks, events and storage without reaching the provider", async () => {
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    const updates: AgentUpdate[] = [];
    const observed: EngineEvent[] = [];
    events.subscribe(createProtocolEncoder({ send: (update) => updates.push(update) }));
    events.subscribe((event) => observed.push(event));
    const hooks = new ToolHooks();
    let hookExit: number | undefined;
    hooks.registerPostToolUse((payload) => {
        hookExit = payload.result.exitCode;
        return {
            power: "mutate",
            patch: { content: [{ type: "text", text: "redacted output" }] },
        };
    });
    const runtime = new ToolRuntime(process.cwd());
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: runtime,
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks,
        approvalMode: "full_access",
    };
    const request = (content: AssistantMessage["content"], stopReason: "tool_use" | "stop"): AssistantMessage => ({
        role: "assistant",
        content,
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason,
    });
    const faux = new FauxAdapter([
        request([{ type: "tool_call", id: "call-1", name: "bash", input: { command: "exit 2" } }], "tool_use"),
        request([{ type: "text", text: "done" }], "stop"),
    ]);
    const requests: ModelRequest[] = [];
    const adapter: ModelAdapter = {
        stream(value) {
            requests.push({ ...value, messages: structuredClone(value.messages) });
            return faux.stream(value);
        },
    };
    try {
        channel.client.send({ type: "prompt", content: "run it" });
        await runTurn(adapter, "test", state);
        expect(hookExit).toBe(2);
        expect(state.messages.find((message) => message.role === "tool_result")).toMatchObject({
            isError: true,
            exitCode: 2,
            content: [{ type: "text", text: "redacted output" }],
        });
        expect(updates.find((update) => update.type === "tool_finished")).toMatchObject({
            isError: true,
            exitCode: 2,
        });
        const changed = observed.find((event) => event.type === "tool_result_changed");
        expect(changed?.type === "tool_result_changed" ? changed.original.exitCode : undefined).toBe(2);
        expect(changed?.type === "tool_result_changed" ? changed.effective.exitCode : undefined).toBe(2);
        expect(requests).toHaveLength(2);
        expect(JSON.stringify(requests[1]?.messages)).not.toContain("exitCode");
        expect(requests[1]?.messages.find((message) => message.role === "tool_result")).toMatchObject({
            isError: true,
            content: [{ type: "text", text: "redacted output" }],
        });
    } finally {
        await runtime.close();
    }
});
