import { expect, test } from "bun:test";

import {
    assembleContextualSystemPrompt,
    assembleStableSystemPrompt,
} from "../../src/engine/assemble.ts";
import {
    buildModelRequest,
    projectModelRequest,
} from "../../src/engine/model-request.ts";
import type { ModelMessage, ModelTool } from "../../src/model/types.ts";

test("model request uses one frozen message and tool snapshot", () => {
    const messages: ModelMessage[] = [{
        role: "user",
        content: [{ type: "text", text: "inspect it" }],
    }];
    const tools: ModelTool[] = [{
        name: "inspect",
        description: "Inspect the current state.",
        inputSchema: { type: "object" },
    }];

    const request = buildModelRequest({
        model: "test-model",
        maxTokens: 4096,
        reasoningEffort: "high",
        messages,
        tools,
        workspace: "/work/vera",
        date: new Date(2026, 6, 21),
        projectInstructions: { files: [], warnings: [] },
        signal: new AbortController().signal,
    });

    messages.push({
        role: "user",
        content: [{ type: "text", text: "too late" }],
    });
    tools.push({
        name: "change",
        description: "Change the current state.",
        inputSchema: { type: "object" },
    });

    expect(Object.isFrozen(request)).toBe(true);
    expect(Object.isFrozen(request.messages)).toBe(true);
    expect(Object.isFrozen(request.tools)).toBe(true);
    expect(request.messages).toHaveLength(1);
    expect(request.tools).toHaveLength(1);
    expect(request.systemPrompt).toContain(
        "- inspect: Inspect the current state.",
    );
    expect(request.systemPrompt).not.toContain("- change:");
});

test("model requests strip durable tool presentation metadata", () => {
    const request = buildModelRequest({
        model: "test-model",
        maxTokens: 4096,
        messages: [{
            role: "tool_result",
            toolCallId: "call-1",
            toolName: "edit",
            content: [{ type: "text", text: "Applied 1 edit to notes.txt" }],
            isError: false,
            presentation: {
                kind: "unified_diff",
                path: "notes.txt",
                patch: "SECRET DIFF",
            },
        }],
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 6, 21),
        projectInstructions: { files: [], warnings: [] },
        signal: new AbortController().signal,
    });

    expect(request.messages).toEqual([{
        role: "tool_result",
        toolCallId: "call-1",
        toolName: "edit",
        content: [{ type: "text", text: "Applied 1 edit to notes.txt" }],
        isError: false,
    }]);
    expect(JSON.stringify(request)).not.toContain("SECRET DIFF");
});

test("model requests omit empty assistant failures from durable history", () => {
    const failed: ModelMessage = {
        role: "assistant",
        content: [],
        source: { provider: "openrouter", api: "chat", model: "test-model" },
        usage: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 0,
        },
        stopReason: "error",
        errorMessage: "Provider returned error",
    };
    const request = buildModelRequest({
        model: "test-model",
        maxTokens: 4096,
        messages: [
            { role: "user", content: [{ type: "text", text: "first" }] },
            failed,
            { role: "user", content: [{ type: "text", text: "try again" }] },
        ],
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 7, 6),
        projectInstructions: { files: [], warnings: [] },
        signal: new AbortController().signal,
    });

    expect(request.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "first" }] },
        { role: "user", content: [{ type: "text", text: "try again" }] },
    ]);
});

test("model requests preserve signed reasoning without visible assistant text", () => {
    const request = buildModelRequest({
        model: "test-model",
        maxTokens: 4096,
        messages: [{
            role: "assistant",
            content: [{
                type: "thinking",
                text: "",
                signature: "signed-reasoning",
            }],
            source: { provider: "openrouter", api: "chat", model: "test-model" },
            usage: {
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                totalTokens: 0,
            },
            stopReason: "stop",
        }],
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 7, 6),
        projectInstructions: { files: [], warnings: [] },
        signal: new AbortController().signal,
    });

    expect(request.messages).toHaveLength(1);
});

test("equal boundary snapshots produce equal prompts including empty tools", () => {
    const input = {
        model: "test-model",
        maxTokens: 4096,
        messages: [] as readonly ModelMessage[],
        tools: [] as readonly ModelTool[],
        workspace: "/work/vera",
        date: new Date(2026, 6, 21),
        projectInstructions: { files: [], warnings: [] },
        signal: new AbortController().signal,
    };

    const first = buildModelRequest(input);
    const second = buildModelRequest(input);

    expect(first.systemPrompt).toBe(second.systemPrompt);
    expect(first.systemPrompt).toContain("Available tools:\n(none)");
    expect(first.tools).toEqual([]);
});

test("append-only history and contextual changes preserve the stable prefix", () => {
    const base = {
        model: "test-model",
        maxTokens: 4096,
        tools: [{
            name: "inspect",
            description: "Inspect the current state.",
            inputSchema: { type: "object" },
        }],
        workspace: "/work/vera",
        signal: new AbortController().signal,
    };
    const first = buildModelRequest({
        ...base,
        messages: [{
            role: "user",
            content: [{ type: "text", text: "first" }],
        }],
        date: new Date(2026, 6, 21),
        projectInstructions: { files: [], warnings: [] },
    });
    const second = buildModelRequest({
        ...base,
        messages: [
            ...first.messages,
            {
                role: "user",
                content: [{ type: "text", text: "second" }],
            },
        ],
        date: new Date(2026, 6, 22),
        projectInstructions: {
            files: [],
            warnings: ["AGENTS.md could not be read"],
        },
    });
    const stableSystemPrompt = assembleStableSystemPrompt(base);
    const firstContext = assembleContextualSystemPrompt({
        date: new Date(2026, 6, 21),
        projectInstructions: { files: [], warnings: [] },
    });
    const secondContext = assembleContextualSystemPrompt({
        date: new Date(2026, 6, 22),
        projectInstructions: {
            files: [],
            warnings: ["AGENTS.md could not be read"],
        },
    });

    expect(first.systemPrompt).toBe(`${stableSystemPrompt}\n\n${firstContext}`);
    expect(second.systemPrompt).toBe(`${stableSystemPrompt}\n\n${secondContext}`);
    expect(firstContext).not.toBe(secondContext);
    expect(secondContext).toContain("Current date: 2026-07-22");
    expect(secondContext).toContain("AGENTS.md could not be read");
});

test("prompt diagnostics stay outside the provider request", () => {
    const projection = projectModelRequest({
        model: "test-model",
        maxTokens: 4096,
        messages: [],
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 6, 21),
        projectInstructions: { files: [], warnings: [] },
        signal: new AbortController().signal,
    });

    expect(projection.promptContributions.map((entry) => entry.id)).toEqual([
        "core.identity",
        "core.tools",
        "core.workspace",
        "core.date",
    ]);
    expect(Object.keys(projection.request)).not.toContain(
        "promptContributions",
    );
    expect(Object.isFrozen(projection.promptContributions)).toBe(true);
});
