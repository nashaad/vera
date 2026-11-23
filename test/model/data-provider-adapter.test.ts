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

test("@core DeepSeek generic adapter sends native thinking for each effort", async () => {
    const bodies: Record<string, unknown>[] = [];
    const adapter = createConfiguredModelAdapter({
        schema_version: 1,
        provider: "deepseek",
        model: "deepseek-v4-pro",
        approval_mode: "ask",
    }, {
        env: { DEEPSEEK_API_KEY: "deepseek-key" },
        imageSupport: () => false,
        fetch: async (_input, init) => {
            bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            return new Response('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n');
        },
    });
    const efforts = [
        { id: "minimal", wire: "high" },
        { id: "low", wire: "high" },
        { id: "medium", wire: "high" },
        { id: "high", wire: "high" },
        { id: "xhigh", wire: "max" },
        { id: "max", wire: "max" },
        { id: "off", wire: undefined },
    ] as const;

    for (const model of ["deepseek-v4-pro", "deepseek-flash"]) {
        for (const effort of efforts) {
            const result = await adapter.stream({
                model,
                reasoningEffort: effort.id,
                messages: [],
            }).result();
            expect(result.stopReason).toBe("stop");
            const body = bodies.at(-1);
            expect(body).toMatchObject({
                model,
                thinking: { type: effort.id === "off" ? "disabled" : "enabled" },
            });
            if (effort.wire === undefined) {
                expect(body).not.toHaveProperty("reasoning_effort");
            } else {
                expect(body).toHaveProperty("reasoning_effort", effort.wire);
            }
        }
    }
    expect(bodies).toHaveLength(14);
});
