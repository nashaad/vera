import { describe, expect, test } from "bun:test";

import {
    allText,
    assignedText,
    changedSlots,
    currentOf,
    leaningJobs,
    ordinal,
    subagentAddedText,
    unreachable,
    unsetChoice,
    usedByText,
} from "../../clients/ui/src/models/browser/defaults.ts";
import { OTHER_LIMIT, pickerRows, startingEffort } from "../../clients/ui/src/models/browser/SlotPicker.tsx";
import type { ModelEntry, ModelSettings } from "../../clients/ui/src/models/settings.ts";
import type { AssignedModel, AssignmentSlot, AssignmentsView } from "../../clients/ui/src/protocol/assignments.ts";

const big: AssignedModel = { provider: "openrouter", model: "big-1", effort: "high" };
const small: AssignedModel = { provider: "openrouter", model: "small-1" };
const name = (model: AssignedModel): string => model.model;

function slot(overrides: Partial<AssignmentSlot> & Pick<AssignmentSlot, "id">): AssignmentSlot {
    return { label: overrides.id, bound: false, declared: [], running: [], source: "session", ...overrides };
}

function view(...slots: AssignmentSlot[]): AssignmentsView {
    const ids = ["snappy", "eco", "extra", "reviewer", "compaction", "subagents"] as const;
    return { ok: true, slots: ids.map((id) => slots.find((entry) => entry.id === id) ?? slot({ id })) };
}

function entry(overrides: Partial<ModelEntry> = {}): ModelEntry {
    return {
        provider: "openrouter",
        model: "big-1",
        label: "Big One",
        onPareto: false,
        verified: true,
        hidden: false,
        recommended: false,
        levels: [],
        available: true,
        ...overrides,
    };
}

function settings(overrides: Partial<ModelSettings> = {}): ModelSettings {
    return { model: "big-1", efforts: [], shortlist: [], catalog: [], ...overrides };
}

describe("Defaults copy", () => {
    test("an unset job leans on its tier and the tier says so", () => {
        const unsetJobs = view(slot({ id: "extra", bound: true, declared: [big], running: [big] }));
        expect(leaningJobs(unsetJobs, "extra")).toEqual(["classifier"]);
        expect(usedByText(unsetJobs, "eco")).toBe("Used by the explorer agent and compaction.");
        expect(usedByText(unsetJobs, "extra")).toBe("Used by classifier.");
        const classifierSet = view(slot({ id: "reviewer", bound: true, declared: [big] }));
        expect(usedByText(classifierSet, "extra")).toBeUndefined();
        expect(usedByText(classifierSet, "snappy")).toBe("Used by titles and recaps.");
    });

    test("the clearing row says what clearing means", () => {
        const tierSet = view(slot({ id: "extra", bound: true, declared: [big], running: [big] }));
        expect(unsetChoice(tierSet, "snappy", name)).toEqual({ label: "Not set", description: "Features that ask for snappy do not run" });
        expect(unsetChoice(tierSet, "reviewer", name)?.description).toBe("Uses Extra, now big-1");
        expect(unsetChoice(tierSet, "compaction", name)?.description).toBe("Uses Eco, which is not set, so the session model");
        expect(unsetChoice(tierSet, "failsafe", name)?.label).toBe("None");
        expect(unsetChoice(tierSet, "subagent", name)).toBeUndefined();
        expect(unsetChoice(tierSet, "all", name)).toBeUndefined();
    });

    test("the failsafe is the classifier's second model", () => {
        const both = view(slot({ id: "reviewer", bound: true, declared: [big, small], running: [big, small] }));
        expect(currentOf(both, "reviewer")).toEqual(big);
        expect(currentOf(both, "failsafe")).toEqual(small);
        expect(currentOf(both, "subagent")).toBeUndefined();
    });

    test("a set model that cannot run is marked", () => {
        expect(unreachable(slot({ id: "eco", bound: true, declared: [big], running: [] }))).toBe(true);
        expect(unreachable(slot({ id: "eco", bound: true, declared: [big], running: [big] }))).toBe(false);
        expect(unreachable(slot({ id: "eco" }))).toBe(false);
    });

    test("toasts name the slot, the model and the order", () => {
        expect(assignedText("eco", big, name, "high effort")).toBe("Eco now uses big-1 at high effort");
        expect(assignedText("reviewer", undefined, name)).toBe("Classifier is not set");
        expect(subagentAddedText(small, 2, name)).toBe("Subagents can now run small-1, second in order");
        expect([1, 3, 4].map(ordinal)).toEqual(["first", "third", "number 4"]);
        expect(allText(0, big, name)).toBe("Every default already uses big-1");
        expect(allText(1, big, name)).toBe("1 default now use big-1");
    });

    test("one model for all counts only the slots it changed", () => {
        const before = view(slot({ id: "eco", bound: true, declared: [small] }), slot({ id: "extra", bound: true, declared: [small] }));
        const after = view(
            ...(["snappy", "eco", "extra", "reviewer", "compaction", "subagents"] as const).map((id) =>
                slot({ id, bound: true, declared: [small] })),
        );
        expect(changedSlots(before, after)).toBe(4);
    });
});

describe("SlotPicker rows", () => {
    test("favorites first, then other connected models, leaving out the excluded and hidden", () => {
        const favorite = entry({ model: "fav-1", label: "Fav" });
        const rows = pickerRows(
            settings({
                shortlist: [favorite, entry({ model: "gone-1", available: false })],
                catalog: [favorite, entry({ model: "other-1" }), entry({ model: "listed-1" }), entry({ model: "hidden-1", hidden: true })],
            }),
            "",
            new Set(["openrouter/listed-1"]),
        );
        expect(rows.favorites.map((row) => row.model)).toEqual(["fav-1"]);
        expect(rows.others.map((row) => row.model)).toEqual(["other-1"]);
        expect(pickerRows(settings({ catalog: [entry({ model: "hidden-1", label: "Hidden" })] }), "hidden", new Set()).others).toHaveLength(1);
    });

    test("a long catalog is capped and the rest is reached by searching", () => {
        const catalog = Array.from({ length: OTHER_LIMIT + 5 }, (_, index) => entry({ model: `m-${index}` }));
        const rows = pickerRows(settings({ catalog }), "", new Set());
        expect(rows.others).toHaveLength(OTHER_LIMIT);
        expect(rows.more).toBe(5);
    });

    test("a pick starts at the slot's effort for its current model, else the model's default", () => {
        const levels = [{ id: "low", label: "Low" }, { id: "high", label: "High" }];
        const model = entry({ levels, defaultLevel: "low" });
        expect(startingEffort(model, big)).toBe("high");
        expect(startingEffort(model, small)).toBe("low");
        expect(startingEffort(entry({ levels: [] }), undefined)).toBeUndefined();
    });
});
