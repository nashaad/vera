import { expect, test } from "bun:test";

import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";

test("a named OpenAI endpoint streams reasoning and text", async () => {
    let request: Request | undefined;
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "vera-strata",
        model: "strata",
        approval_mode: "ask",
        providers: {
            "vera-strata": {
                protocol: "openai-chat",
                base_url: "https://strata.example.com/v1",
                credential: "api_key",
                api_key_env: "VERA_STRATA_API_KEY",
            },
        },
    }, {
        env: { VERA_STRATA_API_KEY: "strata-secret" },
        fetch: async (input, init) => {
            request = new Request(String(input), init);
            return new Response([
                'data: {"model":"strata","choices":[{"index":0,"delta":{"reasoning_content":"[graph] complete\\n"},"finish_reason":null}]}',
                "",
                'data: {"model":"strata","choices":[{"index":0,"delta":{"content":"Answer"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
                "",
                "data: [DONE]",
                "",
            ].join("\n"));
        },
    });

    const result = await adapter.stream({
        model: "strata",
        reasoningEffort: "high",
        messages: [{
            role: "user",
            content: [{ type: "text", text: "Audit this." }],
        }],
    }).result();

    expect(request?.url).toBe("https://strata.example.com/v1/chat/completions");
    expect(request?.headers.get("authorization")).toBe("Bearer strata-secret");
    expect(await request?.json()).toMatchObject({
        model: "strata",
        stream: true,
        reasoning_effort: "high",
    });
    expect(result).toMatchObject({
        content: [
            { type: "thinking", text: "[graph] complete\n" },
            { type: "text", text: "Answer" },
        ],
        source: {
            provider: "vera-strata",
            api: "openai-chat-completions",
            model: "strata",
        },
        stopReason: "stop",
    });
});

test("a named endpoint may deliberately require no credential", async () => {
    let authorization: string | null | undefined;
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "local-gateway",
        model: "model",
        approval_mode: "ask",
        providers: {
            "local-gateway": {
                protocol: "openai-chat",
                base_url: "http://127.0.0.1:8790/v1",
                credential: "none",
            },
        },
    }, {
        fetch: async (_input, init) => {
            authorization = new Headers(init?.headers).get("authorization");
            return new Response(
                'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\n',
            );
        },
    });

    expect((await adapter.stream({ model: "model", messages: [] }).result())
        .stopReason).toBe("stop");
    expect(authorization).toBeNull();
});
