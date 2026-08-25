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

test("Cerebras omits reasoning controls for models that do not accept them", async () => {
    let body: Record<string, unknown> | undefined;
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "cerebras",
        model: "llama-model",
        approval_mode: "ask",
    }, {
        env: { CEREBRAS_API_KEY: "cerebras-key" },
        fetch: async (_input, init) => {
            body = JSON.parse(String(init?.body));
            return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        },
    });

    await adapter.stream({
        model: "llama-model",
        reasoningEffort: "medium",
        messages: [],
    }).result();

    expect(body).not.toHaveProperty("reasoning_effort");
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

test("DeepSeek shipped data maps every Vera effort to accepted wire values", async () => {
    const seen = new Map<string, unknown>();
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        approval_mode: "ask",
    }, {
        env: { DEEPSEEK_API_KEY: "deepseek-key" },
        fetch: async (_input, init) => {
            const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
            seen.set(String(body.model) + seen.size, body.reasoning_effort);
            return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        },
    });
    const efforts = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

    for (const effort of efforts) {
        await adapter.stream({
            model: "deepseek-v4-pro",
            reasoningEffort: effort,
            messages: [],
        }).result();
    }

    expect([...seen.values()]).toEqual(["high", "high", "high", "high", "max", "max"]);
});
