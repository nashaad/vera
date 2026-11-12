import { describe, expect, test } from "bun:test";

import type { ModelEntry, ModelSettings } from "../../clients/ui/src/models/settings.ts";
import {
    buildMenuRows,
    effortIndex,
    effortText,
    moveFocus,
    numberKeySlot,
    pickOrder,
    rowSub,
    sliderLevels,
} from "../../clients/ui/src/models/menuRows.ts";

const LEVELS = [
    { id: "low", label: "Low" },
    { id: "medium", label: "Medium" },
    { id: "high", label: "High" },
];

function entry(model: string, overrides: Partial<ModelEntry> = {}): ModelEntry {
    return {
        provider: "acme",
        model,
        label: model,
        onPareto: false,
        verified: true,
        hidden: false,
        recommended: false,
        levels: LEVELS,
        defaultLevel: "medium",
        available: true,
        ...overrides,
    };
}

function settings(shortlist: readonly ModelEntry[], catalog: readonly ModelEntry[]): ModelSettings {
    return { model: "alpha", efforts: [], shortlist, catalog };
}

const alpha = entry("alpha");
const beta = entry("beta");
const gamma = entry("gamma", { available: false });
const delta = entry("delta", { hidden: true });
const outside = entry("outside-one");

describe("buildMenuRows", () => {
    test("lists the shortlist with the current model marked", () => {
        const rows = buildMenuRows(settings([alpha, beta], []), { provider: "acme", model: "beta" }, "");
        expect(rows.shortlist.map((row) => [row.entry.model, row.current])).toEqual([
            ["alpha", false],
            ["beta", true],
        ]);
        expect(rows.running).toBeUndefined();
        expect(rows.browse).toEqual([]);
    });

    test("shows the running model on its own when it is not shortlisted", () => {
        const rows = buildMenuRows(settings([alpha], [outside]), { provider: "acme", model: "outside-one" }, "");
        expect(rows.running?.model).toBe("outside-one");
    });

    test("searching offers catalog matches that are not shortlisted, capped", () => {
        const many = Array.from({ length: 12 }, (_, i) => entry(`match-${i}`));
        const rows = buildMenuRows(settings([alpha], many), undefined, "match");
        expect(rows.searching).toBe(true);
        expect(rows.browse).toHaveLength(8);
        expect(rows.shortlist).toEqual([]);
    });

    test("catalog search leaves out shortlisted and running models", () => {
        const rows = buildMenuRows(settings([alpha], [alpha, entry("alpha-two")]), { provider: "acme", model: "alpha-two" }, "alpha");
        expect(rows.browse).toEqual([]);
        expect(rows.shortlist.map((row) => row.entry.model)).toEqual(["alpha"]);
    });

    test("a plain query hides hidden catalog models only when not searching", () => {
        const plain = buildMenuRows(settings([], [delta]), undefined, "");
        expect(plain.browse).toEqual([]);
        const searched = buildMenuRows(settings([], [delta]), undefined, "delta");
        expect(searched.browse).toEqual([delta]);
    });
});

describe("pickOrder", () => {
    test("runs running, then available shortlist rows, then search matches", () => {
        const rows = buildMenuRows(settings([alpha, gamma], [outside]), { provider: "acme", model: "outside-one" }, "");
        expect(pickOrder(rows).map((row) => row.model)).toEqual(["outside-one", "alpha"]);
    });
});

describe("numberKeySlot", () => {
    test("maps 1 to 4 to shortlist slots while the search is empty", () => {
        expect(numberKeySlot("1", false)).toBe(0);
        expect(numberKeySlot("4", false)).toBe(3);
    });

    test("ignores 5, 0, letters and any digit while searching", () => {
        expect(numberKeySlot("5", false)).toBeUndefined();
        expect(numberKeySlot("0", false)).toBeUndefined();
        expect(numberKeySlot("a", false)).toBeUndefined();
        expect(numberKeySlot("2", true)).toBeUndefined();
    });
});

describe("moveFocus", () => {
    test("starts at the top going down and the bottom going up", () => {
        expect(moveFocus(3, undefined, 1)).toBe(0);
        expect(moveFocus(3, undefined, -1)).toBe(2);
    });

    test("clamps at both ends and handles an empty list", () => {
        expect(moveFocus(3, 2, 1)).toBe(2);
        expect(moveFocus(3, 0, -1)).toBe(0);
        expect(moveFocus(0, undefined, 1)).toBeUndefined();
    });
});

describe("effort helpers", () => {
    test("the slider starts at the chosen level, else the default level", () => {
        expect(effortIndex(alpha, "high")).toBe(2);
        expect(effortIndex(alpha, undefined)).toBe(1);
        expect(effortIndex(alpha, "unknown")).toBe(1);
    });

    test("the slider runs from least to most effort whatever order the host sends", () => {
        const host = [{ id: "high", label: "High" }, { id: "low", label: "Low" }];
        expect(sliderLevels(host).map((level) => level.id)).toEqual(["low", "high"]);
        expect(sliderLevels([{ id: "b", label: "B" }, { id: "a", label: "A" }]).map((level) => level.id)).toEqual(["a", "b"]);
        expect(effortIndex(entry("raven", { levels: host, defaultLevel: "high" }), undefined)).toBe(1);
    });

    test("names the effort from the model's own levels", () => {
        expect(effortText(alpha, undefined)).toBe("Default");
        expect(effortText(alpha, "high")).toBe("High");
        expect(effortText(alpha, "extra_hot")).toBe("Extra hot");
    });

    test("row sub line carries the provider label and the default effort", () => {
        const withLabel = settings([], []);
        expect(rowSub(withLabel, alpha)).toBe("acme · Medium");
        const named = { ...withLabel, providers: [{ id: "acme", label: "Acme AI" }] };
        expect(rowSub(named, alpha)).toBe("Acme AI · Medium");
    });
});
