import { describe, expect, test } from "bun:test";
import { EFFORT_LADDER } from "../../src/model/effort-ladder.ts";
import {
    describedLevels,
    effortDescription,
    effortLevelDescription,
    ladderIsDescribed,
} from "../../src/model/effort-descriptions.ts";

describe("effort descriptions", () => {
    test("every ladder rung has wording", () => {
        expect(ladderIsDescribed()).toBe(true);
        for (const level of EFFORT_LADDER) {
            expect(effortLevelDescription(level)).toBeString();
        }
    });

    test("a catalog's own wording wins", () => {
        expect(effortDescription({ id: "high", label: "High", description: "Provider text" }))
            .toBe("Provider text");
    });

    test("an empty description falls back to the ladder", () => {
        expect(effortDescription({ id: "high", label: "High", description: "" }))
            .toBe(effortLevelDescription("high"));
    });

    test("a level outside the ladder stays bare", () => {
        expect(effortDescription({ id: "turbo", label: "Turbo" })).toBeUndefined();
    });

    test("no wording invents a token budget", () => {
        for (const level of EFFORT_LADDER) {
            expect(effortLevelDescription(level)).not.toMatch(/tokens/i);
        }
    });

    test("describedLevels fills a catalog list without dropping fields", () => {
        const filled = describedLevels([
            { id: "low", label: "Low", wire: "low-wire" },
            { id: "turbo", label: "Turbo" },
        ]);
        expect(filled[0]).toEqual({
            id: "low",
            label: "Low",
            wire: "low-wire",
            description: effortLevelDescription("low") as string,
        });
        expect(filled[1]).toEqual({ id: "turbo", label: "Turbo" });
    });
});
