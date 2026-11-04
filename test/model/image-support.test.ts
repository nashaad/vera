import { expect, test } from "bun:test";

import {
    NEGATIVE_IMAGE_FACT_MAX_AGE_MS,
    resolveImageSupportFromSources,
} from "../../src/model/image-support.ts";

const NOW = new Date("2026-11-03T12:00:00.000Z");

function seenDaysBefore(days: number): string {
    return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
}

test("a declared answer outranks a learned refusal at any age", () => {
    expect(resolveImageSupportFromSources({
        declared: true,
        learned: { ok: false, seen: seenDaysBefore(400) },
        now: NOW,
    })).toBe(true);
});

test("a fresh refusal keeps images off the model", () => {
    expect(resolveImageSupportFromSources({
        learned: { ok: false, seen: seenDaysBefore(2) },
        now: NOW,
    })).toBe(false);
});

test("a refusal older than the window falls through to the catalog", () => {
    const days = Math.ceil(NEGATIVE_IMAGE_FACT_MAX_AGE_MS / 86_400_000) + 1;
    expect(resolveImageSupportFromSources({
        learned: { ok: false, seen: seenDaysBefore(days) },
        catalog: true,
        now: NOW,
    })).toBe(true);
});

test("an unreadable refusal date does not keep a model blocked", () => {
    expect(resolveImageSupportFromSources({
        learned: { ok: false, seen: "not a date" },
        now: NOW,
    })).toBeUndefined();
});
