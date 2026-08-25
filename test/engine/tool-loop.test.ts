import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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
    type ToolResultMessage,
} from "../../src/model/types.ts";
import { createInProcessChannel } from "../../src/engine/message-channel.ts";
import { InboundCommandRouter } from "../../src/engine/inbound-command-router.ts";
import { ToolHooks } from "../../src/engine/hooks.ts";
import { ToolRuntime } from "../../src/tools/runtime.ts";
import { FauxAdapter } from "../support/faux-adapter.ts";
import { InMemorySessionStore } from "../support/in-memory-session-store.ts";
import { projectSkillDirectory } from "../../src/skills/catalog.ts";
import { loadSkillContribution } from "../../src/skills/contribution.ts";
import { skillScriptTool } from "../../src/skills/script.ts";
import {
    withoutCallDuration,
    withoutSessionUsage,
} from "../support/wire-usage.ts";

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
        approvalMode: "full_access",
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

        expect(withoutCallDuration(await turn)).toEqual(finalResponse);
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
        // Two model rounds, so two measurements: one for the request that
        // asked for the tools and one for the request carrying their results.
        expect(updateTypes).toEqual([
            "user_prompt",
            "context",
            "tool_started",
            "tool_finished",
            "tool_started",
            "tool_finished",
            // The write tool announces its diff presentation once it lands.
            "tool_presentation",
            "tool_started",
            "tool_finished",
            "context",
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
        expect(toolResults[2]?.content[0]?.text).toBe(
            "1\thello\n[vera] Showing lines 1-1 of 1.",
        );
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});

test("a discovered skill script runs through the ordinary tool loop", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-skill-loop-"));
    const skillDirectory = join(projectSkillDirectory(workspace), "inspect");
    const scriptsDirectory = join(skillDirectory, "scripts");
    await mkdir(scriptsDirectory, { recursive: true });
    await writeFile(join(skillDirectory, "SKILL.md"), `---
name: inspect
description: Inspect a value with the bundled helper.
disable-model-invocation: true
---
Run \`scripts/inspect.sh\` with the value as its first argument.
`);
    const scriptPath = join(scriptsDirectory, "inspect.sh");
    await writeFile(scriptPath, "#!/bin/sh\nprintf 'inspected:%s' \"$1\"\n");
    await chmod(scriptPath, 0o755);
    const toolCallResponse: AssistantMessage = {
        role: "assistant",
        content: [{
            type: "tool_call",
            id: "call_skill_script",
            name: "skill_script",
            input: {
                skill: "inspect",
                script: "scripts/inspect.sh",
                args: ["value"],
            },
        }],
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
        instructionRoot: { path: workspace, source: "workspace" },
        inbound: new InboundCommandRouter(channel.engine, events, {
            invokeSkill: async () => ({ allowed: true }),
        }),
        events,
        hooks: new ToolHooks(),
        approvalMode: "full_access",
        extensionTools: [skillScriptTool],
        loadContextualContributions: loadSkillContribution,
    };

    try {
        channel.client.send({
            type: "invoke_skill",
            requestId: "invoke-inspect",
            name: "inspect",
            argumentsText: "value",
        });
        const turn = runTurn(adapter, "test", state);
        while ((await channel.client.receive()).type !== "turn_finished") {
            // Drain the observable lifecycle through its terminal update.
        }
        await turn;

        expect(requests[0]?.systemPrompt).toContain("## Skills");
        expect(requests[0]?.systemPrompt).toContain("inspect: Inspect a value");
        expect(requests[0]?.tools?.some((tool) => tool.name === "skill_script"))
            .toBe(true);
        const result = state.messages.find((message): message is ToolResultMessage =>
            message.role === "tool_result" && message.toolName === "skill_script"
        );
        expect(result?.content).toEqual([{
            type: "text",
            text: "inspected:value",
        }]);
        expect(result?.isError).toBe(false);
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
        approvalMode: "full_access",
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

        expect(withoutCallDuration(await turn)).toEqual(finalResponse);
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
        approvalMode: "full_access",
        enabledToolEffects: ["spawn_subagent"],
        async applyToolEffect(effect) {
            if (effect.type !== "spawn_subagent") {
                throw new Error(`Unexpected tool effect: ${effect.type}`);
            }
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

        expect(withoutCallDuration(await turn)).toEqual(finalResponse);
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

test("a subagent that ran on another model reports it as a substitution update", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "vera-subagent-swap-"));
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
    const adapter: ModelAdapter = { stream: (request) => faux.stream(request) };
    const channel = createInProcessChannel();
    const events = new EngineEventBus();
    events.subscribe(createProtocolEncoder(channel.engine));
    const substitution = {
        scope: "model" as const,
        model: "openrouter/session",
        requested: "openrouter/absent",
        using: "openrouter/session",
        reason: "openrouter/absent is not in the pool",
    };
    const state: RunTurnState = {
        messages: [],
        store: new InMemorySessionStore(),
        toolRuntime: new ToolRuntime(workspace),
        inbound: new InboundCommandRouter(channel.engine, events),
        events,
        hooks: new ToolHooks(),
        approvalMode: "full_access",
        enabledToolEffects: ["spawn_subagent"],
        async applyToolEffect() {
            return {
                kind: "output",
                output: "The child ran elsewhere.",
                isError: false,
                substitutions: [substitution],
            };
        },
    };

    try {
        channel.client.send({ type: "prompt", content: "delegate this" });
        const turn = runTurn(adapter, "test", state);
        const updates: string[] = [];
        let seen: unknown;
        for (;;) {
            const update = await channel.client.receive();
            updates.push(update.type);
            if (update.type === "model_substitution") {
                seen = update;
            }
            if (update.type === "turn_finished") {
                break;
            }
        }
        await turn;

        expect(updates).toContain("model_substitution");
        expect(seen).toEqual({
            type: "model_substitution",
            ...substitution,
            source: "subagent",
            seq: expect.any(Number),
        });
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});
