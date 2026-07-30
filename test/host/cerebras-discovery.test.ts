import { expect, test } from "bun:test";

import {
    cerebrasModels,
    discoveredCerebrasModels,
} from "../../src/host/runtime.ts";

test("Cerebras discovery maps public capability metadata", () => {
    expect(cerebrasModels({
        data: [{
            id: "gpt-oss-120b",
            name: "OpenAI GPT OSS",
            description: "Fast reasoning model",
            capabilities: { tools: true, reasoning: true },
            limits: { max_context_length: 131_072 },
        }],
    })).toEqual([{
        provider: "cerebras",
        model: "gpt-oss-120b",
        label: "OpenAI GPT OSS",
        description: "Fast reasoning model",
        contextWindow: 131_072,
    }]);
});

test("Cerebras discovery is gated on a usable connection", async () => {
    let fetched = false;
    const models = await discoveredCerebrasModels({
        schema_version: 1,
        provider: "openrouter",
        model: "any/model",
        approval_mode: "ask",
    }, {
        authStorage: { getCredential: () => undefined },
        fetch: async () => {
            fetched = true;
            return new Response('{"data":[]}');
        },
    });

    expect(models).toEqual([]);
    expect(fetched).toBe(false);
});
