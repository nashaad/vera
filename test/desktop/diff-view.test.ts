import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DiffViewControls } from "../../clients/ui/src/session/DiffViewControls.tsx";
import { capDiff, MAX_PATCH_LINES } from "../../clients/ui/src/session/diff/cap.ts";
import { annotationSide, lineOrdinal, lineTextAt, patchContainsRange, rangeInPatch, selectionSide } from "../../clients/ui/src/session/diff/commentRange.ts";
import { diffOptions, MAX_LINE_DIFF_LENGTH, TOKENIZE_MAX_LINE_LENGTH } from "../../clients/ui/src/session/diff/pierreOptions.ts";
import { mergeKeyedPatches, parseKeyedPatches, reviewItemId, splitKeyedPatches } from "../../clients/ui/src/session/diff/patches.ts";

const FIRST = "--- a/crow.ts\n+++ b/crow.ts\n@@ -1,2 +1,2 @@\n crow stays\n-old treasure\n+new treasure\n";
const SECOND = "--- a/crow.ts\n+++ b/crow.ts\n@@ -10 +10 @@\n-deck\n+ship\n";

function merged() {
    const keyed = parseKeyedPatches([FIRST, SECOND], ["edit-1", "edit-2"]);
    const diff = mergeKeyedPatches(keyed, "crow.ts");
    if (diff === undefined) throw new Error("fixture did not parse");
    return { keyed, diff };
}

test("@core keyed patches keep their keys and parse each edit", () => {
    const { keyed } = merged();
    expect(keyed.map((entry) => entry.key)).toEqual(["edit-1", "edit-2"]);
    expect(keyed.map((entry) => entry.diff?.hunks.length)).toEqual([1, 1]);
    expect(keyed[0]!.patch).toBe(FIRST);
});

test("@core merged patches keep one file with both edits in order", () => {
    const { diff } = merged();
    expect(diff.name).toBe("crow.ts");
    expect(diff.hunks).toHaveLength(2);
    expect(diff.hunks[1]!.deletionLineIndex).toBe(2);
    expect(diff.additionLines.join("")).toContain("new treasure");
    expect(diff.additionLines.join("")).toContain("ship");
    expect(diff.cacheKey).toBe("vera:edit-1|edit-2");
    expect(lineTextAt(diff, "new", 1)).toBe("crow stays");
    expect(lineTextAt(diff, "new", 2)).toBe("new treasure");
    expect(lineTextAt(diff, "new", 10)).toBe("ship");
    expect(lineTextAt(diff, "old", 10)).toBe("deck");
});

test("@core a range reads one side of the diff and refuses missing lines", () => {
    const { diff } = merged();
    expect(rangeInPatch(diff, "new", 1, 2)).toEqual({ side: "new", startLine: 1, endLine: 2, quote: ["crow stays", "new treasure"] });
    expect(rangeInPatch(diff, "old", 2, 2)?.quote).toEqual(["old treasure"]);
    expect(rangeInPatch(diff, "new", 2, 1)?.startLine).toBe(1);
    expect(rangeInPatch(diff, "new", 99, 99)).toBeUndefined();
    expect(rangeInPatch(diff, "new", 1, 41)).toBeUndefined();
    expect(patchContainsRange(diff, "new", 1, 2)).toBe(true);
    expect(patchContainsRange(diff, "new", 2, 10)).toBe(false);
});

test("@core selection and annotation sides follow removed rows", () => {
    expect(selectionSide({ side: "deletions" })).toBe("old");
    expect(selectionSide({ side: "additions" })).toBe("new");
    expect(selectionSide({})).toBe("new");
    expect(selectionSide({ side: "additions", endSide: "deletions" })).toBeUndefined();
    expect(annotationSide("old")).toBe("deletions");
    expect(annotationSide("new")).toBe("additions");
});

test("@core line ordinals count only the selected side", () => {
    const { diff } = merged();
    expect(lineOrdinal(diff, "new", 1)).toBe(0);
    expect(lineOrdinal(diff, "new", 2)).toBe(1);
    expect(lineOrdinal(diff, "old", 2)).toBe(1);
    expect(lineOrdinal(diff, "old", 10)).toBe(2);
    expect(lineOrdinal(diff, "new", 99)).toBe(0);
});

test("@core diff options keep the agreed defaults", () => {
    const options = diffOptions("split", "scroll");
    expect(options).toMatchObject({
        diffStyle: "split",
        overflow: "scroll",
        hunkSeparators: "line-info-basic",
        diffIndicators: "bars",
        disableFileHeader: true,
        lineDiffType: "word-alt",
        expandUnchanged: false,
        enableLineSelection: true,
        enableGutterUtility: true,
        maxLineDiffLength: MAX_LINE_DIFF_LENGTH,
        tokenizeMaxLineLength: TOKENIZE_MAX_LINE_LENGTH,
    });
    expect(options.theme).toBe("vera-diff");
    expect(options.themeType).toBe("dark");
});

test("@core diff view controls mark the chosen modes", () => {
    const html = renderToStaticMarkup(createElement(DiffViewControls, {
        diffStyle: "split",
        overflow: "scroll",
        onDiffStyle: () => {},
        onOverflow: () => {},
    }));
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html).toContain(">Unified<");
    expect(html).toContain(">Split<");
    expect(html).toContain(">Wrap<");
    expect(html).toContain(">Scroll<");
    expect(html).not.toContain(">Hunks<");
    expect(html).not.toContain(">Bars<");
    expect(html).not.toContain("disabled");
});

test("@core a long patch drops whole hunks past the 400 line cap", () => {
    let patch = "--- a/crow.ts\n+++ b/crow.ts\n";
    for (let hunk = 0; hunk < 5; hunk += 1) {
        const start = hunk * 100 + 1;
        patch += `@@ -${start},100 +${start},100 @@\n`;
        for (let line = 0; line < 100; line += 1) patch += ` crow ${hunk}-${line}\n`;
    }
    const diff = parseKeyedPatches([patch], ["big"])[0]!.diff;
    if (diff === undefined) throw new Error("fixture did not parse");
    expect(diff.unifiedLineCount).toBe(500);
    const cached = { ...diff, cacheKey: "vera:big" };
    const capped = capDiff(cached);
    expect(capped.cut).toBe(true);
    expect(capped.diff.hunks).toHaveLength(4);
    expect(capped.diff.unifiedLineCount).toBe(MAX_PATCH_LINES);
    expect(capped.diff.cacheKey).toBe("vera:big:cap:400");
    expect(capDiff(cached, 1_000).cut).toBe(false);
});

test("@core a single oversized hunk is trimmed at the cap", () => {
    let patch = "--- a/crow.ts\n+++ b/crow.ts\n@@ -1,500 +1,500 @@\n";
    for (let line = 1; line <= 500; line += 1) patch += ` crow ${line}\n`;
    const diff = parseKeyedPatches([patch], ["single"])[0]!.diff;
    if (diff === undefined) throw new Error("fixture did not parse");
    expect(diff.unifiedLineCount).toBe(500);
    const capped = capDiff({ ...diff, cacheKey: "vera:single" });
    expect(capped.cut).toBe(true);
    expect(capped.diff.hunks).toHaveLength(1);
    expect(capped.diff.unifiedLineCount).toBe(MAX_PATCH_LINES);
    expect(capped.diff.hunks[0]!.hunkContent).toHaveLength(1);
    expect(capped.diff.hunks[0]!.hunkContent[0]).toMatchObject({ type: "context", lines: MAX_PATCH_LINES });
    expect(capped.diff.cacheKey).toBe("vera:single:cap:400");
});

test("@core a single oversized change block is trimmed at the cap", () => {
    let patch = "--- a/crow.ts\n+++ b/crow.ts\n@@ -1,450 +1,450 @@\n";
    for (let line = 1; line <= 450; line += 1) patch += `-old ${line}\n`;
    for (let line = 1; line <= 450; line += 1) patch += `+new ${line}\n`;
    const diff = parseKeyedPatches([patch], ["change"])[0]!.diff;
    if (diff === undefined) throw new Error("fixture did not parse");
    expect(diff.hunks[0]!.hunkContent).toHaveLength(1);
    expect(diff.hunks[0]!.hunkContent[0]).toMatchObject({ type: "change", deletions: 450, additions: 450 });
    const capped = capDiff({ ...diff, cacheKey: "vera:change" });
    expect(capped.cut).toBe(true);
    expect(capped.diff.hunks).toHaveLength(1);
    expect(capped.diff.unifiedLineCount).toBe(MAX_PATCH_LINES);
    expect(capped.diff.hunks[0]!.hunkContent[0]).toMatchObject({ type: "change", deletions: MAX_PATCH_LINES, additions: 0 });
    expect(capped.diff.hunks[0]!.additionLines).toBe(0);
    expect(capped.diff.hunks[0]!.deletionLines).toBe(MAX_PATCH_LINES);
});

test("@core a later patch is trimmed once earlier patches fill the cap", () => {
    const patch = (start: number): string => {
        let text = `--- a/crow.ts\n+++ b/crow.ts\n@@ -${start},300 +${start},300 @@\n`;
        for (let line = 0; line < 300; line += 1) text += ` crow ${start}-${line}\n`;
        return text;
    };
    const keyed = parseKeyedPatches([patch(1), patch(400)], ["first", "second"]);
    const diff = mergeKeyedPatches(keyed, "crow.ts");
    if (diff === undefined) throw new Error("fixture did not parse");
    expect(diff.hunks.reduce((total, hunk) => total + hunk.unifiedLineCount, 0)).toBe(600);
    expect(diff.hunks[1]!.unifiedLineStart).toBe(399);
    expect(diff.unifiedLineCount).toBe(699);
    const capped = capDiff({ ...diff, cacheKey: "vera:two" });
    expect(capped.cut).toBe(true);
    expect(capped.diff.hunks).toHaveLength(2);
    expect(capped.diff.unifiedLineCount).toBe(MAX_PATCH_LINES);
    expect(capped.diff.hunks[0]!.unifiedLineCount).toBe(300);
    expect(capped.diff.hunks[1]!.unifiedLineCount).toBe(100);
    expect(capped.diff.hunks[1]!.hunkContent[0]).toMatchObject({ type: "context", lines: 100 });
    expect(capped.diff.cacheKey).toBe("vera:two:cap:400");
});

test("@core a late patch starts where the previous rendered lines end", () => {
    const patch = (start: number, count: number): string => {
        let text = `--- a/crow.ts\n+++ b/crow.ts\n@@ -${start},${count} +${start},${count} @@\n`;
        for (let line = 0; line < count; line += 1) text += ` crow ${start + line}\n`;
        return text;
    };
    const keyed = parseKeyedPatches([patch(400, 300), patch(800, 10)], ["first", "second"]);
    const diff = mergeKeyedPatches(keyed, "crow.ts");
    if (diff === undefined) throw new Error("fixture did not parse");
    expect(diff.hunks[0]!.unifiedLineStart).toBe(399);
    expect(diff.hunks[1]!.unifiedLineStart).toBe(400);
    expect(diff.unifiedLineCount).toBe(410);
    expect(diff.hunks.reduce((total, hunk) => total + hunk.unifiedLineCount, 0)).toBe(310);
    expect(capDiff(diff).cut).toBe(false);
});

test("@core a later edit starts at the gap after the previous hunk", () => {
    const patch = (start: number): string => {
        let text = `--- a/crow.ts\n+++ b/crow.ts\n@@ -${start},300 +${start},300 @@\n`;
        for (let line = 0; line < 300; line += 1) text += ` crow ${start + line}\n`;
        return text;
    };
    const keyed = parseKeyedPatches([patch(1), patch(400)], ["first", "second"]);
    const diff = mergeKeyedPatches(keyed, "crow.ts");
    if (diff === undefined) throw new Error("fixture did not parse");
    expect(diff.hunks[0]!.collapsedBefore).toBe(0);
    expect(diff.hunks[1]!.collapsedBefore).toBe(99);
    expect(diff.hunks[1]!.unifiedLineStart).toBe(399);
    expect(diff.hunks[1]!.splitLineStart).toBe(399);
    expect(diff.unifiedLineCount).toBe(699);
});

test("@core ascending edits of one file stay in one run", () => {
    const patch = (start: number): string => {
        let text = `--- a/crow.ts\n+++ b/crow.ts\n@@ -${start},300 +${start},300 @@\n`;
        for (let line = 0; line < 300; line += 1) text += ` crow ${start + line}\n`;
        return text;
    };
    const keyed = parseKeyedPatches([patch(1), patch(400)], ["first", "second"]);
    const runs = splitKeyedPatches(keyed, "crow.ts");
    expect(runs.map((run) => run.patches.map((entry) => entry.key))).toEqual([["first", "second"]]);
    expect(runs[0]!.diff.hunks).toHaveLength(2);
    expect(runs[0]!.diff.cacheKey).toBe("vera-run:first|second");
});

test("@core an overlapping later edit starts a second run", () => {
    const first = `--- a/crow.ts\n+++ b/crow.ts\n@@ -400,300 +400,300 @@\n${Array.from({ length: 300 }, (_, line) => ` crow ${400 + line}\n`).join("")}`;
    const second = `--- a/crow.ts\n+++ b/crow.ts\n@@ -500,10 +500,10 @@\n${Array.from({ length: 10 }, (_, line) => ` crow ${500 + line}\n`).join("")}`;
    const keyed = parseKeyedPatches([first, second], ["first", "second"]);
    const runs = splitKeyedPatches(keyed, "crow.ts");
    expect(runs.map((run) => run.patches.map((entry) => entry.key))).toEqual([["first"], ["second"]]);
    expect(runs[0]!.diff.hunks).toHaveLength(1);
    expect(runs[1]!.diff.hunks).toHaveLength(1);
    expect(runs[1]!.diff.hunks[0]!.unifiedLineStart).toBe(499);
    expect(runs[1]!.diff.cacheKey).toBe("vera-run:second");
});

test("@core a file scroll target lands on the first run", () => {
    const first = `--- a/crow.ts\n+++ b/crow.ts\n@@ -400,300 +400,300 @@\n${Array.from({ length: 300 }, (_, line) => ` crow ${400 + line}\n`).join("")}`;
    const second = `--- a/crow.ts\n+++ b/crow.ts\n@@ -500,10 +500,10 @@\n${Array.from({ length: 10 }, (_, line) => ` crow ${500 + line}\n`).join("")}`;
    const runs = splitKeyedPatches(parseKeyedPatches([first, second], ["first", "second"]), "crow.ts");
    expect(runs.map((run, index) => reviewItemId("crow.ts", run.patches, index))).toEqual([
        "crow.ts",
        JSON.stringify(["crow.ts", "second"]),
    ]);
    const single = splitKeyedPatches(parseKeyedPatches([first], ["only"]), "crow.ts");
    expect(reviewItemId("crow.ts", single[0]!.patches, 0)).toBe("crow.ts");
});

test("@core an overlapping later edit keeps its own divider count", () => {
    const first = `--- a/crow.ts\n+++ b/crow.ts\n@@ -400,300 +400,300 @@\n${Array.from({ length: 300 }, (_, line) => ` crow ${400 + line}\n`).join("")}`;
    const second = `--- a/crow.ts\n+++ b/crow.ts\n@@ -500,10 +500,10 @@\n${Array.from({ length: 10 }, (_, line) => ` crow ${500 + line}\n`).join("")}`;
    const keyed = parseKeyedPatches([first, second], ["first", "second"]);
    const diff = mergeKeyedPatches(keyed, "crow.ts");
    if (diff === undefined) throw new Error("fixture did not parse");
    expect(diff.hunks[1]!.collapsedBefore).toBe(499);
    expect(diff.hunks[1]!.unifiedLineStart).toBe(799);
    expect(diff.unifiedLineCount).toBe(809);
});

test("@core a late hunk keeps its line index range when trimmed", () => {
    let patch = "--- a/crow.ts\n+++ b/crow.ts\n@@ -400,500 +400,500 @@\n";
    for (let line = 0; line < 500; line += 1) patch += ` crow ${400 + line}\n`;
    const diff = parseKeyedPatches([patch], ["late"])[0]!.diff;
    if (diff === undefined) throw new Error("fixture did not parse");
    expect(diff.unifiedLineCount).toBe(899);
    const capped = capDiff(diff);
    expect(capped.cut).toBe(true);
    expect(capped.diff.hunks[0]!.unifiedLineCount).toBe(MAX_PATCH_LINES);
    expect(capped.diff.unifiedLineCount).toBe(399 + MAX_PATCH_LINES);
});

test("@core malformed patches stay unparsed", () => {
    const keyed = parseKeyedPatches(["not a patch"], ["edit-1"]);
    expect(keyed[0]!.diff).toBeUndefined();
    expect(mergeKeyedPatches(keyed, "crow.ts")).toBeUndefined();
});
