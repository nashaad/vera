import { expect, test } from "bun:test";

import { renderTuiActivityBar, tuiActivityKind } from "../../clients/tui/activity-bar.ts";

const COLORS = { active: "#e0703e", dim: "#3a3a3a" };

test("the pane's activity phrase picks the bar's kind", () => {
    expect(tuiActivityKind("thinking", false)).toBe("waiting");
    expect(tuiActivityKind("thinking", true)).toBe("thinking");
    expect(tuiActivityKind("retrying gpt", false)).toBe("waiting");
    expect(tuiActivityKind("running read", false)).toBe("reading");
    expect(tuiActivityKind("running grep", false)).toBe("reading");
    expect(tuiActivityKind("running bash", false)).toBe("running");
    expect(tuiActivityKind("running edit", false)).toBe("writing");
    expect(tuiActivityKind("responding", false)).toBe("writing");
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
