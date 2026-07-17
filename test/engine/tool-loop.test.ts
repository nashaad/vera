import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runTurn, type RunTurnState } from "../../src/engine/run-turn.ts";
import { EngineEventBus } from "../../src/engine/events.ts";
import { createFrameProjector } from "../../src/engine/frames.ts";
import {
    emptyUsage,
    type AssistantMessage,
    type ModelAdapter,
    type ModelRequest,
} from "../../src/model/types.ts";
import { createInProcessChannel } from "../../src/engine/in-process-channel.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";

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
    const state: RunTurnState = {
        messages: [],
        toolRuntime: new ToolRuntime(workspace),
        queuedPrompts: [],
        events: new EngineEventBus(),
    };
    state.events.subscribe(createFrameProjector(channel.engine));

    try {
        channel.client.send({ type: "prompt", content: "check the workspace" });
        const turn = runTurn(channel.engine, adapter, "test", state);
        const frameTypes: string[] = [];

        while (true) {
            const frame = await channel.client.receive();
            frameTypes.push(frame.type);
            if (frame.type === "turn_finished") {
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
        expect(frameTypes).toEqual([
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
