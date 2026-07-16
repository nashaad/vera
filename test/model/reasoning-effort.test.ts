import { expect, test } from "bun:test";

import {
    MODEL_REASONING_PROFILES,
    providerReasoningEffort,
} from "../../src/model/reasoning-effort.ts";

test("normalized max maps to each supported model's provider value", () => {
    expect(providerReasoningEffort(
        "openai-codex",
        "gpt-5.6-sol",
        "max",
    )).toBe("xhigh");
    expect(providerReasoningEffort(
        "openrouter",
        "anthropic/claude-sonnet-5",
        "max",
    )).toBe("max");
});

test("reasoning profiles stay limited to intentionally supported models", () => {
    expect(MODEL_REASONING_PROFILES.map((profile) => (
        `${profile.provider}:${profile.model}`
    ))).toEqual([
        "openai-codex:gpt-5.6-sol",
        "openrouter:anthropic/claude-sonnet-5",
    ]);

    expect(() => providerReasoningEffort(
        "openrouter",
        "unmapped/model",
        "medium",
    )).toThrow("No reasoning effort mapping for openrouter:unmapped/model");
});
