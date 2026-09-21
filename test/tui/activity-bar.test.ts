import { expect, test } from "bun:test";

import {
    QUIET_THINKING_AFTER_MS,
    readingPass,
    renderTuiActivityBar,
    tuiActivityKind,
} from "../../clients/tui/activity-bar.ts";

const COLORS = { active: "#e0703e", dim: "#3a3a3a" };

test("the pane's activity phrase picks the bar's kind", () => {
    expect(tuiActivityKind("thinking", false, 0)).toBe("waiting");
    expect(tuiActivityKind("thinking", true, 0)).toBe("thinking");
    expect(tuiActivityKind("retrying gpt", false, 0)).toBe("waiting");
    expect(tuiActivityKind("running read", false, 0)).toBe("reading");
    expect(tuiActivityKind("running grep", false, 0)).toBe("reading");
    expect(tuiActivityKind("running bash", false, 0)).toBe("running");
    expect(tuiActivityKind("running edit", false, 0)).toBe("writing");
    expect(tuiActivityKind("responding", false, 0)).toBe("writing");
});

test("a quiet thinking phase turns from waiting to thinking after the threshold", () => {
    expect(QUIET_THINKING_AFTER_MS).toBe(2_000);
    expect(tuiActivityKind("thinking", false, QUIET_THINKING_AFTER_MS)).toBe("waiting");
    expect(tuiActivityKind("thinking", false, QUIET_THINKING_AFTER_MS + 1)).toBe("thinking");
    expect(tuiActivityKind("retrying gpt", false, 10_000)).toBe("waiting");
    expect(tuiActivityKind("waiting", false, 10_000)).toBe("waiting");
    expect(tuiActivityKind("running bash", false, 10_000)).toBe("running");
    expect(tuiActivityKind("responding", false, 10_000)).toBe("writing");
});

test("each level sets how wide the bar is", () => {
    expect(renderTuiActivityBar("thinking", 0, 0, COLORS)).toHaveLength(1);
    expect(renderTuiActivityBar("thinking", 1, 0, COLORS)).toHaveLength(1);
    expect(renderTuiActivityBar("thinking", 2, 0, COLORS)).toHaveLength(6);
    expect(renderTuiActivityBar("thinking", 3, 0, COLORS)).toHaveLength(8);
});

test("off is one still glyph per kind, and levels 2 and 3 move", () => {
    const still = (nowMs: number) => renderTuiActivityBar("reading", 0, nowMs, COLORS);
    expect(still(0)).toEqual(still(5_000));
    expect(still(0)[0]).toEqual({ glyph: "▚", color: COLORS.active });
    expect(renderTuiActivityBar("running", 0, 0, COLORS)[0]?.glyph).toBe("▄");

    const frames = (level: 2 | 3) => [0, 300, 600, 900].map((nowMs) =>
        renderTuiActivityBar("thinking", level, nowMs, COLORS).map((cell) => cell.glyph).join("")
    );
    expect(new Set(frames(2)).size).toBeGreaterThan(1);
    expect(new Set(frames(3)).size).toBeGreaterThan(1);
});

test("subtle keeps the glyph and only changes its colour", () => {
    const cells = [0, 500, 1_000].map((nowMs) => renderTuiActivityBar("writing", 1, nowMs, COLORS)[0]!);
    expect(new Set(cells.map((cell) => cell.glyph))).toEqual(new Set(["▌"]));
    expect(new Set(cells.map((cell) => cell.color)).size).toBeGreaterThan(1);
});

test("waiting on the model is a still glyph that breathes", () => {
    const cells = [0, 400, 800].map((nowMs) => renderTuiActivityBar("waiting", 2, nowMs, COLORS));
    expect(new Set(cells.flat().map((cell) => cell.glyph))).toEqual(new Set(["▓"]));
    expect(new Set(cells.map((row) => row[0]!.color)).size).toBeGreaterThan(1);
    expect(renderTuiActivityBar("waiting", 0, 0, COLORS)[0]?.glyph).toBe("▓");
});

test("the waiting glyph and its breathing colour are pinned", () => {
    expect(renderTuiActivityBar("waiting", 1, 1_200, COLORS)).toEqual([{ glyph: "▓", color: "#e0703e" }]);
    expect(renderTuiActivityBar("waiting", 2, 1_200, COLORS))
        .toEqual(Array.from({ length: 6 }, () => ({ glyph: "▓", color: "#e0703e" })));
    expect(renderTuiActivityBar("waiting", 3, 1_200, COLORS))
        .toEqual(Array.from({ length: 8 }, () => ({ glyph: "▓", color: "#a95e3d" })));
});

const HEAD_GLYPHS = new Set(["▚", "▞", "▙", "▛", "▜", "▟"]);
const TRAIL_GLYPHS = new Set(["▖", "▗", "▘", "▝", "▌", "▐"]);
const READING_GLYPHS = new Set([...HEAD_GLYPHS, ...TRAIL_GLYPHS, "·"]);

function readingGlyphs(level: 2 | 3, nowMs: number): string {
    return renderTuiActivityBar("reading", level, nowMs, COLORS).map((cell) => cell.glyph).join("");
}

test("reading renders the same cells for the same time", () => {
    for (const nowMs of [0, 1_234, 90_000, 1_790_000_000_000]) {
        expect(renderTuiActivityBar("reading", 2, nowMs, COLORS)).toEqual(renderTuiActivityBar("reading", 2, nowMs, COLORS));
        expect(renderTuiActivityBar("reading", 3, nowMs, COLORS)).toEqual(renderTuiActivityBar("reading", 3, nowMs, COLORS));
    }
});

test("reading passes start at different cells and run different lengths", () => {
    for (const width of [6, 8]) {
        const passes = Array.from({ length: 40 }, (_, index) => readingPass(index, width));
        expect(new Set(passes.map((pass) => pass.start)).size).toBeGreaterThan(2);
        expect(new Set(passes.map((pass) => pass.length)).size).toBeGreaterThan(2);
        expect(new Set(passes.map((pass) => pass.speed.toFixed(3))).size).toBeGreaterThan(2);
        for (const pass of passes) {
            expect(pass.length).toBeGreaterThanOrEqual(2);
            expect(pass.start + pass.length).toBeLessThanOrEqual(width);
            expect(pass.gap).toBeGreaterThan(0);
        }
    }
});

test("reading shows one head at a time, rests between passes, and moves its start", () => {
    const frames = Array.from({ length: 400 }, (_, step) => readingGlyphs(2, step * 60));
    for (const frame of frames) {
        expect(frame).toHaveLength(6);
        expect([...frame].filter((glyph) => HEAD_GLYPHS.has(glyph)).length).toBeLessThanOrEqual(1);
        for (const glyph of frame) expect(READING_GLYPHS.has(glyph)).toBe(true);
    }
    expect(frames).toContain("······");
    const headAtPassStart = frames.filter((frame, step) => step > 0 && frames[step - 1] === "······" && frame !== "······")
        .map((frame) => [...frame].findIndex((glyph) => HEAD_GLYPHS.has(glyph)));
    expect(new Set(headAtPassStart).size).toBeGreaterThan(1);
});

test("reading glyphs change inside a pass like bytes streaming past", () => {
    const pass = Array.from({ length: 40 }, (_, step) => readingGlyphs(2, step * 60));
    const heads = pass.map((frame) => [...frame].find((glyph) => HEAD_GLYPHS.has(glyph)));
    const trails = pass.flatMap((frame) => [...frame].filter((glyph) => TRAIL_GLYPHS.has(glyph)));
    expect(new Set(heads).size).toBeGreaterThan(3);
    expect(new Set(trails).size).toBeGreaterThan(3);
    expect(readingGlyphs(2, 0)).toBe(readingGlyphs(2, 60));
    expect(readingGlyphs(2, 60)).not.toBe(readingGlyphs(2, 120));
});

test("the reading frames are pinned", () => {
    expect([0, 120, 240, 600, 1_200, 1_800, 2_400, 2_700, 3_000].map((nowMs) => readingGlyphs(2, nowMs)))
        .toEqual(["·▛····", "·▜····", "·▟····", "·▘▞···", "·▌▖▙··", "··▌▌▚·", "···▝▖▚", "······", "·▜····"]);
});

test("reading at off and subtle is unchanged: one still glyph", () => {
    const cells = [0, 500, 1_000].map((nowMs) => renderTuiActivityBar("reading", 1, nowMs, COLORS));
    expect(new Set(cells.flat().map((cell) => cell.glyph))).toEqual(new Set(["▚"]));
    expect(cells.every((row) => row.length === 1)).toBe(true);
    expect(renderTuiActivityBar("reading", 0, 12_345, COLORS)).toEqual([{ glyph: "▚", color: COLORS.active }]);
});
