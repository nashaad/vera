import { expect, test } from "bun:test";

import { renderTuiActivityBar } from "../../clients/tui/activity-bar.ts";
import {
    ANIMATIONS_PREVIEW_ROWS,
    handleTuiAnimationsPreviewKey,
    tuiAnimationsPreviewChunks,
    tuiAnimationsPreviewFooter,
} from "../../clients/tui/animations-preview.ts";
import { TUI_ACCENT, TUI_ELEMENT } from "../../clients/tui/state.ts";

const previewText = (level: 0 | 1 | 2 | 3, nowMs: number): string =>
    tuiAnimationsPreviewChunks(level, nowMs).map((chunk) => chunk.text).join("");

test("the preview lists every kind in order, one numbered row each", () => {
    expect(ANIMATIONS_PREVIEW_ROWS.map((row) => row.kind))
        .toEqual(["waiting", "thinking", "reading", "running", "writing"]);
    const rows = previewText(2, 0).split("\n");
    expect(rows).toHaveLength(5);
    ANIMATIONS_PREVIEW_ROWS.forEach((row, index) => {
        expect(rows[index]!.startsWith(`${index + 1}  ${row.kind}`)).toBe(true);
        expect(rows[index]!.endsWith(`  ${row.label}`)).toBe(true);
    });
});

test("each row draws the same strip the composer draws at that level", () => {
    for (const level of [0, 1, 2, 3] as const) {
        const rows = previewText(level, 1_200).split("\n");
        ANIMATIONS_PREVIEW_ROWS.forEach((row, index) => {
            const strip = renderTuiActivityBar(row.kind, level, 1_200, { active: TUI_ACCENT, dim: TUI_ELEMENT })
                .map((cell) => cell.glyph)
                .join("");
            expect(rows[index]).toContain(`${row.kind.padEnd(8)}  ${strip}  `);
        });
    }
});

test("the preview moves between frames above level 1 and holds still when off", () => {
    expect(new Set([0, 300, 600, 900].map((nowMs) => previewText(2, nowMs))).size).toBeGreaterThan(1);
    expect(previewText(0, 0)).toBe(previewText(0, 5_000));
});

test("the footer names the level it is playing at", () => {
    expect(tuiAnimationsPreviewFooter(2)).toBe(
        "Playing at Animation level 2 of 3 (0 is still).\nChange it in /settings, Animation.",
    );
});

test("escape closes the preview and nothing else does", () => {
    expect(handleTuiAnimationsPreviewKey({ name: "escape" })).toBe("dismiss");
    expect(handleTuiAnimationsPreviewKey({ name: "return" })).toBeUndefined();
    expect(handleTuiAnimationsPreviewKey({ name: "escape", ctrl: true })).toBeUndefined();
});
