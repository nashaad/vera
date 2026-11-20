import { expect, test } from "bun:test";

import { spendShare } from "../../clients/annex/model-table.ts";

test("unpriced model share has a dash and no bar", () => {
    expect(spendShare([{ kind: "unpriced", share: 0 }])).toEqual({ label: "\u2014" });
});

test("priced model shares show rounded percentages", () => {
    expect(spendShare([{ kind: "reported", share: 0.124 }]))
        .toEqual({ label: "12%", percentage: 12 });
    expect(spendShare([{ kind: "estimated", share: 0.126 }]))
        .toEqual({ label: "13%", percentage: 13 });
    expect(spendShare([{ kind: "mixed", share: 0.505 }]))
        .toEqual({ label: "51%", percentage: 51 });
    expect(spendShare([{ kind: "reported", share: 0 }]))
        .toEqual({ label: "0%", percentage: 0 });
});

test("Other has a dash when every folded model is unpriced", () => {
    expect(spendShare([
        { kind: "unpriced", share: 0 },
        { kind: "unpriced", share: 0 },
    ])).toEqual({ label: "\u2014" });
});

test("Other sums shares before rounding when any folded model is priced", () => {
    expect(spendShare([
        { kind: "unpriced", share: 0 },
        { kind: "estimated", share: 0.124 },
        { kind: "mixed", share: 0.124 },
    ])).toEqual({ label: "25%", percentage: 25 });
    expect(spendShare([
        { kind: "unpriced", share: 0 },
        { kind: "reported", share: 0 },
    ])).toEqual({ label: "0%", percentage: 0 });
});
