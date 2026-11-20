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

test("a prompt that arrived during a turn is wrapped only in the request", () => {
    const stored: ModelMessage = {
        role: "user",
        content: [
            { type: "text", text: "check the rigging too" },
            { type: "image_attachment", attachmentId: "crow-map" },
        ],
        arrivedDuringTurn: true,
    };

    const request = buildModelRequest({
        model: "test-model",
        maxTokens: 4096,
        messages: [stored],
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 6, 21),
        projectInstructions: { files: [], warnings: [] },
        signal: new AbortController().signal,
    });

    expect(request.messages).toEqual([{
        role: "user",
        content: [
            {
                type: "text",
                text: "<system-reminder>\n"
                    + "The user sent a new message while you were working:\n"
                    + "check the rigging too\n\n"
                    + "IMPORTANT: After completing your current task, you MUST"
                    + " address the user's message above. Do not ignore it.\n"
                    + "</system-reminder>",
            },
            { type: "image_attachment", attachmentId: "crow-map" },
        ],
    }]);
    expect(stored.content[0]).toEqual({
        type: "text",
        text: "check the rigging too",
    });
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
            toolResultSource: {
                originalBytes: 3_000,
                spillPath: "/private/scratch/tool-results/result.txt",
            },
            withheld: true,
            classifierOutcome: {
                kind: "denied",
                riskLevel: "high",
                reason: "SECRET VERDICT",
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
    expect(JSON.stringify(request)).not.toContain("SECRET VERDICT");
});

test("@core exit metadata leaves consecutive model requests unchanged", () => {
    const base = {
        model: "test-model",
        maxTokens: 4096,
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 6, 21),
        projectInstructions: { files: [], warnings: [] },
        signal: new AbortController().signal,
    };
    const result = {
        role: "tool_result" as const,
        toolCallId: "call-1",
        toolName: "bash",
        content: [{ type: "text" as const, text: "command output" }],
        isError: true,
    };
    const withExit = { ...result, exitCode: 2 };
    const next = { role: "user" as const, content: [{ type: "text" as const, text: "continue" }] };
    const first = buildModelRequest({ ...base, messages: [withExit] });
    const second = buildModelRequest({ ...base, messages: [withExit, next] });
    const previousFirst = buildModelRequest({ ...base, messages: [result] });
    const previousSecond = buildModelRequest({ ...base, messages: [result, next] });

    expect(first.messages).toEqual(previousFirst.messages);
    expect(second.messages).toEqual(previousSecond.messages);
    expect(second.messages[0]).toEqual(first.messages[0]);
    expect(first.systemPrompt).toBe(previousFirst.systemPrompt);
    expect(second.systemPrompt).toBe(previousSecond.systemPrompt);
    expect(JSON.stringify([first.messages, second.messages])).not.toContain("exitCode");
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

test("model requests omit stop causes from non-empty assistant history across requests", () => {
    const stopped: ModelMessage = {
        role: "assistant",
        content: [{ type: "text", text: "partial reply" }],
        source: { provider: "openrouter", api: "chat", model: "test-model" },
        usage: {
            inputTokens: 1,
            outputTokens: 1,
            cachedInputTokens: 0,
            reasoningTokens: 0,
            totalTokens: 2,
        },
        stopReason: "aborted",
        stopCause: "host_stopped_unexpectedly",
    };
    const base = {
        model: "test-model",
        maxTokens: 4096,
        tools: [],
        workspace: "/work/vera",
        date: new Date(2026, 7, 6),
        projectInstructions: { files: [], warnings: [] },
        signal: new AbortController().signal,
    };
    const first = buildModelRequest({
        ...base,
        messages: [stopped],
    });
    const second = buildModelRequest({
        ...base,
        date: new Date(2026, 7, 7),
        messages: [stopped, {
            role: "user",
            content: [{ type: "text", text: "continue" }],
        }],
    });

    expect(first.messages).toEqual([{
        role: "assistant",
        content: [{ type: "text", text: "partial reply" }],
        source: stopped.source,
        usage: stopped.usage,
        stopReason: "aborted",
    }]);
    expect(second.messages[0]).toEqual(first.messages[0]);
    expect(JSON.stringify(first.messages)).not.toContain("stopCause");
    expect(JSON.stringify(second.messages)).not.toContain("stopCause");
    expect(stopped.stopCause).toBe("host_stopped_unexpectedly");
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
        "core.narration",
        "core.tools",
        "core.workspace",
        "core.date",
    ]);
    expect(Object.keys(projection.request)).not.toContain(
        "promptContributions",
    );
    expect(Object.isFrozen(projection.promptContributions)).toBe(true);
});

test("a request carries the notes contribution in its stable prompt only when the snapshot asks for it", () => {
    const base = {
        model: "test-model",
        maxTokens: 4096,
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] satisfies ModelMessage[],
        tools: [] satisfies ModelTool[],
        workspace: "/work/vera",
        date: new Date(2026, 6, 21),
        projectInstructions: { files: [], warnings: [] },
        signal: new AbortController().signal,
    };
    const offered = projectModelRequest({ ...base, notesOffer: true });
    const plain = projectModelRequest(base);

    expect(offered.request.systemPrompt).toContain("## Notes\n");
    expect(plain.request.systemPrompt).not.toContain("## Notes\n");
    expect(offered.promptContributions.map((entry) => entry.id)).toContain("core.notes");
    expect(plain.promptContributions.map((entry) => entry.id)).not.toContain("core.notes");
    const stable = (prompt: string | undefined): string => (prompt ?? "").split("\n\n## Date")[0]!;
    expect(stable(offered.request.systemPrompt).replace(/\n\n## Notes\n[^\n]*/, "")).toBe(stable(plain.request.systemPrompt));
});
