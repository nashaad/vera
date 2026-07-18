import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { createProtocolEncoder } from "../../src/engine/protocol.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";

test("multiple tool calls execute sequentially in content order", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-tool-loop-"));
    const realWorkspace = await realpath(workspace);
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [
            {
                type: "tool_call",
                id: "call_bash",
                name: "bash",
                input: { command: "pwd" },
            },
            {
                type: "tool_call",
                id: "call_write",
                name: "write",
                input: { path: "note.txt", content: "hello" },
            },
            {
                type: "tool_call",
                id: "call_read",
                name: "read",
                input: { path: "note.txt" },
            },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([toolCallResponse, finalResponse]);
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
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "approve_for_me",
    };

    try {
        channel.client.send({ type: "prompt", content: "check the workspace" });
        const turn = runTurn(adapter, "test", state);
        const updateTypes: string[] = [];

        while (true) {
            const update = await channel.client.receive();
            updateTypes.push(update.type);
            if (update.type === "turn_finished") {
                break;
            }
        }

        expect(await turn).toEqual(finalResponse);
        expect(requests).toHaveLength(2);
        for (const request of requests) {
            expect(request.systemPrompt).toContain("## Identity\n");
            expect(request.systemPrompt).toContain(
                `## Workspace\nWorking directory: ${workspace}`,
            );
            for (const tool of request.tools ?? []) {
                expect(request.systemPrompt).toContain(
                    `- ${tool.name}: ${tool.description}`,
                );
            }
        }
        expect(updateTypes).toEqual([
            "user_prompt",
            "tool_started",
            "tool_finished",
            "tool_started",
            "tool_finished",
            "tool_started",
            "tool_finished",
            "assistant_delta",
            "turn_finished",
        ]);

        const toolResults = state.messages.filter(
            (message) => message.role === "tool_result",
        );
        expect(toolResults.map((result) => result.toolName)).toEqual([
            "bash",
            "write",
            "read",
        ]);
        expect(toolResults[0]?.content[0]?.text).toBe(realWorkspace);
        expect(toolResults[1]?.isError).toBe(false);
        expect(toolResults[2]?.content[0]?.text).toBe("hello");
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("the turn loop applies a subagent effect and returns its text", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-subagent-loop-"));
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_subagent",
            name: "subagent",
            input: { description: "Trace the request path" },
        }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "The child traced it." }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const faux = new FauxAdapter([toolCallResponse, finalResponse]);
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
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "approve_for_me",
        enabledToolEffects: ["spawn_subagent"],
        async applyToolEffect(effect) {
            expect(effect).toEqual({
                type: "spawn_subagent",
                description: "Trace the request path",
            });
            return {
                kind: "output",
                output: "The socket reaches the resident agent.",
                isError: false,
            };
        },
    };

    try {
        channel.client.send({ type: "prompt", content: "delegate this" });
        const turn = runTurn(adapter, "test", state);
        while ((await channel.client.receive()).type !== "turn_finished") {
            // Drain protocol updates until the turn completes.
        }

        expect(await turn).toEqual(finalResponse);
        expect(requests[0]?.tools?.map((tool) => tool.name)).toContain(
            "subagent",
        );
        const result = state.messages.find(
            (message) => message.role === "tool_result",
        );
        expect(result?.content[0]?.text).toBe(
            "The socket reaches the resident agent.",
        );
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("sibling subagents run concurrently and commit results in call order", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-subagent-parallel-"));
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [
            {
                type: "tool_call",
                id: "call_slow",
                name: "subagent",
                input: { description: "slow child" },
            },
            {
                type: "tool_call",
                id: "call_fast",
                name: "subagent",
                input: { description: "fast child" },
            },
        ],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
    const finalResponse: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "both children returned" }],
        source: { provider: "faux", api: "scripted", model: "test" },
        usage: emptyUsage(),
        stopReason: "stop",
    };
    const adapter = new FauxAdapter([toolCallResponse, finalResponse]);
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    let activeChildren = 0;
    let maximumActiveChildren = 0;
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "approve_for_me",
        enabledToolEffects: ["spawn_subagent"],
        async applyToolEffect(effect) {
            activeChildren += 1;
            maximumActiveChildren = Math.max(
                maximumActiveChildren,
                activeChildren,
            );
            try {
                await Bun.sleep(effect.description.startsWith("slow") ? 30 : 5);
                return {
                    kind: "output",
                    output: `${effect.description} result`,
                    isError: false,
                };
            } finally {
                activeChildren -= 1;
            }
        },
    };

    try {
        channel.client.send({ type: "prompt", content: "fan out" });
        const turn = runTurn(adapter, "test", state);
        while ((await channel.client.receive()).type !== "turn_finished") {
            // Drain protocol updates until the parent turn completes.
        }

        expect(await turn).toEqual(finalResponse);
        expect(maximumActiveChildren).toBe(2);
        const results = state.messages.filter(
            (message) => message.role === "tool_result",
        );
        expect(results.map((result) => result.toolCallId)).toEqual([
            "call_slow",
            "call_fast",
        ]);
        expect(results.map((result) => result.content[0]?.text)).toEqual([
            "slow child result",
            "fast child result",
        ]);
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});
