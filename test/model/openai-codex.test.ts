import { describe, expect, test } from "bun:test";

import {
    createOpenAICodexAdapter,
    OpenAICodexAdapter,
    type SendOpenAICodexResponse,
} from "../../src/providers/openai-codex.ts";
import type {
    OpenAICodexRequest,
    OpenAICodexStreamEvent,
} from "../../src/providers/openai-codex-wire.ts";
import {
    encodeOpenAICodexInput,
    readOpenAICodexEvents,
} from "../../src/providers/openai-codex-wire.ts";
import { ProviderFailureError } from "../../src/model/provider-failure.ts";
import type { ModelMessage, ModelStreamEvent } from "../../src/model/types.ts";

test("tool result encoding includes only model-facing text", () => {
    expect(encodeOpenAICodexInput([{
        role: "tool_result",
        toolCallId: "call_1",
        toolName: "edit",
        content: [{ type: "text", text: "Applied 1 edit to notes.txt" }],
        isError: false,
    }])).toEqual([{
        type: "function_call_output",
        call_id: "call_1",
        output: "Applied 1 edit to notes.txt",
    }]);
});

describe("OpenAI Codex adapter", () => {
    test("encodes ordered provider-neutral image content", async () => {
        const requests: OpenAICodexRequest[] = [];
        const imageData = Uint8Array.from([1, 2, 3]);
        const adapter = new OpenAICodexAdapter(async (request) => {
            requests.push(request);
            return events([{
                type: "response.completed",
                response: { model: "gpt-5.6-sol", usage: {} },
            }]);
        });
        const stream = adapter.stream({
            model: "gpt-5.6-sol",
            messages: [{
                role: "user",
                content: [
                    { type: "text", text: "What is shown?" },
                    {
                        type: "image",
                        mediaType: "image/png",
                        data: imageData,
                    },
                ],
            }],
        });
        imageData[0] = 9;
        for await (const _event of stream) {
            // Drain the stream.
        }

        expect(requests[0]?.input).toEqual([{
            type: "message",
            role: "user",
            content: [
                { type: "input_text", text: "What is shown?" },
                {
                    type: "input_image",
                    image_url: "data:image/png;base64,AQID",
                    detail: "auto",
                },
            ],
        }]);
    });

    test("streams and replays one tool-using conversation on Responses", async () => {
        const requests: OpenAICodexRequest[] = [];
        const responses: OpenAICodexStreamEvent[][] = [
            [
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { type: "reasoning" },
                },
                {
                    type: "response.reasoning_summary_text.delta",
                    output_index: 0,
                    delta: "Check the directory.",
                },
                {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        type: "reasoning",
                        id: "reasoning-1",
                        encrypted_content: "encrypted-1",
                    },
                },
                {
                    type: "response.output_item.added",
                    output_index: 1,
                    item: { type: "message" },
                },
                {
                    type: "response.output_text.delta",
                    output_index: 1,
                    delta: "I will check.",
                },
                {
                    type: "response.output_item.done",
                    output_index: 1,
                    item: {
                        type: "message",
                        content: [{ type: "output_text", text: "I will check." }],
                    },
                },
                {
                    type: "response.output_item.added",
                    output_index: 2,
                    item: {
                        type: "function_call",
                        call_id: "call-1",
                        name: "bash",
                    },
                },
                {
                    type: "response.function_call_arguments.delta",
                    output_index: 2,
                    delta: '{"command":',
                },
                {
                    type: "response.function_call_arguments.delta",
                    output_index: 2,
                    delta: '"pwd"}',
                },
                {
                    type: "response.output_item.done",
                    output_index: 2,
                    item: {
                        type: "function_call",
                        call_id: "call-1",
                        name: "bash",
                        arguments: '{"command":"pwd"}',
                    },
                },
                {
                    type: "response.completed",
                    response: {
                        model: "gpt-5.6-sol",
                        usage: {
                            input_tokens: 10,
                            output_tokens: 8,
                            total_tokens: 18,
                            input_tokens_details: { cached_tokens: 4 },
                            output_tokens_details: { reasoning_tokens: 3 },
                        },
                    },
                },
            ],
            [
                {
                    type: "response.output_item.added",
                    output_index: 0,
                    item: { type: "message" },
                },
                {
                    type: "response.output_text.delta",
                    output_index: 0,
                    delta: "Done.",
                },
                {
                    type: "response.output_item.done",
                    output_index: 0,
                    item: {
                        type: "message",
                        content: [{ type: "output_text", text: "Done." }],
                    },
                },
                {
                    type: "response.completed",
                    response: {
                        model: "gpt-5.6-sol",
                        usage: { input_tokens: 20, output_tokens: 2 },
                    },
                },
            ],
        ];
        const sendResponse: SendOpenAICodexResponse = async (request) => {
            requests.push(request);
            return events(responses.shift() ?? []);
        };
        const adapter = new OpenAICodexAdapter(sendResponse);
        const initialMessages: ModelMessage[] = [
            { role: "user", content: [{ type: "text", text: "Where am I?" }] },
        ];

        const firstStream = adapter.stream({
            model: "gpt-5.6-sol",
            maxTokens: 64_000,
            reasoningEffort: "off",
            systemPrompt: "Be concise.",
            messages: initialMessages,
            tools: [{
                name: "bash",
                description: "Run a command.",
                inputSchema: {
                    type: "object",
                    properties: { command: { type: "string" } },
                },
            }],
        });
        const firstEvents: ModelStreamEvent[] = [];
        for await (const event of firstStream) {
            firstEvents.push(event);
        }
        const first = await firstStream.result();

        expect(firstEvents.map((event) => event.type)).toEqual([
            "start",
            "thinking_start",
            "thinking_delta",
            "thinking_end",
            "text_start",
            "text_delta",
            "text_end",
            "tool_call_start",
            "tool_call_delta",
            "tool_call_delta",
            "tool_call_end",
            "done",
        ]);
        expect(first.stopReason).toBe("tool_use");
        expect(first.usage).toEqual({
            inputTokens: 10,
            outputTokens: 8,
            cachedInputTokens: 4,
            reasoningTokens: 3,
            totalTokens: 18,
        });
        expect(first.content[2]).toEqual({
            type: "tool_call",
            id: "call-1",
            name: "bash",
            input: { command: "pwd" },
        });

        const secondStream = adapter.stream({
            model: "gpt-5.6-sol",
            messages: [
                ...initialMessages,
                first,
                {
                    role: "tool_result",
                    toolCallId: "call-1",
                    toolName: "bash",
                    content: [{ type: "text", text: "/workspace" }],
                    isError: false,
                },
            ],
        });
        for await (const _event of secondStream) {
            // Drain the stream.
        }

        expect((await secondStream.result()).content).toEqual([
            { type: "text", text: "Done." },
        ]);
        expect(requests[0]).toMatchObject({
            model: "gpt-5.6-sol",
            max_output_tokens: 64_000,
            instructions: "Be concise.",
            // gpt-5.6-sol has no known level list in this slice (the
            // catalog loader is a later slice), so "off" resolves to no
            // level specified rather than a hardcoded "none".
            reasoning: { summary: "auto" },
            input: [{
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Where am I?" }],
            }],
            tools: [{
                type: "function",
                name: "bash",
                description: "Run a command.",
            }],
        });
        expect(requests[0]?.reasoning).toEqual({ summary: "auto" });
        expect(requests[1]?.input).toEqual([
            {
                type: "message",
                role: "user",
                content: [{ type: "input_text", text: "Where am I?" }],
            },
            {
                type: "reasoning",
                id: "reasoning-1",
                encrypted_content: "encrypted-1",
            },
            {
                type: "message",
                role: "assistant",
                content: [{ type: "output_text", text: "I will check." }],
            },
            {
                type: "function_call",
                call_id: "call-1",
                name: "bash",
                arguments: '{"command":"pwd"}',
            },
            {
                type: "function_call_output",
                call_id: "call-1",
                output: "/workspace",
            },
        ]);
    });

    test("keeps separate text items in provider output order", async () => {
        const adapter = new OpenAICodexAdapter(async () => events([
            {
                type: "response.output_item.added",
                output_index: 0,
                item: { type: "message" },
            },
            {
                type: "response.output_text.delta",
                output_index: 0,
                delta: "before",
            },
            {
                type: "response.output_item.done",
                output_index: 0,
                item: { type: "message" },
            },
            {
                type: "response.output_item.added",
                output_index: 1,
                item: {
                    type: "function_call",
                    call_id: "call-1",
                    name: "bash",
                },
            },
            {
                type: "response.output_item.done",
                output_index: 1,
                item: {
                    type: "function_call",
                    call_id: "call-1",
                    name: "bash",
                    arguments: '{}',
                },
            },
            {
                type: "response.output_item.added",
                output_index: 2,
                item: { type: "message" },
            },
            {
                type: "response.output_text.delta",
                output_index: 2,
                delta: "after",
            },
            {
                type: "response.output_item.done",
                output_index: 2,
                item: { type: "message" },
            },
            { type: "response.completed", response: {} },
        ]));
        const stream = adapter.stream({ model: "test", messages: [] });

        for await (const _event of stream) {
            // Drain the stream.
        }

        expect((await stream.result()).content).toEqual([
            { type: "text", text: "before" },
            {
                type: "tool_call",
                id: "call-1",
                name: "bash",
                input: {},
            },
            { type: "text", text: "after" },
        ]);
    });

    test("reads SSE events separated by bare carriage returns", async () => {
        const source = 'data: {"type":"response.created"}\r\rdata: [DONE]\r\r';
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(source));
                controller.close();
            },
        });
        const values: OpenAICodexStreamEvent[] = [];

        for await (const event of readOpenAICodexEvents(body)) {
            values.push(event);
        }

        expect(values).toEqual([{ type: "response.created" }]);
    });

    test("does not call Codex when already aborted", async () => {
        let called = false;
        const adapter = new OpenAICodexAdapter(async () => {
            called = true;
            return events([]);
        });
        const controller = new AbortController();
        controller.abort(new Error("stop"));
        const stream = adapter.stream({
            model: "gpt-5.6-sol",
            messages: [],
            signal: controller.signal,
        });

        for await (const _event of stream) {
            // Drain the stream.
        }

        expect(called).toBe(false);
        expect((await stream.result()).stopReason).toBe("aborted");
    });

    test("classifies a transport failure without choosing retry policy", async () => {
        let attempts = 0;
        const adapter = new OpenAICodexAdapter(async () => {
            attempts += 1;
            throw new TypeError("disconnected");
        });
        const stream = adapter.stream({
            model: "gpt-5.6-sol",
            messages: [],
        });
        const observed: ModelStreamEvent[] = [];

        for await (const event of stream) {
            observed.push(event);
        }

        const error = observed.at(-1);
        expect(error?.type).toBe("error");
        if (error?.type === "error") {
            expect(error.error).toBeInstanceOf(ProviderFailureError);
            expect(error.error).toMatchObject({
                failure: {
                    kind: "connection",
                    resolution: "retry",
                },
            });
        }
        expect(attempts).toBe(1);
    });

    test("classifies HTTP 408 as timeout rather than server overload", async () => {
        const adapter = createOpenAICodexAdapter({
            authStorage: {
                getCredential: () => ({
                    type: "oauth" as const,
                    token: JSON.stringify({
                        schema_version: 1,
                        access_token: "access-token",
                        refresh_token: "refresh-token",
                        expires_at: 60_000,
                    }),
                }),
                setCredential() {},
            },
            now: () => 0,
            fetch: (async () => new Response("request timed out", {
                status: 408,
            })) as unknown as typeof fetch,
        });
        const stream = adapter.stream({
            model: "gpt-5.6-sol",
            messages: [],
        });
        const observed: ModelStreamEvent[] = [];

        for await (const event of stream) {
            observed.push(event);
        }

        const error = observed.at(-1);
        expect(error?.type).toBe("error");
        if (error?.type === "error") {
            expect(error.error).toMatchObject({
                failure: {
                    kind: "timeout",
                    resolution: "retry",
                    statusCode: 408,
                },
            });
        }
    });
});

async function* events(
    values: readonly OpenAICodexStreamEvent[],
): AsyncIterable<OpenAICodexStreamEvent> {
    for (const value of values) {
        yield value;
    }
}
