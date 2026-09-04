import { expect, test } from "bun:test";
import {
    overrideConflict,
    overrideRows,
    type ConfiguredOverrides,
    type OverrideKey,
} from "../../src/engine/override-rows.ts";

function rowFor(
    key: OverrideKey,
    configured: ConfiguredOverrides,
    capacity: number | undefined,
) {
    const row = overrideRows(configured, capacity).find((each) => each.key === key);
    if (row === undefined) {
        throw new Error(`no row for ${key}`);
    }
    return row;
}

test("an untouched lever reads as its shipped default", () => {
    const row = rowFor("compactionTriggerFraction", {}, 200_000);

    expect(row.value).toBe(0.82);
    expect(row.source).toBe("default");
    expect(row.inert).toBeUndefined();
});

test("a configured lever says so, and carries the configured value", () => {
    const row = rowFor("summaryWordCap", { summaryWordCap: 500 }, 200_000);

    expect(row.value).toBe(500);
    expect(row.source).toBe("configured");
});

test("the context limit row shows the window the engine resolved", () => {
    expect(rowFor("contextLimit", {}, 200_000).value).toBe(200_000);
    expect(rowFor("contextLimit", {}, undefined).value).toBeUndefined();
});

test("an unknown window kills both fractions", () => {
    const fraction = rowFor("compactionTriggerFraction", {}, undefined);
    const target = rowFor("postCompactionTargetFraction", {}, undefined);

    expect(fraction.inert).toContain("context window is unknown");
    expect(target.inert).toContain("context window is unknown");
    // The value still shows, because the row is about what is set, not what fires.
    expect(fraction.value).toBe(0.82);
});

test("an unknown window is what makes the token trigger live", () => {
    expect(rowFor("compactionTriggerTokens", {}, undefined)).toEqual({
        key: "compactionTriggerTokens",
        value: 100_000,
        source: "default",
    });
    expect(rowFor("compactionTriggerTokens", {}, 200_000)).toEqual({
        key: "compactionTriggerTokens",
        source: "default",
        inert: "the window is known, so the fraction decides",
    });
});

test("a token trigger below the fraction's point shadows the fraction", () => {
    // 0.82 of 200k is 164k, so a 50k trigger always gets there first.
    const early = rowFor(
        "compactionTriggerFraction",
        { compactionTriggerTokens: 50_000 },
        200_000,
    );
    expect(early.inert).toBe("the token trigger fires first, at 50000");

    const late = rowFor(
        "compactionTriggerFraction",
        { compactionTriggerTokens: 180_000 },
        200_000,
    );
    expect(late.inert).toBeUndefined();
});

test("a known window kills the token target", () => {
    expect(rowFor("compactionTargetTokens", {}, 200_000).inert)
        .toBe("the window is known, so the target is a share of it");
    expect(rowFor("compactionTargetTokens", {}, undefined).inert).toBeUndefined();
});

test("the aging level and its turn count follow the window", () => {
    expect(rowFor("toolResultAgingLevel", {}, 1_000_000).value).toBe("relaxed");
    expect(rowFor("toolResultStubAfterTurns", {}, 1_000_000).value).toBe(5);
    expect(rowFor("toolResultAgingLevel", {}, 64_000).value).toBe("tight");
    expect(rowFor("toolResultStubAfterTurns", {}, 64_000).value).toBe(3);
});

test("a chosen aging level overrides the one the window would pick", () => {
    const configured: ConfiguredOverrides = { toolResultAgingLevel: "relaxed" };

    expect(rowFor("toolResultAgingLevel", configured, 64_000)).toEqual({
        key: "toolResultAgingLevel",
        value: "relaxed",
        source: "configured",
    });
    // The turn count moves with it, so the two rows never disagree.
    expect(rowFor("toolResultStubAfterTurns", configured, 64_000).value).toBe(5);
});

test("every lever gets a row, once", () => {
    const keys = overrideRows({}, 200_000).map((row) => row.key);

    expect(keys.length).toBe(11);
    expect(new Set(keys).size).toBe(11);
});

test("a pick that stands beside what is set is not refused", () => {
    const rows = overrideRows({ compactionTriggerFraction: 0.7 }, 200_000);

    expect(overrideConflict(rows, { postCompactionTargetFraction: 0.45 }))
        .toBeUndefined();
    expect(overrideConflict(rows, { summaryWordCap: 500 })).toBeUndefined();
});

test("a refusal names both levers, not only the one just picked", () => {
    const rows = overrideRows({ compactionTriggerFraction: 0.3 }, 200_000);

    expect(overrideConflict(rows, { postCompactionTargetFraction: 0.45 }))
        .toBe("A 0.45 summary target is not under the 0.30 trigger.");
});

test("a lever left at its shipped default is still one side of a rule", () => {
    // Nothing is set, so the ceiling this is measured against is the one
    // Vera ships, and the pane has to say so rather than write a file that
    // will not load.
    expect(overrideConflict(overrideRows({}, 200_000), {
        toolResultTotalBudgetBytes: 16_384,
    })).toBe("A 16k total budget is under the 64k one-result ceiling.");
});

test("clearing a lever clears the rule it was one side of", () => {
    const rows = overrideRows(
        { toolResultCeilingBytes: 8_192, toolResultTotalBudgetBytes: 16_384 },
        200_000,
    );

    expect(overrideConflict(rows, { toolResultCeilingBytes: null }))
        .toBe("A 16k total budget is under the 64k one-result ceiling.");
    expect(overrideConflict(rows, { toolResultTotalBudgetBytes: null }))
        .toBeUndefined();
});
