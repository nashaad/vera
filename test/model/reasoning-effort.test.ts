import { expect, test } from "bun:test";

import {
    MODEL_REASONING_PROFILES,
    resolveReasoningSelection,
} from "../../src/model/reasoning-effort.ts";

test("curated reasoning mappings remain exact", async () => {
    expect(await resolveReasoningSelection(
        "openai-codex",
        "gpt-5.6-sol",
        "max",
    )).toEqual({
        requested: "max",
        providerEffort: "xhigh",
        inferred: false,
    });
    expect(await resolveReasoningSelection(
        "openrouter",
        "anthropic/claude-sonnet-5",
        "off",
    )).toEqual({
        requested: "off",
        providerEffort: "none",
        inferred: false,
    });
});

test("OpenRouter reasoning uses exact capability names before rank", async () => {
    expect(await resolveReasoningSelection(
        "openrouter",
        "provider/model",
        "high",
        { supportedEfforts: ["xhigh", "high", "medium", "low"] },
    )).toEqual({
        requested: "high",
        providerEffort: "high",
        inferred: true,
    });
    expect(await resolveReasoningSelection(
        "openrouter",
        "provider/model",
        "max",
        { supportedEfforts: ["xhigh", "high", "medium", "low"] },
    )).toEqual({
        requested: "max",
        providerEffort: "xhigh",
        inferred: true,
    });
});

test("OpenRouter reasoning maps unknown names by relative rank", async () => {
    expect(await resolveReasoningSelection(
        "openrouter",
        "provider/model",
        "medium",
        { supportedEfforts: ["magna", "regular", "small"] },
    )).toEqual({
        requested: "medium",
        providerEffort: "regular",
        inferred: true,
    });
    expect(await resolveReasoningSelection(
        "openrouter",
        "provider/model",
        "high",
        { supportedEfforts: ["magna", "regular", "small"] },
    )).toEqual({
        requested: "high",
        providerEffort: "magna",
        inferred: true,
    });
});

test("OpenRouter reasoning never infers off", async () => {
    await expect(resolveReasoningSelection(
        "openrouter",
        "provider/model",
        "off",
        { supportedEfforts: ["high", "medium", "low"] },
    )).rejects.toThrow("does not explicitly support reasoning off");

    expect(await resolveReasoningSelection(
        "openrouter",
        "provider/model",
        "off",
        { supportedEfforts: ["high", "none"] },
    )).toEqual({
        requested: "off",
        providerEffort: "none",
        inferred: true,
    });
});

test("OpenRouter reasoning reads model capability metadata", async () => {
    const fetchRequest = async () => new Response(
        JSON.stringify({
            data: [{
                id: "provider/model",
                reasoning: { supported_efforts: ["magna", "regular", "small"] },
            }],
        }),
        { status: 200 },
    );

    expect(await resolveReasoningSelection(
        "openrouter",
        "provider/model",
        "max",
        { fetch: fetchRequest },
    )).toEqual({
        requested: "max",
        providerEffort: "magna",
        inferred: true,
    });
});

test("OpenRouter reasoning rejects models without capability metadata", async () => {
    const fetchRequest = async () => new Response(
        JSON.stringify({ data: [{ id: "provider/model" }] }),
        { status: 200 },
    );

    await expect(resolveReasoningSelection(
        "openrouter",
        "provider/model",
        "high",
        { fetch: fetchRequest },
    )).rejects.toThrow("does not expose reasoning effort metadata");
});

test("reasoning profiles stay limited to intentionally supported models", async () => {
    expect(MODEL_REASONING_PROFILES.map((profile) => (
        `${profile.provider}:${profile.model}`
    ))).toEqual([
        "openai-codex:gpt-5.6-sol",
        "openrouter:anthropic/claude-sonnet-5",
    ]);

    await expect(resolveReasoningSelection(
        "openai-codex",
        "unmapped-model",
        "medium",
    )).rejects.toThrow("No reasoning effort mapping");
});
