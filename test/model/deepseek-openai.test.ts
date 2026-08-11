import { expect, test } from "bun:test";

import { createDeepSeekAdapter } from "../../src/providers/deepseek-openai.ts";

test("DeepSeek streams native thinking, text, and tool calls", async () => {
    let request: Request | undefined;
    const adapter = createDeepSeekAdapter({
        apiKey: "sk-deepseek-test",
        fetch: async (input, init) => {
            request = new Request(String(input), init);
            const source = [
                'data: {"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"reasoning_content":"Think."},"finish_reason":null}]}',
                "",
                'data: {"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}',
                "",
                'data: {"model":"deepseek-v4-pro","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}',
                "",
                "data: [DONE]",
                "",
            ].join("\n");
            return new Response(source, {
                headers: { "content-type": "text/event-stream" },
            });
        },
    });

    const result = await adapter.stream({
        model: "deepseek-v4-pro",
        reasoningEffort: "max",
        maxTokens: 1_000,
        messages: [{
            role: "user",
            content: [{ type: "text", text: "Read the file." }],
        }],
        tools: [{
            name: "read_file",
            description: "Read a file",
            inputSchema: {
                type: "object",
                properties: { path: { type: "string" } },
                required: ["path"],
            },
        }],
    }).result();

    expect(request?.url).toBe("https://api.deepseek.com/chat/completions");
    expect(request?.headers.get("authorization")).toBe(
        "Bearer sk-deepseek-test",
    );
    expect(await request?.json()).toMatchObject({
        model: "deepseek-v4-pro",
        stream: true,
        max_tokens: 1_000,
        thinking: { type: "enabled" },
        reasoning_effort: "max",
    });
    expect(result).toMatchObject({
        content: [
            { type: "thinking", text: "Think." },
            {
                type: "tool_call",
                id: "call_1",
                name: "read_file",
                input: { path: "README.md" },
            },
        ],
        source: {
            provider: "deepseek",
            api: "openai-chat-completions",
            model: "deepseek-v4-pro",
        },
        stopReason: "tool_use",
    });
});

test("DeepSeek off explicitly disables native thinking", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = createDeepSeekAdapter({
        apiKey: "sk-test",
        fetch: async (_input, init) => {
            body = JSON.parse(String(init?.body));
            return new Response(
                'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'
                    + "data: [DONE]\n\n",
            );
        },
    });

    await adapter.stream({
        model: "deepseek-v4-flash",
        reasoningEffort: "off",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }).result();

    expect(body).toMatchObject({ thinking: { type: "disabled" } });
    expect(body).not.toHaveProperty("reasoning_effort");
});

test("DeepSeek sends prior thinking as reasoning_content", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = createDeepSeekAdapter({
        apiKey: "sk-test",
        fetch: async (_input, init) => {
            body = JSON.parse(String(init?.body));
            return new Response(
                'data: {"choices":[{"delta":{"content":"done"},"finish_reason":"stop"}]}\n\n'
                    + "data: [DONE]\n\n",
            );
        },
    });

    await adapter.stream({
        model: "deepseek-v4-pro",
        messages: [{
            role: "assistant",
            content: [{ type: "thinking", text: "Think first." }],
            source: {
                provider: "deepseek",
                api: "openai-chat-completions",
                model: "deepseek-v4-pro",
            },
            usage: {
                inputTokens: 0,
                outputTokens: 0,
                cachedInputTokens: 0,
                reasoningTokens: 0,
                totalTokens: 0,
            },
            stopReason: "tool_use",
        }],
    }).result();

    const messages = body?.messages as readonly Record<string, unknown>[];
    expect(messages[0]).toMatchObject({ reasoning_content: "Think first." });
    expect(messages[0]).not.toHaveProperty("reasoning");
});

test("DeepSeek HTTP failures become terminal model errors", async () => {
    const adapter = createDeepSeekAdapter({
        apiKey: "bad",
        fetch: async () => new Response('{"message":"invalid key"}', {
            status: 401,
        }),
    });

    const result = await adapter.stream({
        model: "deepseek-v4-pro",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("DeepSeek returned HTTP 401");
});

test("DeepSeek tolerates a null usage field on a stream chunk", async () => {
    const adapter = createDeepSeekAdapter({
        apiKey: "sk-deepseek-test",
        fetch: async () => {
            const source = [
                'data: {"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}],"usage":null}',
                "",
                'data: {"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":null}',
                "",
                "data: [DONE]",
                "",
            ].join("\n");
            return new Response(source, {
                headers: { "content-type": "text/event-stream" },
            });
        },
    });

    const result = await adapter.stream({
        model: "deepseek-v4-flash",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }).result();

    expect(result.stopReason).toBe("stop");
    expect(result.content).toMatchObject([{ type: "text", text: "hi" }]);
});
