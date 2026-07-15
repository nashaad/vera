import { describe, expect, test } from "bun:test";

import { transformMessages } from "../../src/model/transform.ts";
import { emptyUsage, type ModelMessage } from "../../src/model/types.ts";

describe("transformMessages", () => {
    test("prepares a provider-safe replay without changing stored messages", () => {
        const messages: ModelMessage[] = [
            {
                role: "assistant",
                content: [
                    { type: "thinking", text: "private reasoning", signature: "sig" },
                    {
                        type: "tool_call",
                        id: "call:unsafe",
                        name: "read",
                        input: { path: "README.md" },
                        signature: "tool-sig",
                    },
                ],
                source: { provider: "anthropic", api: "messages", model: "claude" },
                usage: emptyUsage(),
                stopReason: "tool_use",
            },
            {
                role: "tool_result",
                toolCallId: "call:unsafe",
                toolName: "read",
                content: [{ type: "text", text: "hello" }],
                isError: false,
            },
        ];
        const storedSnapshot = structuredClone(messages);

        const transformed = transformMessages(messages, {
            target: { provider: "openrouter", api: "openrouter-chat", model: "gpt" },
            normalizeToolCallId: (id) => id.replace(":", "_"),
        });

        expect(transformed[0]?.role).toBe("assistant");
        expect(transformed[0]?.content).toEqual([
            { type: "text", text: "private reasoning" },
            {
                type: "tool_call",
                id: "call_unsafe",
                name: "read",
                input: { path: "README.md" },
            },
        ]);
        expect(transformed[1]).toEqual({
            role: "tool_result",
            toolCallId: "call_unsafe",
            toolName: "read",
            content: [{ type: "text", text: "hello" }],
            isError: false,
        });
        expect(messages).toEqual(storedSnapshot);
    });

    test("adds an explicit error result for an orphaned tool call", () => {
        const transformed = transformMessages(
            [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_call",
                            id: "call_1",
                            name: "bash",
                            input: { command: "pwd" },
                        },
                    ],
                    source: { provider: "openrouter", api: "chat", model: "test" },
                    usage: emptyUsage(),
                    stopReason: "tool_use",
                },
            ],
            {
                target: { provider: "openrouter", api: "chat", model: "next" },
            },
        );

        expect(transformed[1]).toEqual({
            role: "tool_result",
            toolCallId: "call_1",
            toolName: "bash",
            content: [{ type: "text", text: "Tool call did not receive a result." }],
            isError: true,
        });
    });

    test("removes tool results belonging to a failed assistant message", () => {
        const transformed = transformMessages(
            [
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_call",
                            id: "call_1",
                            name: "bash",
                            input: { command: "pwd" },
                        },
                    ],
                    source: { provider: "openrouter", api: "chat", model: "test" },
                    usage: emptyUsage(),
                    stopReason: "error",
                },
                {
                    role: "tool_result",
                    toolCallId: "call_1",
                    toolName: "bash",
                    content: [{ type: "text", text: "partial" }],
                    isError: true,
                },
            ],
            {
                target: { provider: "openrouter", api: "chat", model: "next" },
            },
        );

        expect(transformed).toEqual([]);
    });

    test("rejects tool call IDs that collide after normalization", () => {
        expect(() => transformMessages(
            [
                assistantToolCall("call:a"),
                assistantToolCall("call/a"),
            ],
            {
                target: { provider: "openrouter", api: "chat", model: "test" },
                normalizeToolCallId: (id) => id.replace(/[^a-z]/g, "_"),
            },
        )).toThrow("Tool call ID normalization produced duplicate ID: call_a");
    });
});

function assistantToolCall(id: string): ModelMessage {
    return {
        role: "assistant",
        content: [
            {
                type: "tool_call",
                id,
                name: "read",
                input: { path: "README.md" },
            },
        ],
        source: { provider: "other", api: "chat", model: "test" },
        usage: emptyUsage(),
        stopReason: "tool_use",
    };
}
