import { expect, test } from "bun:test";
import { fileChangeGutterCss } from "../../clients/ui/src/views/file-change-css.ts";

test("gutter styles use bounded line ranges without changing source text", () => {
    const css = fileChangeGutterCss([
        { kind: "added", start: 2, end: 4 },
        { kind: "changed", start: 6, end: 8 },
        { kind: "removed", start: 9, end: 9 },
        { kind: "removed", start: 11, end: 11 },
    ], 10);
    expect(css).toContain("attr(data-column-number type(<number>), 0)");
    expect(css).toContain("var(--files-gutter-line) - 1");
    expect(css).toContain("5 - var(--files-gutter-line)");
    expect(css).toContain("var(--vera-diff-added)");
    expect(css).toContain("var(--vera-link)");
    expect(css).toContain("var(--vera-diff-removed)");
    expect(css).toContain("var(--vera-space)");
    expect(css).toContain("left bottom");
    expect(css).not.toContain("content:");
});

test("gutter styles ignore invalid inputs and limit range expansion", () => {
    expect(fileChangeGutterCss([], 1)).toBe("");
    expect(fileChangeGutterCss([{ kind: "added", start: 0, end: 1 }], 1)).toBe("");
    expect(fileChangeGutterCss([{ kind: "added", start: 1, end: 1 }], 0)).toBe("");
    const changes = Array.from({ length: 501 }, (_, index) => ({ kind: "added" as const, start: index + 1, end: index + 1 }));
    const css = fileChangeGutterCss(changes, 600);
    expect(css).toContain("calc(501 - var(--files-gutter-line))");
    expect(css).not.toContain("calc(502 - var(--files-gutter-line))");
});
