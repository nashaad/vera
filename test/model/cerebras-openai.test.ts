import { expect, test } from "bun:test";

import { createCerebrasAdapter } from "../../src/providers/cerebras-openai.ts";
import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";
import type { VeraConfig } from "../../src/config.ts";

test("Cerebras streams reasoning, text, and tool calls", async () => {
    let request: Request | undefined;
    const adapter = createCerebrasAdapter({
        apiKey: "csk-test",
        fetch: async (input, init) => {
            request = new Request(String(input), init);
            const source = [
                'data: {"model":"gpt-oss-120b","choices":[{"index":0,"delta":{"reasoning":"Think."},"finish_reason":null}]}',
                "",
                'data: {"model":"gpt-oss-120b","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":"}}]},"finish_reason":null}]}',
                "",
                'data: {"model":"gpt-oss-120b","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"README.md\\"}"}}]},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":4,"total_tokens":13}}',
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
        model: "gpt-oss-120b",
        reasoningEffort: "medium",
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

    expect(request?.url).toBe("https://api.cerebras.ai/v1/chat/completions");
    expect(request?.headers.get("authorization")).toBe("Bearer csk-test");
    expect(await request?.json()).toMatchObject({
        model: "gpt-oss-120b",
        stream: true,
        max_completion_tokens: 1_000,
        reasoning_effort: "medium",
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
            provider: "cerebras",
            api: "openai-chat-completions",
            model: "gpt-oss-120b",
        },
        stopReason: "tool_use",
    });
});

test("Cerebras HTTP failures become terminal model errors", async () => {
    const adapter = createCerebrasAdapter({
        apiKey: "bad",
        fetch: async () => new Response('{"message":"invalid key"}', {
            status: 401,
        }),
    });

    const result = await adapter.stream({
        model: "gpt-oss-120b",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain("Cerebras returned HTTP 401");
});

test("Cerebras sends only reasoning controls supported by the model", async () => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = createCerebrasAdapter({
        apiKey: "csk-test",
        fetch: async (_input, init) => {
            bodies.push(JSON.parse(String(init?.body)));
            return new Response(
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
            );
        },
    });

    await adapter.stream({
        model: "zai-glm-4.7",
        reasoningEffort: "medium",
        messages: [],
    }).result();
    await adapter.stream({
        model: "zai-glm-4.7",
        reasoningEffort: "off",
        messages: [],
    }).result();

    expect(bodies[0]?.reasoning_effort).toBeUndefined();
    expect(bodies[1]?.reasoning_effort).toBe("none");
});

test("malformed Cerebras stream data names Cerebras in the terminal error", async () => {
    const adapter = createCerebrasAdapter({
        apiKey: "csk-test",
        fetch: async () => new Response("data: null\n\n"),
    });

    const result = await adapter.stream({
        model: "gpt-oss-120b",
        messages: [],
    }).result();

    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(
        "Cerebras returned an invalid stream chunk",
    );
});

test("a configured endpoint is where the request goes", async () => {
    let request: Request | undefined;
    const adapter = createConfiguredModelAdapter(
        {
            provider: "cerebras",
            model: "gpt-oss-120b",
            provider_endpoints: { cerebras: "https://eu.cerebras.example/v1" },
        } as unknown as VeraConfig,
        {
            env: { CEREBRAS_API_KEY: "csk-test" },
            fetch: async (input, init) => {
                request = new Request(String(input), init);
                return new Response("data: [DONE]\n\n", {
                    headers: { "content-type": "text/event-stream" },
                });
            },
        },
    );

    await adapter.stream({
        model: "gpt-oss-120b",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }).result();

    expect(request?.url)
        .toBe("https://eu.cerebras.example/v1/chat/completions");
});
