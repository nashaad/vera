import { describe, expect, test } from "bun:test";

import type { ModelEntry, ModelSettings } from "../../clients/ui/src/models/settings.ts";
import {
    ANY_PROVIDER,
    cutoffLabel,
    defaultRows,
    entryKey,
    fromProvider,
    modelFacts,
    pickSelection,
    probeLine,
    providerOrder,
} from "../../clients/ui/src/models/browser/rows.ts";

function entry(overrides: Partial<ModelEntry> = {}): ModelEntry {
    return {
        provider: "vera-test",
        model: "fast-one",
        label: "Fast One",
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
    return {
        provider: "vera-test",
        model: "fast-one",
        effort: "high",
        efforts: ["low", "high"],
        shortlist: [],
        catalog: [],
        ...overrides,
    };
}

function value(rows: ReturnType<typeof modelFacts>, label: string): string | undefined {
    return rows.find((row) => row.label === label)?.value;
}

describe("modelFacts", () => {
    test("states the blended price with the 3 to 1 weighting", () => {
        const rows = modelFacts(entry({ pricing: { input: 3, output: 15 } }), false);
        expect(value(rows, "Blended price")).toBe("$6 per M, 3:1 in:out");
        expect(value(rows, "Listed price")).toBe("$3 in, $15 out");
    });

    test("reports a missing price, score and context as not listed", () => {
        const rows = modelFacts(entry(), false);
        expect(value(rows, "Blended price")).toBe("Not listed");
        expect(value(rows, "WA score")).toBe("Not listed");
        expect(value(rows, "Context")).toBe("Not listed");
    });

    test("shows the probe reason when verification failed", () => {
        const rows = modelFacts(entry({ verified: false, verificationError: "model_not_found" }), false);
        expect(value(rows, "Verified")).toBe("model_not_found");
    });

    test("says No for an unverified model with no reason", () => {
        expect(value(modelFacts(entry({ verified: false }), false), "Verified")).toBe("No");
    });

    test("images read yes, no or unknown", () => {
        expect(value(modelFacts(entry({ imageSupport: true }), false), "Images")).toBe("Yes");
        expect(value(modelFacts(entry({ imageSupport: false }), false), "Images")).toBe("No");
        expect(value(modelFacts(entry(), false), "Images")).toBe("Unknown");
    });

    test("front names the score and price reason only when on the front", () => {
        expect(value(modelFacts(entry({ onPareto: true }), false), "Front")).toBe("Yes, best score for its price");
        expect(value(modelFacts(entry(), false), "Front")).toBe("No");
    });

    test("shortlist follows the pinned flag and the model id is provider/model", () => {
        const rows = modelFacts(entry(), true);
        expect(value(rows, "Favorite")).toBe("Yes");
        expect(value(rows, "Model ID")).toBe("vera-test/fast-one");
    });

    test("context is shown in thousands or millions", () => {
        expect(value(modelFacts(entry({ contextWindow: 200_000 }), false), "Context")).toBe("200K");
        expect(value(modelFacts(entry({ contextWindow: 1_000_000 }), false), "Context")).toBe("1M");
    });
});

describe("defaultRows", () => {
    test("new sessions name the model and its effort", () => {
        const rows = defaultRows(settings({ shortlist: [entry({ label: "Fast One" })] }));
        expect(rows[0]?.label).toBe("New sessions");
        expect(rows[0]?.value).toBe("Fast One, High effort");
        expect(rows[0]?.note).toContain("default for new sessions");
    });

    test("subagents inherit, fixed or none", () => {
        const subagent = (subagentDefault: ModelSettings["subagentDefault"]) =>
            defaultRows(settings({ subagentDefault }))[1]?.value;
        expect(subagent({ mode: "inherit" })).toBe("Same as the parent session");
        expect(subagent({ mode: "none" })).toBe("None assigned");
        expect(subagent({ mode: "fixed", choice: { provider: "vera-test", model: "fast-one" } })).toBe("fast-one");
    });

    test("the reviewer is chosen per review or fixed with a fallback", () => {
        const reviewer = (reviewerDefault: ModelSettings["reviewerDefault"]) =>
            defaultRows(settings({ reviewerDefault }))[2]?.value;
        expect(reviewer({ mode: "agent" })).toBe("Chosen per review");
        expect(
            reviewer({
                mode: "fixed",
                primary: { model: "fast-one" },
                fallback: { model: "slow-one" },
            }),
        ).toBe("Primary fast-one, fallback slow-one");
    });
});

describe("pickSelection", () => {
    const rows = [entry({ model: "a" }), entry({ model: "b" }), entry({ model: "c" })];

    test("keeps the chosen row while it is listed", () => {
        expect(pickSelection(rows, entryKey(rows[1]!), undefined)?.model).toBe("b");
    });

    test("falls back to the current model, then the first row", () => {
        expect(pickSelection(rows, "vera-test/gone", { model: "c" })?.model).toBe("c");
        expect(pickSelection(rows, undefined, undefined)?.model).toBe("a");
    });

    test("is undefined when nothing is listed", () => {
        expect(pickSelection([], undefined, undefined)).toBeUndefined();
    });
});

describe("provider filter", () => {
    const pinned = entry({ provider: "codex", model: "a" });
    const catalog = [
        pinned,
        entry({ provider: "openrouter", model: "b" }),
        entry({ provider: "openrouter", model: "c" }),
        entry({ provider: "anthropic", model: "d" }),
    ];

    test("lists connections with the most models first", () => {
        expect(providerOrder(settings({ shortlist: [pinned], catalog }))).toEqual(["openrouter", "codex", "anthropic"]);
    });

    test("keeps one connection's rows, or every row for Any", () => {
        expect(fromProvider(catalog, "openrouter").map((row) => row.model)).toEqual(["b", "c"]);
        expect(fromProvider(catalog, ANY_PROVIDER)).toBe(catalog);
        expect(fromProvider([pinned], "openrouter")).toEqual([]);
    });
});

describe("browser labels", () => {
    test("cutoffs read Any or a plus floor", () => {
        expect(cutoffLabel("any")).toBe("Any");
        expect(cutoffLabel("1400")).toBe("1400+");
    });

    test("probe results name the pass or the reason", () => {
        expect(probeLine({ ok: true })).toBe("Probe passed.");
        expect(probeLine({ ok: false, reason: "timeout" })).toBe("Probe failed: timeout");
    });
});
