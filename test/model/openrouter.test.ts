import { describe, expect, test } from "bun:test";
import type {
    ChatFinishReasonEnum,
    ChatStreamChunk,
    ChatStreamDelta,
    ChatUsage,
} from "@openrouter/sdk/models";

import {
    OpenRouterAdapter,
    type SendOpenRouterChat,
} from "../../src/model/openrouter.ts";
import { normalizeOpenRouterToolCallId } from "../../src/model/openrouter-wire.ts";
import type { ModelStreamEvent } from "../../src/model/types.ts";

describe("OpenRouter adapter", () => {
    test("normalizes tool call characters without truncating IDs", () => {
        const id = `call:${"a".repeat(80)}`;

        expect(normalizeOpenRouterToolCallId(id)).toBe(`call_${"a".repeat(80)}`);
    });

    test("normalizes a stream and returns the completed assistant message", async () => {
        const sendChat: SendOpenRouterChat = async (request) => {
            expect(request.messages).toEqual([
                { role: "system", content: "Be concise." },
                { role: "user", content: "hello" },
            ]);

            return chunks([
                chatChunk({
                    model: "routed/model",
                    delta: {
                        reasoning: "check",
                        reasoningDetails: [
                            {
                                type: "reasoning.text",
                                text: "check",
                                signature: "reasoning-signature",
                            },
                        ],
                    },
                }),
                chatChunk({ delta: { content: "Hello" } }),
                chatChunk({
                    delta: {
                        toolCalls: [
                            {
                                index: 0,
                                id: "call_1",
                                function: {
                                    name: "bash",
                                    arguments: '{"command":',
                                },
                            },
                        ],
                    },
                }),
                chatChunk({
                    usage: {
                        promptTokens: 4,
                        completionTokens: 7,
                        totalTokens: 11,
                    },
                    delta: {
                        toolCalls: [
                            {
                                index: 0,
                                function: { arguments: '"pwd"}' },
                            },
                        ],
                    },
                    finishReason: "tool_calls",
                }),
            ]);
        };
        const adapter = new OpenRouterAdapter(sendChat);
        const stream = adapter.stream({
            model: "test/model",
            systemPrompt: "Be concise.",
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "hello" }],
                },
            ],
        });

        const events: ModelStreamEvent[] = [];
        for await (const event of stream) {
            events.push(event);
        }

        expect(events.map((event) => event.type)).toEqual([
            "start",
            "thinking_start",
            "thinking_delta",
            "text_start",
            "text_delta",
            "tool_call_start",
            "tool_call_delta",
            "tool_call_delta",
            "text_end",
            "thinking_end",
            "tool_call_end",
            "done",
        ]);
        expect(await stream.result()).toEqual({
            role: "assistant",
            content: [
                {
                    type: "thinking",
                    text: "check",
                    signature: JSON.stringify([
                        {
                            type: "reasoning.text",
                            text: "check",
                            signature: "reasoning-signature",
                        },
                    ]),
                },
                { type: "text", text: "Hello" },
                {
                    type: "tool_call",
                    id: "call_1",
                    name: "bash",
                    input: { command: "pwd" },
                },
            ],
            source: {
                provider: "openrouter",
                api: "openrouter-chat",
                model: "test/model",
                responseModel: "routed/model",
            },
            usage: {
                inputTokens: 4,
                outputTokens: 7,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                totalTokens: 11,
            },
            stopReason: "tool_use",
        });
    });

    test("does not call the provider when already aborted", async () => {
        let called = false;
        const adapter = new OpenRouterAdapter(async () => {
            called = true;
            return chunks([]);
        });
        const controller = new AbortController();
        controller.abort(new Error("stop now"));
        const stream = adapter.stream({
            model: "test/model",
            messages: [],
            signal: controller.signal,
        });

        for await (const _event of stream) {
            // Drain the stream.
        }

        expect(called).toBe(false);
        expect((await stream.result()).stopReason).toBe("aborted");
    });

    test("replays stored OpenRouter reasoning details", async () => {
        const signature = JSON.stringify([
            {
                type: "reasoning.text",
                text: "check",
                signature: "reasoning-signature",
            },
        ]);
        const adapter = new OpenRouterAdapter(async (request) => {
            expect(request.messages[0]).toMatchObject({
                role: "assistant",
                reasoning: "check",
                reasoningDetails: JSON.parse(signature),
            });
            return chunks([chatChunk({ delta: {}, finishReason: "stop" })]);
        });
        const stream = adapter.stream({
            model: "test/model",
            messages: [
                {
                    role: "assistant",
                    content: [{ type: "thinking", text: "check", signature }],
                    source: {
                        provider: "openrouter",
                        api: "openrouter-chat",
                        model: "test/model",
                    },
                    usage: {
                        inputTokens: 0,
                        outputTokens: 0,
                        cachedInputTokens: 0,
                        reasoningTokens: 0,
                        totalTokens: 0,
                    },
                    stopReason: "stop",
                },
            ],
        });

        for await (const _event of stream) {
            // Drain the stream.
        }
        expect((await stream.result()).stopReason).toBe("stop");
    });
});

async function* chunks<T>(values: readonly T[]): AsyncIterable<T> {
    for (const value of values) {
        yield value;
    }
}

interface ChatChunkOptions {
    readonly delta: ChatStreamDelta;
    readonly finishReason?: ChatFinishReasonEnum | null;
    readonly model?: string;
    readonly usage?: ChatUsage;
}

function chatChunk(options: ChatChunkOptions): ChatStreamChunk {
    return {
        id: "chunk_test",
        created: 0,
        model: options.model ?? "test/model",
        object: "chat.completion.chunk",
        choices: [
            {
                index: 0,
                delta: options.delta,
                finishReason: options.finishReason ?? null,
            },
        ],
        ...(options.usage === undefined ? {} : { usage: options.usage }),
    };
}
