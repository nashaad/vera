import { expect, test } from "bun:test";

import { OpenRouterAllowanceGuard } from "../../src/providers/openrouter-allowance-guard.ts";

test("prompt evidence expires and never crosses credentials or models", () => {
    let now = 1_000;
    const guard = new OpenRouterAllowanceGuard(() => now, 60_000);
    guard.observe({
        scope: "key-a",
        model: "model-a",
        promptBytes: 4_000,
    }, {
        kind: "prompt_tokens",
        requested: 1_000,
        available: 500,
    });

    expect(guard.preflight({
        scope: "key-a",
        model: "model-a",
        promptBytes: 4_000,
    })?.providerErrorType).toBe("cached_allowance");
    expect(guard.preflight({
        scope: "key-b",
        model: "model-a",
        promptBytes: 4_000,
    })).toBeUndefined();
    expect(guard.preflight({
        scope: "key-a",
        model: "model-b",
        promptBytes: 4_000,
    })).toBeUndefined();

    now += 60_001;
    expect(guard.preflight({
        scope: "key-a",
        model: "model-a",
        promptBytes: 4_000,
    })).toBeUndefined();
});

test("max-token evidence compares the configured output cap directly", () => {
    const guard = new OpenRouterAllowanceGuard();
    guard.observe({
        scope: "key-a",
        model: "model-a",
        promptBytes: 1_000,
        maxTokens: 65_536,
    }, {
        kind: "max_tokens",
        requested: 65_536,
        available: 27_597,
    });

    expect(guard.preflight({
        scope: "key-a",
        model: "model-a",
        promptBytes: 1_000,
        maxTokens: 65_536,
    })?.allowance).toEqual({
        kind: "max_tokens",
        requested: 65_536,
        available: 27_597,
    });
    expect(guard.preflight({
        scope: "key-a",
        model: "model-a",
        promptBytes: 1_000,
        maxTokens: 20_000,
    })).toBeUndefined();
});
