import { expect, test } from "bun:test";

import { ollamaContextWindow } from "../../src/host/runtime.ts";

test("Ollama model metadata exposes its declared context window", () => {
    expect(ollamaContextWindow({
        model_info: {
            "general.architecture": "gemma3",
            "gemma3.context_length": 131_072,
        },
    })).toBe(131_072);
    expect(ollamaContextWindow({ model_info: {} })).toBeUndefined();
    expect(ollamaContextWindow({
        model_info: { "gemma3.context_length": "131072" },
    })).toBeUndefined();
});
