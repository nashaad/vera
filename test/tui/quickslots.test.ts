import { expect, test } from "bun:test";

import {
    emptyQuickslots,
    quickslotLabel,
    quickslotsForDisk,
    nextQuickslot,
    parseQuickslots,
    withQuickslot,
    type Quickslot,
} from "../../clients/tui/quickslots.ts";

const FAST: Quickslot = {
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    reasoningEffort: "low",
};

const DEEP: Quickslot = {
    provider: "openrouter",
    model: "z-ai/glm-5.2",
    reasoningEffort: "max",
};

test("slots keep their numbers when saved, overwritten, and cleared", () => {
    const empty = emptyQuickslots();
    expect(empty).toEqual([null, null, null, null]);

    const saved = withQuickslot(empty, 2, FAST);
    expect(saved).toEqual([null, null, FAST, null]);

    // Clearing slot 2 must not renumber slot 3 down into its place.
    const both = withQuickslot(saved, 3, DEEP);
    expect(withQuickslot(both, 2, null)).toEqual([null, null, null, DEEP]);

    expect(withQuickslot(saved, 2, DEEP)).toEqual([null, null, DEEP, null]);
});

test("cycling steps to the next filled slot and wraps past the end", () => {
    const slots = [FAST, null, DEEP, null];

    expect(nextQuickslot(slots, FAST)).toBe(2);
    expect(nextQuickslot(slots, DEEP)).toBe(0);
});

test("cycling starts at the first filled slot when nothing matches", () => {
    const slots = [null, FAST, null, DEEP];

    expect(nextQuickslot(slots, undefined)).toBe(1);
    // Settings reached with /model rather than a quickslot are not in any slot.
    expect(nextQuickslot(slots, {
        provider: "openrouter",
        model: "deepseek/deepseek-v4-pro",
        reasoningEffort: "high",
    })).toBe(1);
});

test("cycling has nowhere to go with no other quickslot saved", () => {
    expect(nextQuickslot(emptyQuickslots(), FAST)).toBeUndefined();
    // A lone quickslot already in use must not re-send itself on every press.
    expect(nextQuickslot([null, FAST, null, null], FAST)).toBeUndefined();
    expect(nextQuickslot([null, FAST, null, null], undefined)).toBe(1);
});

test("a slot reads as its model and effort, without a name of its own", () => {
    expect(quickslotLabel(FAST)).toBe("kimi-k3 · low");
    expect(quickslotLabel({
        provider: "ollama",
        model: "qwen3",
        reasoningEffort: "off",
    })).toBe("qwen3 · off");
});

test("quickslots survive a round trip through the on-disk shape", () => {
    const slots = [FAST, null, DEEP, null];
    const onDisk = quickslotsForDisk(slots);

    expect(onDisk[0]).toEqual({
        provider: "openrouter",
        model: "moonshotai/kimi-k3",
        reasoning_effort: "low",
    });
    expect(parseQuickslots(JSON.parse(JSON.stringify(onDisk))))
        .toEqual(slots);
});

test("unreadable stored slots drop out instead of failing the client", () => {
    expect(parseQuickslots(undefined)).toEqual([null, null, null, null]);
    expect(parseQuickslots("nonsense")).toEqual([null, null, null, null]);
    expect(parseQuickslots([
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
    expect(parseQuickslots(Array(9).fill({
        provider: "openrouter",
        model: "a/b",
        reasoning_effort: "max",
    }))).toHaveLength(4);
});
