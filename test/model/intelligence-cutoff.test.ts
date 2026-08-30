import { expect, test } from "bun:test";

import {
    passesIntelligenceCutoff,
    stepIntelligenceCutoff,
} from "../../src/model/intelligence-cutoff.ts";

test("any keeps every score, including a missing one", () => {
    expect(passesIntelligenceCutoff(undefined, "any")).toBe(true);
    expect(passesIntelligenceCutoff(1200, "any")).toBe(true);
    expect(passesIntelligenceCutoff(1700, "any")).toBe(true);
});

test("numbered stops are WA Score floors, and a blank score fails them", () => {
    expect(passesIntelligenceCutoff(1399, "1400")).toBe(false);
    expect(passesIntelligenceCutoff(1400, "1400")).toBe(true);
    expect(passesIntelligenceCutoff(undefined, "1400")).toBe(false);
    expect(passesIntelligenceCutoff(1599, "1600")).toBe(false);
    expect(passesIntelligenceCutoff(1600, "1600")).toBe(true);
});

test("the cutoff steps along six stops and stops at the ends", () => {
    expect(stepIntelligenceCutoff("any", 1)).toBe("1400");
    expect(stepIntelligenceCutoff("1400", 1)).toBe("1450");
    expect(stepIntelligenceCutoff("1450", 1)).toBe("1500");
    expect(stepIntelligenceCutoff("1500", 1)).toBe("1550");
    expect(stepIntelligenceCutoff("1550", 1)).toBe("1600");
    expect(stepIntelligenceCutoff("1600", 1)).toBe("1600");
    expect(stepIntelligenceCutoff("any", -1)).toBe("any");
    expect(stepIntelligenceCutoff("1400", -1)).toBe("any");
});
