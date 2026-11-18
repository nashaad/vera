import { expect, test } from "bun:test";
import { ReconnectBudget } from "../../clients/tui/main/reconnect-budget.ts";

test("@core automatic reconnects use a rolling per-conversation window", () => {
    const budget = new ReconnectBudget();
    try {
        expect(budget.tryStart("crow", 0)).toBeTrue();
        expect(budget.tryStart("crow", 10_000)).toBeTrue();
        expect(budget.tryStart("crow", 20_000)).toBeTrue();
        expect(budget.tryStart("crow", 59_999)).toBeFalse();
        expect(budget.tryStart("kraken", 59_999)).toBeTrue();
        expect(budget.tryStart("crow", 60_000)).toBeTrue();
        expect(budget.tryStart("crow", 69_999)).toBeFalse();
        expect(budget.tryStart("crow", 70_000)).toBeTrue();
        budget.clear("crow");
        expect(budget.tryStart("crow", 70_001)).toBeTrue();
    } finally {
        budget.clear("crow");
        budget.clear("kraken");
    }
});
