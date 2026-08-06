import { describe, expect, test } from "bun:test";
import type {
    ChatFinishReasonEnum,
    ChatStreamChunk,
    ChatStreamChunkError,
    ChatStreamDelta,
    ChatUsage,
} from "@openrouter/sdk/models";
import { ConnectionError } from "@openrouter/sdk/models/errors";

import {
    OpenRouterAdapter,
    type SendOpenRouterChat,
} from "../../src/providers/openrouter.ts";
import { ProviderFailureError } from "../../src/model/provider-failure.ts";
import { requestModelWithRecovery } from "../../src/engine/recovery.ts";
import { normalizeOpenRouterToolCallId } from "../../src/providers/openrouter-wire.ts";
import type {
    AssistantMessage,
    ModelStreamEvent,
} from "../../src/model/types.ts";

describe("OpenRouter adapter", () => {
    test("normalizes tool call characters without truncating IDs", () => {
        const id = `call:${"a".repeat(80)}`;

        expect(normalizeOpenRouterToolCallId(id)).toBe(`call_${"a".repeat(80)}`);
    });

    test("encodes ordered provider-neutral image content", async () => {
        const imageData = Uint8Array.from([1, 2, 3]);
        let encoded: unknown;
        const sendChat: SendOpenRouterChat = async (request) => {
            encoded = request.messages;
            return chunks([
                chatChunk({ delta: { content: "ok" }, finishReason: "stop" }),
            ]);
        };
        const adapter = new OpenRouterAdapter(sendChat);

        await adapter.stream({
            model: "test/model",
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: "What is shown?" },
                    { type: "image", mediaType: "image/png", data: imageData },
                ],
            }],
        }).result();

        expect(encoded).toEqual([{
            role: "user",
            content: [
                { type: "text", text: "What is shown?" },
                {
                    type: "image_url",
                    imageUrl: { url: "data:image/png;base64,AQID" },
                },
            ],
        }]);
    });

    test("keeps text-only user messages as a plain string", async () => {
        let encoded: unknown;
        const sendChat: SendOpenRouterChat = async (request) => {
            encoded = request.messages;
            return chunks([
                chatChunk({ delta: { content: "ok" }, finishReason: "stop" }),
            ]);
        };
        const adapter = new OpenRouterAdapter(sendChat);

        await adapter.stream({
            model: "test/model",
            messages: [{
                role: "user",
                content: [{ type: "text", text: "hello" }],
            }],
        }).result();

        expect(encoded).toEqual([{ role: "user", content: "hello" }]);
    });

    test("reports image input as supported", () => {
        const adapter = new OpenRouterAdapter(async () => chunks([]));

        expect(adapter.supportsImageInput).toBe(true);
    });

    test("uses supplied verification mappings instead of the installed catalog", async () => {
        const sendChat: SendOpenRouterChat = async (request) => {
            expect(request.reasoning).toEqual({ effort: "candidate-effort" });
            return chunks([
                chatChunk({ delta: { content: "ok" }, finishReason: "stop" }),
            ]);
        };
        const adapter = new OpenRouterAdapter(sendChat, new Map([
            ["test/model", new Map([["high", "candidate-effort"]])],
        ]));

        const result = await adapter.stream({
            model: "test/model",
            reasoningEffort: "high",
            messages: [{
                role: "user",
                content: [{ type: "text", text: "hello" }],
            }],
        }).result();

        expect(result.stopReason).toBe("stop");
    });

    test("normalizes a stream and returns the completed assistant message", async () => {
        const sendChat: SendOpenRouterChat = async (request) => {
            expect(request.maxTokens).toBe(64_000);
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
        // anthropic/claude-sonnet-5 has no verified catalog entry in this
        // test environment, so off->none is supplied directly rather than
        // resolved through a live OpenRouter discovery fetch.
        const adapter = new OpenRouterAdapter(sendChat, new Map([
            ["anthropic/claude-sonnet-5", new Map([["off", "none"]])],
        ]));
        const stream = adapter.stream({
            model: "anthropic/claude-sonnet-5",
            maxTokens: 64_000,
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

    test("classifies a transient failure without choosing retry policy", async () => {
        let attempts = 0;
        const adapter = new OpenRouterAdapter(async () => {
            attempts += 1;
            throw new ConnectionError(`disconnected ${attempts}`);
        });
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
            errorMessage: "disconnected 1",
        });
        expect(attempts).toBe(1);
    });

    test("does not retry a transient failure after receiving partial content", async () => {
        let attempts = 0;
        const adapter = new OpenRouterAdapter(async () => {
            attempts += 1;
            return partialThenError();
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
            errorMessage: "stream disconnected",
        });
        expect(attempts).toBe(1);
    });

    test("a stream that ends without a finish reason still stops normally", async () => {
        const adapter = new OpenRouterAdapter(async () => {
            return chunks([chatChunk({ delta: { content: "answer" } })]);
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
            content: [{ type: "text", text: "answer" }],
            stopReason: "stop",
        });
    });

    test("a stream that ends on tool calls without a finish reason stops for tool use", async () => {
        const adapter = new OpenRouterAdapter(async () => {
            return chunks([chatChunk({
                delta: {
                    toolCalls: [{
                        index: 0,
                        id: "call-1",
                        function: { name: "read", arguments: "{}" },
                    }],
                },
            })]);
        });
        const stream = adapter.stream({
            model: "test/model",
            messages: [],
        });

        for await (const _event of stream) {
            // Drained so the decoder reaches its finish path.
        }

        expect(await stream.result()).toMatchObject({
            content: [{ type: "tool_call", name: "read" }],
            stopReason: "tool_use",
        });
    });

    test("an unknown finish reason falls back to the content instead of failing", async () => {
        const adapter = new OpenRouterAdapter(async () => {
            return chunks([
                chatChunk({ delta: { content: "answer" } }),
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

        expect(events.map((event) => event.type)).not.toContain("error");
        expect(await stream.result()).toMatchObject({
            content: [{ type: "text", text: "answer" }],
            stopReason: "stop",
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
                reasoningDetails: JSON.parse(signature),
            });
            expect(request.messages[0]).not.toHaveProperty("reasoning");
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

    test("coalesces streamed fragments before replaying signed reasoning", async () => {
        let requestNumber = 0;
        let firstMessage: AssistantMessage | undefined;
        const adapter = new OpenRouterAdapter(async (request) => {
            requestNumber += 1;
            if (requestNumber === 2) {
                expect(request.messages[1]).toMatchObject({
                    role: "assistant",
                    reasoningDetails: [{
                        type: "reasoning.text",
                        index: 0,
                        format: "anthropic-claude-v1",
                        text: "check",
                        signature: "signed-check",
                    }],
                });
                return chunks([chatChunk({ delta: {}, finishReason: "stop" })]);
            }
            return chunks([
                chatChunk({
                    delta: {
                        reasoning: "check",
                        reasoningDetails: [{
                            type: "reasoning.text",
                            index: 0,
                            format: "anthropic-claude-v1",
                            text: "ch",
                        }],
                    },
                }),
                chatChunk({
                    delta: {
                        reasoningDetails: [{
                            type: "reasoning.text",
                            index: 0,
                            format: "anthropic-claude-v1",
                            text: "eck",
                        }],
                    },
                }),
                chatChunk({
                    delta: {
                        reasoningDetails: [{
                            type: "reasoning.text",
                            index: 0,
                            format: "anthropic-claude-v1",
                            signature: "signed-check",
                        }],
                        toolCalls: [{
                            index: 0,
                            id: "call_1",
                            function: { name: "echo", arguments: '{"value":"ok"}' },
                        }],
                    },
                    finishReason: "tool_calls",
                }),
            ]);
        });
        const first = adapter.stream({
            model: "test/model",
            messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
            tools: [{
                name: "echo",
                description: "Echo a value.",
                inputSchema: { type: "object" },
            }],
        });
        for await (const _event of first) {
            // Drain the stream.
        }
        firstMessage = await first.result();
        const toolCall = firstMessage.content.find((block) => block.type === "tool_call");
        expect(toolCall?.type).toBe("tool_call");
        if (toolCall?.type !== "tool_call") {
            throw new Error("Expected a tool call");
        }

        const second = adapter.stream({
            model: "test/model",
            messages: [
                { role: "user", content: [{ type: "text", text: "go" }] },
                firstMessage,
                {
                    role: "tool_result",
                    toolCallId: toolCall.id,
                    toolName: toolCall.name,
                    content: [{ type: "text", text: "ok" }],
                    isError: false,
                },
            ],
        });
        for await (const _event of second) {
            // Drain the stream.
        }
        expect((await second.result()).stopReason).toBe("stop");
    });

    test("preserves structured errors delivered inside a stream", async () => {
        const adapter = new OpenRouterAdapter(async () => chunks([
            chatChunk({
                delta: {},
                error: {
                    code: 503,
                    message: "Provider returned error",
                    metadata: {
                        errorType: "provider_unavailable",
                        providerCode: "overloaded_error",
                    },
                },
            }),
        ]));
        const stream = adapter.stream({ model: "test/model", messages: [] });
        const events: ModelStreamEvent[] = [];
        for await (const event of stream) {
            events.push(event);
        }

        const error = events.at(-1);
        expect(error?.type).toBe("error");
        if (error?.type === "error") {
            expect(error.error).toBeInstanceOf(ProviderFailureError);
            expect(error.error).toMatchObject({
                failure: {
                    kind: "server",
                    resolution: "retry",
                    statusCode: 503,
                    providerErrorType: "provider_unavailable",
                    providerCode: "overloaded_error",
                },
            });
        }
        expect(await stream.result()).toMatchObject({
            stopReason: "error",
            errorMessage: "Provider returned error "
                + "(provider_unavailable, code 503, provider overloaded_error)",
        });
    });

    test("retries when signed metadata arrives before a retryable error", async () => {
        let attempts = 0;
        const adapter = new OpenRouterAdapter(async () => {
            attempts += 1;
            return attempts === 1
                ? chunks([
                    chatChunk({
                        delta: {
                            reasoningDetails: [{
                                type: "reasoning.encrypted",
                                data: "signed",
                            }],
                        },
                    }),
                    chatChunk({
                        delta: {},
                        error: {
                            code: 503,
                            message: "temporarily unavailable",
                            metadata: {
                                errorType: "provider_unavailable",
                            },
                        },
                    }),
                ])
                : chunks([chatChunk({ delta: {}, finishReason: "stop" })]);
        });
        const observed: string[] = [];
        const result = await requestModelWithRecovery(
            adapter,
            { provider: "openrouter", model: "test/model", messages: [] },
            {
                policy: { delaysMs: [0] },
                wait: async () => undefined,
                onEvent: (event) => observed.push(event.type),
                onRetry: () => observed.push("retry"),
                onFallback: () => undefined,
            },
        );

        expect(attempts).toBe(2);
        expect(observed).toEqual(["start", "retry", "done"]);
        expect(result.stopReason).toBe("stop");
    });
});

async function* chunks<T>(values: readonly T[]): AsyncIterable<T> {
    for (const value of values) {
        yield value;
    }
}

interface ChatChunkOptions {
    readonly delta: ChatStreamDelta;
    readonly error?: ChatStreamChunkError;
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
        ...(options.error === undefined ? {} : { error: options.error }),
        ...(options.usage === undefined ? {} : { usage: options.usage }),
    };
}

async function* partialThenError(): AsyncIterable<ChatStreamChunk> {
    yield chatChunk({ delta: { content: "partial" } });
    throw new ConnectionError("stream disconnected");
}
