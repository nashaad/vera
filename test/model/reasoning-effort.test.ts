import { expect, test } from "bun:test";

import { resolveReasoningSelection } from "../../src/model/reasoning-effort.ts";

test("a model's own level ids resolve directly, beyond Vera's five-word scale", async () => {
    // gpt-5.6-sol offers six levels on the provider side. "ultra" is not one
    // of Vera's own off/low/medium/high/max words, but it is one of this
    // model's own level ids, so it resolves as an exact match. The level
    // list here stands in for the catalog loader a later slice adds; this
    // is the seam that loader plugs into.
    expect(await resolveReasoningSelection(
        "openai-codex",
        "gpt-5.6-sol",
        "ultra",
        { supportedEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    )).toEqual({
        requested: "ultra",
        providerEffort: "ultra",
        inferred: true,
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
    // "max" is not one of this model's words. It does not get promoted to
    // the model's top level: an unplaceable level settles on a moderate one.
    expect(await resolveReasoningSelection(
        "openrouter",
        "provider/model",
        "max",
        { supportedEfforts: ["xhigh", "high", "medium", "low"] },
    )).toEqual({
        requested: "max",
        providerEffort: "medium",
        inferred: true,
    });
});

test("an unrecognised level falls back to the model's default, then a moderate level", async () => {
    // No vocabulary is shared with the requested word at all ("medium" and
    // "high" mean nothing to this model). Resolution does not rescale one
    // provider's ladder onto another's: it falls back to the model's own
    // default when one is given, and otherwise to the middle of its own
    // ladder, matching the level pane's own pre-highlight rule. It never
    // promotes an unplaceable word to the model's top level.
    expect(await resolveReasoningSelection(
        "openrouter",
        "provider/model",
        "medium",
        { supportedEfforts: ["magna", "regular", "small"], defaultLevel: "regular" },
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
        providerEffort: "regular",
        inferred: true,
    });
});

test("a switch to a model with no overlapping vocabulary resolves rather than throws", async () => {
    // The concrete failure this slice removes: a user on gpt-5.6-sol at
    // "ultra" switches to a model whose levels are ["low", "high"]. "ultra"
    // is not one of this model's levels, and there is no shared word list to
    // rescale it against, so placement settles on a moderate level instead of
    // throwing on a mere model switch. Note it does not land on "high" here:
    // sitting at "ultra" on one model is not a reason to spend the top level
    // on the next one.
    expect(await resolveReasoningSelection(
        "openai-codex",
        "some-other-model",
        "ultra",
        { supportedEfforts: ["high", "low"] },
    )).toEqual({
        requested: "ultra",
        providerEffort: "low",
        inferred: true,
    });
});

test("off is not special-cased: it falls back like any other unmatched word", async () => {
    // Translating Vera's "off" into a provider's literal "none" is the
    // provider adapter's job (Ollama already does this), not the resolver's.
    // A model whose level list happens to contain a literal "none" entry
    // still resolves it by that exact match; a model that does not simply
    // degrades "off" to a moderate level, the same as any other word with no
    // shared vocabulary.
    expect(await resolveReasoningSelection(
        "openrouter",
        "provider/model",
        "off",
        { supportedEfforts: ["high", "medium", "low"] },
    )).toEqual({
        requested: "off",
        providerEffort: "medium",
        inferred: true,
    });

    expect(await resolveReasoningSelection(
        "openrouter",
        "provider/model",
        "off",
        { supportedEfforts: ["off", "high"] },
    )).toEqual({
        requested: "off",
        providerEffort: "off",
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
        providerEffort: "regular",
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

test("an unmapped model runs with no level specified instead of throwing", async () => {
    expect(await resolveReasoningSelection(
        "openai-codex",
        "unmapped-model",
        "medium",
    )).toEqual({
        requested: "medium",
        inferred: false,
    });
});
