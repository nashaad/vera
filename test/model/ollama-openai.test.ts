import { expect, test } from "bun:test";

import { createOllamaAdapter } from "../../src/providers/ollama-openai.ts";

test("Ollama compatibility streams text through Vera's model adapter", async () => {
    let request: Request | undefined;
    const adapter = createOllamaAdapter({
        host: "127.0.0.1:11434/",
        fetch: async (input, init) => {
            request = input instanceof Request
                ? new Request(input, init)
                : new Request(String(input), init);
            const source = [
                'data: {"model":"gemma4:26b","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
                "",
                'data: {"model":"gemma4:26b","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2,"total_tokens":6}}',
                "",
                "data: [DONE]",
                "",
            ].join("\r\n");
            const split = source.indexOf("\r\n\r\n") + 1;
            const encoder = new TextEncoder();
            return new Response(new ReadableStream({
                start(controller) {
                    controller.enqueue(encoder.encode(source.slice(0, split)));
                    controller.enqueue(encoder.encode(source.slice(split)));
                    controller.close();
                },
            }), {
                headers: { "content-type": "text/event-stream" },
            });
        },
    });

    const result = await adapter.stream({
        model: "gemma4:26b",
        systemPrompt: "Be concise.",
        reasoningEffort: "off",
        messages: [{
            role: "user",
            content: [{ type: "text", text: "hello" }],
        }],
    }).result();

    expect(request?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(await request?.json()).toMatchObject({
        model: "gemma4:26b",
        stream: true,
        reasoning_effort: "none",
        messages: [
            { role: "system", content: "Be concise." },
            { role: "user", content: "hello" },
        ],
    });
    expect(result).toMatchObject({
        content: [{ type: "text", text: "Hello" }],
        source: {
            provider: "ollama",
            api: "openai-chat-completions",
            model: "gemma4:26b",
        },
        usage: {
            inputTokens: 4,
            outputTokens: 2,
            totalTokens: 6,
        },
        stopReason: "stop",
    });
});

test("Ollama compatibility handles CRLF split across network chunks", async () => {
    const encoder = new TextEncoder();
    const adapter = createOllamaAdapter({
        fetch: async () => new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\r'));
                controller.enqueue(encoder.encode('\n\r\n'));
                controller.enqueue(encoder.encode('data: [DONE]\r\n\r\n'));
                controller.close();
            },
        }), { status: 200 }),
    });
    const stream = adapter.stream({ model: "local", messages: [] });
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events.some((event) =>
        event.type === "text_delta" && event.text === "hi"
    )).toBe(true);
});

test("Ollama compatibility exposes connection and HTTP failures as terminal errors", async () => {
    const adapter = createOllamaAdapter({
        fetch: async () => new Response('{"error":"model not found"}', {
            status: 404,
        }),
    });

    const result = await adapter.stream({
        model: "missing",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("HTTP 404");
});
