import { expect, test } from "bun:test";

import { formatBlendedRate, formatListedRates } from "../../src/model/listed-rates.ts";

test("listed rates draw as in/out with no dollar sign", () => {
    expect(formatListedRates({ input: 3, output: 15 })).toBe("3/15");
    expect(formatListedRates({ input: 0.15, output: 0.6 })).toBe("0.15/0.6");
    expect(formatListedRates({ input: 0, output: 0 })).toBe("0/0");
    expect(formatListedRates({ input: 1.2, output: 1.20 })).toBe("1.2/1.2");
    expect(formatListedRates(undefined)).toBeUndefined();
});

test("blended price weights input 3:1 over output and ignores cache", () => {
    expect(formatBlendedRate({ input: 2, output: 6 })).toBe("3");
    expect(formatBlendedRate({ input: 2, output: 6, cache: 0.2 })).toBe("3");
    expect(formatBlendedRate({ input: 3, output: 15 })).toBe("6");
    expect(formatBlendedRate(undefined)).toBeUndefined();
});
