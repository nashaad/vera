import { expect, test } from "bun:test";

import {
    emptyModelPresetSlots,
    modelPresetLabel,
    modelPresetSlotsForDisk,
    nextModelPresetSlot,
    parseModelPresetSlots,
    withModelPresetSlot,
    type ModelPreset,
} from "../../clients/tui/model-presets.ts";

const FAST: ModelPreset = {
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    reasoningEffort: "low",
};

const DEEP: ModelPreset = {
    provider: "openrouter",
    model: "z-ai/glm-5.2",
    reasoningEffort: "max",
};

test("slots keep their numbers when saved, overwritten, and cleared", () => {
    const empty = emptyModelPresetSlots();
    expect(empty).toEqual([null, null, null, null]);

    const saved = withModelPresetSlot(empty, 2, FAST);
    expect(saved).toEqual([null, null, FAST, null]);

    // Clearing slot 2 must not renumber slot 3 down into its place.
    const both = withModelPresetSlot(saved, 3, DEEP);
    expect(withModelPresetSlot(both, 2, null)).toEqual([null, null, null, DEEP]);

    expect(withModelPresetSlot(saved, 2, DEEP)).toEqual([null, null, DEEP, null]);
});

test("cycling steps to the next filled slot and wraps past the end", () => {
    const slots = [FAST, null, DEEP, null];

    expect(nextModelPresetSlot(slots, FAST)).toBe(2);
    expect(nextModelPresetSlot(slots, DEEP)).toBe(0);
});

test("cycling starts at the first filled slot when nothing matches", () => {
    const slots = [null, FAST, null, DEEP];

    expect(nextModelPresetSlot(slots, undefined)).toBe(1);
    // Settings reached with /model rather than a preset are not in any slot.
    expect(nextModelPresetSlot(slots, {
        provider: "openrouter",
        model: "deepseek/deepseek-v4-pro",
        reasoningEffort: "high",
    })).toBe(1);
});

test("cycling has nowhere to go with no other preset saved", () => {
    expect(nextModelPresetSlot(emptyModelPresetSlots(), FAST)).toBeUndefined();
    // A lone preset already in use must not re-send itself on every press.
    expect(nextModelPresetSlot([null, FAST, null, null], FAST)).toBeUndefined();
    expect(nextModelPresetSlot([null, FAST, null, null], undefined)).toBe(1);
});

test("a slot reads as its model and effort, without a name of its own", () => {
    expect(modelPresetLabel(FAST)).toBe("kimi-k3 · low");
    expect(modelPresetLabel({
        provider: "ollama",
        model: "qwen3",
        reasoningEffort: "off",
    })).toBe("qwen3 · off");
});

test("presets survive a round trip through the on-disk shape", () => {
    const slots = [FAST, null, DEEP, null];
    const onDisk = modelPresetSlotsForDisk(slots);

    expect(onDisk[0]).toEqual({
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        reasoning_effort: "low",
    });
    expect(parseModelPresetSlots(JSON.parse(JSON.stringify(onDisk))))
        .toEqual(slots);
});

test("unreadable stored slots drop out instead of failing the client", () => {
    expect(parseModelPresetSlots(undefined)).toEqual([null, null, null, null]);
    expect(parseModelPresetSlots("nonsense")).toEqual([null, null, null, null]);
    expect(parseModelPresetSlots([
        { provider: "openrouter", model: "a/b", reasoning_effort: 42 },
        { provider: "", model: "a/b", reasoning_effort: "low" },
        { provider: "openrouter", model: "a/b", reasoning_effort: "high" },
    ])).toEqual([
        null,
        null,
        { provider: "openrouter", model: "a/b", reasoningEffort: "high" },
        null,
    ]);

    // A file holding more slots than the client has is truncated, not trusted.
    expect(parseModelPresetSlots(Array(9).fill({
        provider: "openrouter",
        model: "a/b",
        reasoning_effort: "max",
    }))).toHaveLength(4);
});
