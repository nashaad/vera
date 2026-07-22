import { expect, test } from "bun:test";

import {
    assembleContextualSystemPrompt,
    assembleStableSystemPrompt,
} from "../../src/engine/assemble.ts";
import { buildModelRequest } from "../../src/engine/model-request.ts";
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
