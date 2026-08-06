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

interface CapabilityProbe {
    readonly bodies: () => readonly Record<string, unknown>[];
    readonly shows: () => number;
    readonly fetch: (
        input: string | URL | Request,
        init?: RequestInit,
    ) => Promise<Response>;
}

function stubOllama(show: () => Response | Promise<Response>): CapabilityProbe {
    const bodies: Record<string, unknown>[] = [];
    let shows = 0;
    return {
        bodies: () => bodies,
        shows: () => shows,
        fetch: async (input, init) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url.endsWith("/api/show")) {
                shows += 1;
                return await show();
            }
            bodies.push(JSON.parse(String(init?.body)));
            return new Response(
                'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'
                    + "data: [DONE]\n\n",
                { status: 200 },
            );
        },
    };
}

function capabilities(...values: string[]): Response {
    return Response.json({ capabilities: values });
}

async function send(
    probe: CapabilityProbe,
    model = "granite4.1:8b",
): Promise<void> {
    await createOllamaAdapter({ fetch: probe.fetch }).stream({
        model,
        reasoningEffort: "low",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }).result();
}

test("a model that declares no thinking capability is sent no reasoning effort", async () => {
    const probe = stubOllama(() => capabilities("completion", "tools"));
    await send(probe);
    expect(probe.bodies()[0]).not.toHaveProperty("reasoning_effort");
});

test("a model that declares thinking keeps its reasoning effort", async () => {
    const probe = stubOllama(() => capabilities("completion", "thinking"));
    await send(probe);
    expect(probe.bodies()[0]).toMatchObject({ reasoning_effort: "low" });
});

test("an unavailable capability probe leaves the request unchanged", async () => {
    const missing = stubOllama(() => new Response("", { status: 404 }));
    await send(missing);
    expect(missing.bodies()[0]).toMatchObject({ reasoning_effort: "low" });

    const offline = stubOllama(() => {
        throw new Error("connection refused");
    });
    await send(offline);
    expect(offline.bodies()[0]).toMatchObject({ reasoning_effort: "low" });

    const silent = stubOllama(() => Response.json({ model_info: {} }));
    await send(silent);
    expect(silent.bodies()[0]).toMatchObject({ reasoning_effort: "low" });
});

test("a gated request logs the probe and the dropped effort", async () => {
    const probe = stubOllama(() => capabilities("completion", "tools"));
    const logged: Record<string, unknown>[] = [];
    await createOllamaAdapter({
        fetch: probe.fetch,
        log: (entry) => logged.push(entry),
    }).stream({
        model: "granite4.1:8b",
        reasoningEffort: "low",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }).result();

    expect(logged).toEqual([
        {
            type: "ollama_thinking_probe",
            model: "granite4.1:8b",
            thinking: false,
            capabilities: ["completion", "tools"],
        },
        {
            type: "ollama_reasoning_effort_dropped",
            model: "granite4.1:8b",
            effort: "low",
        },
    ]);
});

test("an unanswered probe is logged as unknown and drops nothing", async () => {
    const probe = stubOllama(() => new Response("", { status: 404 }));
    const logged: Record<string, unknown>[] = [];
    await createOllamaAdapter({
        fetch: probe.fetch,
        log: (entry) => logged.push(entry),
    }).stream({
        model: "granite4.1:8b",
        reasoningEffort: "low",
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    }).result();

    expect(logged).toEqual([{
        type: "ollama_thinking_probe",
        model: "granite4.1:8b",
        thinking: "unknown",
        reason: "HTTP 404",
    }]);
    expect(probe.bodies()[0]).toMatchObject({ reasoning_effort: "low" });
});

test("capabilities are probed once per model for an adapter's lifetime", async () => {
    const probe = stubOllama(() => capabilities("completion"));
    const adapter = createOllamaAdapter({ fetch: probe.fetch });
    const turn = () =>
        adapter.stream({
            model: "granite4.1:8b",
            reasoningEffort: "low",
            messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }).result();
    await turn();
    await turn();

    expect(probe.shows()).toBe(1);
    expect(probe.bodies()).toHaveLength(2);
    expect(probe.bodies()[1]).not.toHaveProperty("reasoning_effort");
});
