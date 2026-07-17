import { describe, expect, test } from "bun:test";
import type {
    ChatFinishReasonEnum,
    ChatStreamChunk,
    ChatStreamDelta,
    ChatUsage,
} from "@openrouter/sdk/models";
import { ConnectionError } from "@openrouter/sdk/models/errors";

import {
    OpenRouterAdapter,
    type SendOpenRouterChat,
} from "../../src/providers/openrouter.ts";
import { ProviderFailureError } from "../../src/model/provider-failure.ts";
import { normalizeOpenRouterToolCallId } from "../../src/providers/openrouter-wire.ts";
import type { ModelStreamEvent } from "../../src/model/types.ts";

describe("OpenRouter adapter", () => {
    test("normalizes tool call characters without truncating IDs", () => {
        const id = `call:${"a".repeat(80)}`;

        expect(normalizeOpenRouterToolCallId(id)).toBe(`call_${"a".repeat(80)}`);
    });

    test("normalizes a stream and returns the completed assistant message", async () => {
        const sendChat: SendOpenRouterChat = async (request) => {
            expect(request.reasoning).toEqual({ effort: "none" });
            expect(request.messages).toEqual([
                { role: "system", content: "Be concise." },
                { role: "user", content: "hello" },
            ]);
            expect(request.tools).toEqual([
                {
                    type: "function",
                    function: {
                        name: "bash",
                        description: "Run a command.",
                        parameters: {
                            type: "object",
                            properties: { command: { type: "string" } },
                        },
                    },
                },
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
            model: "anthropic/claude-sonnet-5",
            reasoningEffort: "off",
            systemPrompt: "Be concise.",
            messages: [
                {
                    role: "user",
                    content: [{ type: "text", text: "hello" }],
                },
            ],
            tools: [
                {
                    name: "bash",
                    description: "Run a command.",
                    inputSchema: {
                        type: "object",
                        properties: { command: { type: "string" } },
                    },
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
                model: "anthropic/claude-sonnet-5",
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

    test("omits responseModel when the provider returns the requested model", async () => {
        const sendChat: SendOpenRouterChat = async (request) => {
            expect(request.tools).toBeUndefined();
            return chunks([
                chatChunk({ model: "test/model", delta: {}, finishReason: "stop" }),
            ]);
        };
        const adapter = new OpenRouterAdapter(sendChat);
        const stream = adapter.stream({
            model: "test/model",
            messages: [],
            tools: [],
        });

        for await (const _event of stream) {
            // Drain the stream.
        }

        expect((await stream.result()).source).toEqual({
            provider: "openrouter",
            api: "openrouter-chat",
            model: "test/model",
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

    test("retries a transient failure before the stream starts", async () => {
        let attempts = 0;
        const delays: number[] = [];
        const adapter = new OpenRouterAdapter(
            async () => {
                attempts += 1;
                if (attempts === 1) {
                    throw new ConnectionError("disconnected");
                }
                return chunks([chatChunk({ delta: {}, finishReason: "stop" })]);
            },
            {
                waitForRetry: async (delayMs) => {
                    delays.push(delayMs);
                },
            },
        );
        const stream = adapter.stream({
            model: "test/model",
            messages: [],
        });

        const events: ModelStreamEvent[] = [];
        for await (const event of stream) {
            events.push(event);
        }

        expect(events.map((event) => event.type)).toEqual(["start", "done"]);
        expect((await stream.result()).stopReason).toBe("stop");
        expect(attempts).toBe(2);
        expect(delays).toEqual([500]);
    });

    test("returns an error after exhausting transient retries", async () => {
        let attempts = 0;
        const delays: number[] = [];
        const adapter = new OpenRouterAdapter(
            async () => {
                attempts += 1;
                throw new ConnectionError(`disconnected ${attempts}`);
            },
            {
                waitForRetry: async (delayMs) => {
                    delays.push(delayMs);
                },
            },
        );
        const stream = adapter.stream({
            model: "test/model",
            messages: [],
        });

        const events: ModelStreamEvent[] = [];
        for await (const event of stream) {
            events.push(event);
        }

        expect(events.map((event) => event.type)).toEqual(["start", "error"]);
        const errorEvent = events.at(-1);
        expect(errorEvent?.type).toBe("error");
        if (errorEvent?.type === "error") {
            expect(errorEvent.error).toBeInstanceOf(ProviderFailureError);
            expect(errorEvent.error).toMatchObject({
                failure: {
                    kind: "connection",
                    resolution: "retry",
                },
            });
        }
        expect(await stream.result()).toMatchObject({
            stopReason: "error",
            errorMessage: "disconnected 3",
        });
        expect(attempts).toBe(3);
        expect(delays).toEqual([500, 1000]);
    });

    test("does not retry a transient failure after receiving partial content", async () => {
        let attempts = 0;
        const adapter = new OpenRouterAdapter(
            async () => {
                attempts += 1;
                return partialThenError();
            },
            {
                waitForRetry: async () => {
                    throw new Error("wait should not be called");
                },
            },
        );
        const stream = adapter.stream({
            model: "test/model",
            messages: [],
        });

        const events: ModelStreamEvent[] = [];
        for await (const event of stream) {
            events.push(event);
        }

        expect(events.map((event) => event.type)).toEqual([
            "start",
            "text_start",
            "text_delta",
            "error",
        ]);
        expect(await stream.result()).toMatchObject({
            content: [{ type: "text", text: "partial" }],
            stopReason: "error",
            errorMessage: "stream disconnected",
        });
        expect(attempts).toBe(1);
    });

    test("does not retry when aborted during backoff", async () => {
        let attempts = 0;
        const controller = new AbortController();
        const adapter = new OpenRouterAdapter(
            async () => {
                attempts += 1;
                throw new ConnectionError("disconnected");
            },
            {
                waitForRetry: async () => {
                    controller.abort(new Error("stop now"));
                },
            },
        );
        const stream = adapter.stream({
            model: "test/model",
            messages: [],
            signal: controller.signal,
        });

        for await (const _event of stream) {
            // Drain the stream.
        }

        expect(await stream.result()).toMatchObject({
            stopReason: "aborted",
            errorMessage: "stop now",
        });
        expect(attempts).toBe(1);
    });

    test("returns partial content as an error when the stream ends without a finish reason", async () => {
        const adapter = new OpenRouterAdapter(async () => {
            return chunks([chatChunk({ delta: { content: "partial" } })]);
        });
        const stream = adapter.stream({
            model: "test/model",
            messages: [],
        });

        const events: ModelStreamEvent[] = [];
        for await (const event of stream) {
            events.push(event);
        }

        expect(events.map((event) => event.type)).toEqual([
            "start",
            "text_start",
            "text_delta",
            "error",
        ]);
        expect(await stream.result()).toMatchObject({
            content: [{ type: "text", text: "partial" }],
            stopReason: "error",
            errorMessage: "OpenRouter stream ended without finish_reason",
        });
    });

    test("returns partial content as an error for an unknown finish reason", async () => {
        const adapter = new OpenRouterAdapter(async () => {
            return chunks([
                chatChunk({ delta: { content: "partial" } }),
                chatChunk({
                    delta: {},
                    finishReason: "vendor_reason" as ChatFinishReasonEnum,
                }),
            ]);
        });
        const stream = adapter.stream({
            model: "test/model",
            messages: [],
        });

        const events: ModelStreamEvent[] = [];
        for await (const event of stream) {
            events.push(event);
        }

        expect(events.map((event) => event.type)).toEqual([
            "start",
            "text_start",
            "text_delta",
            "error",
        ]);
        expect(await stream.result()).toMatchObject({
            content: [{ type: "text", text: "partial" }],
            stopReason: "error",
            errorMessage: "OpenRouter returned unknown finish_reason: vendor_reason",
        });
    });

    test("completes normally after a stop finish reason", async () => {
        const adapter = new OpenRouterAdapter(async () => {
            return chunks([
                chatChunk({ delta: { content: "complete" } }),
                chatChunk({ delta: {}, finishReason: "stop" }),
            ]);
        });
        const stream = adapter.stream({
            model: "test/model",
            messages: [],
        });

        const events: ModelStreamEvent[] = [];
        for await (const event of stream) {
            events.push(event);
        }

        expect(events.map((event) => event.type)).toEqual([
            "start",
            "text_start",
            "text_delta",
            "text_end",
            "done",
        ]);
        expect(await stream.result()).toMatchObject({
            content: [{ type: "text", text: "complete" }],
            stopReason: "stop",
        });
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

async function* partialThenError(): AsyncIterable<ChatStreamChunk> {
    yield chatChunk({ delta: { content: "partial" } });
    throw new ConnectionError("stream disconnected");
}
