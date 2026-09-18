import { expect, test } from "bun:test";

import { money } from "../../clients/annex/money.ts";

test("spend under a cent keeps four decimals instead of rounding to zero", () => {
    expect(money(0)).toBe("$0.00");
    expect(money(0.0036)).toBe("$0.0036");
    expect(money(0.00002)).toBe("<$0.0001");
    expect(money(0.01)).toBe("$0.01");
    expect(money(12.345)).toBe("$12.35");
});
