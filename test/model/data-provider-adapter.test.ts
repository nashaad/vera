import { expect, test } from "bun:test";

import { createConfiguredModelAdapter } from "../../src/providers/configured.ts";

test("Cerebras shipped data selects named completion and effort layers", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "cerebras",
        model: "gpt-oss-120b",
        approval_mode: "ask",
    }, {
        env: { CEREBRAS_API_KEY: "cerebras-key" },
        fetch: async (_input, init) => {
            body = JSON.parse(String(init?.body));
            return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        },
    });

    await adapter.stream({
        model: "gpt-oss-120b",
        maxTokens: 100,
        reasoningEffort: "off",
        messages: [],
    }).result();
    expect(body).toMatchObject({
        max_completion_tokens: 100,
        reasoning_effort: "none",
    });
    expect(body).not.toHaveProperty("max_tokens");
});

test("DeepSeek shipped data selects the thinking and reasoning-content layers", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        approval_mode: "ask",
    }, {
        env: { DEEPSEEK_API_KEY: "deepseek-key" },
        fetch: async (_input, init) => {
            body = JSON.parse(String(init?.body));
            return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        },
    });

    await adapter.stream({
        model: "deepseek-v4-pro",
        reasoningEffort: "off",
        messages: [],
    }).result();
    expect(body).toMatchObject({ thinking: { type: "disabled" } });
    expect(body).not.toHaveProperty("reasoning_effort");
});
