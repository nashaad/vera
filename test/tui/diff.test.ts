import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { DiffRenderable, RGBA, SyntaxStyle } from "@opentui/core";

import {
    createTuiDiff,
    tuiDiffFiletype,
} from "../../clients/tui/diff.ts";
import { tuiDiffBackgroundColors } from "../../clients/tui/theme.ts";

test("diff file types cover common source paths", () => {
    expect(tuiDiffFiletype("src/index.ts")).toBe("typescript");
    expect(tuiDiffFiletype("component.jsx")).toBe("javascriptreact");
    expect(tuiDiffFiletype("component.tsx")).toBe("typescriptreact");
    expect(tuiDiffFiletype("scripts/release.py")).toBe("python");
    expect(tuiDiffFiletype("cmd/server.go")).toBe("go");
    expect(tuiDiffFiletype("src/Main.kt")).toBe("kotlin");
    expect(tuiDiffFiletype("README")).toBeUndefined();
});

test("inline diffs render line numbers and wrap in a narrow TUI", async () => {
    const setup = await createTestRenderer({ width: 32, height: 12 });
    const syntaxStyle = SyntaxStyle.fromStyles({
        keyword: { fg: "#ff0000" },
        string: { fg: "#00ff00" },
    });
    const diff = createTuiDiff(
        setup.renderer,
        "edit-diff",
        "notes.txt",
        "--- notes.txt\n"
            + "+++ notes.txt\n"
            + "@@ -1,1 +1,1 @@\n"
            + "-a line whose old value is long\n"
            + "+a line whose new value is long\n",
        syntaxStyle,
    );
    setup.renderer.root.add(diff);

    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("notes.txt");
        expect(frame).toContain("1");
        expect(frame).toContain("a line whose old value");
        expect(frame).toContain("a line whose new value");
        expect(diff.height).toBeGreaterThan(2);
    } finally {
        syntaxStyle.destroy();
        setup.renderer.destroy();
    }
});

test("diff tint covers the line-number gutter with a quiet whole-row ground", async () => {
    const setup = await createTestRenderer({ width: 48, height: 10 });
    const syntaxStyle = SyntaxStyle.fromStyles({});
    const diff = createTuiDiff(
        setup.renderer,
        "edit-diff",
        "notes.txt",
        "@@ -1,1 +1,1 @@\n"
            + "-old value that wraps across more than one terminal row for proof\n"
            + "+new value that wraps across more than one terminal row for proof\n",
        syntaxStyle,
    );
    const body = diff.getChildren().find(
        (child): child is DiffRenderable => child instanceof DiffRenderable,
    );
    const backgrounds = tuiDiffBackgroundColors(
        "#0F1016",
        "#2F8F46",
        "#B94A48",
    );

    try {
        setup.renderer.root.add(diff);
        await setup.flush();
        expect(body).toBeDefined();
        expect(body!.addedBg.equals(RGBA.fromHex(backgrounds.added))).toBe(true);
        expect(body!.removedBg.equals(RGBA.fromHex(backgrounds.removed))).toBe(true);
        expect(body!.addedLineNumberBg.equals(body!.addedBg)).toBe(true);
        expect(body!.removedLineNumberBg.equals(body!.removedBg)).toBe(true);
        expect(backgrounds).toEqual({ added: "#173122", removed: "#341d21" });

        const tinted = new Set([
            RGBA.fromHex(backgrounds.added).toInts().toString(),
            RGBA.fromHex(backgrounds.removed).toInts().toString(),
        ]);
        const changedRows = setup.captureSpans().lines.filter((line) =>
            line.spans.some((span) => tinted.has(span.bg.toInts().toString()))
        );
        expect(changedRows.length).toBeGreaterThan(2);
        for (const row of changedRows) {
            const backgrounds = row.spans.map((span) => span.bg.toInts());
            expect(new Set(backgrounds.map(String)).size).toBe(1);
            expect(row.spans.map((span) => span.text).join("")).toHaveLength(48);
        }
    } finally {
        syntaxStyle.destroy();
        setup.renderer.destroy();
    }
});
