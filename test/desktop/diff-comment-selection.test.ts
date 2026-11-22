import { expect, test } from "bun:test";
import { createElement, type KeyboardEvent, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { MAX_DIFF_COMMENT_LINES, MAX_DIFF_QUOTE_CHARS } from "../../clients/shared/diff-comment.ts";
import type { StoredDiffComment } from "../../clients/ui/src/composer/diff-comments.ts";
import { CommentEditor, CommentNote, annotationForComment, annotationForEditor, commentControlsEnabled, locationText, matchesComment, quoteNotice } from "../../clients/ui/src/session/DiffComments.tsx";
import { PatchView } from "../../clients/ui/src/session/PatchView.tsx";
import { rangeInPatch, resolveKeyedRange } from "../../clients/ui/src/session/diff/commentRange.ts";
import { mergeKeyedPatches, parseKeyedPatches, rawPatchText, splitKeyedPatches } from "../../clients/ui/src/session/diff/patches.ts";

const PATCH = "--- a/crow.ts\n+++ b/crow.ts\n@@ -1,3 +1,3 @@\n crow in tree\n-old crow\n+new crow\n crow returns\n";

function comment(overrides: Partial<StoredDiffComment> = {}): StoredDiffComment {
    return {
        id: "diff-comment-1",
        path: "crow.ts",
        side: "new",
        startLine: 2,
        endLine: 2,
        quote: ["new crow"],
        note: "Keep the feather",
        patchKey: "edit-1",
        startRow: 2,
        endRow: 2,
        ...overrides,
    };
}

function diff(patch = PATCH) {
    return parseKeyedPatches([patch], ["edit-1"])[0]!.diff!;
}

test("@core a stored comment matches only the same text on the same side", () => {
    expect(matchesComment(diff(), comment())).toBe(true);
    expect(matchesComment(diff(), comment({ quote: ["captain crow"] }))).toBe(false);
    expect(matchesComment(diff(), comment({ side: "old", startLine: 2, endLine: 2, quote: ["new crow"] }))).toBe(false);
    expect(matchesComment(diff(), comment({ startLine: 9, endLine: 9 }))).toBe(false);
    expect(matchesComment(diff(), comment({ quote: ["x".repeat(MAX_DIFF_QUOTE_CHARS + 1)] }))).toBe(false);
});

test("@core comments attach at the end line on the selected side", () => {
    expect(annotationForComment(comment())).toMatchObject({
        side: "additions",
        lineNumber: 2,
        metadata: { kind: "comment", comment: { note: "Keep the feather" } },
    });
    expect(annotationForComment(comment({ side: "old", startLine: 2, endLine: 3, quote: ["old crow", "crow returns"] }))).toMatchObject({
        side: "deletions",
        lineNumber: 3,
    });
    expect(annotationForEditor({
        patchKey: "edit-1",
        range: { side: "old", startLine: 2, endLine: 3, quote: ["old crow", "crow returns"] },
    })).toMatchObject({ side: "deletions", lineNumber: 3, metadata: { kind: "editor" } });
});

test("@core comment ranges keep the quote from the parsed patch", () => {
    const parsed = mergeKeyedPatches(parseKeyedPatches([PATCH], ["edit-1"]), "crow.ts");
    expect(parsed).toBeDefined();
    expect(rangeInPatch(parsed!, "new", 2, 2)?.quote).toEqual(["new crow"]);
    expect(rangeInPatch(parsed!, "old", 2, 2)?.quote).toEqual(["old crow"]);
});

test("@core comment selections enforce the quote caps", () => {
    const many = `--- a/crow.ts\n+++ b/crow.ts\n@@ -1,${MAX_DIFF_COMMENT_LINES + 1} +1,${MAX_DIFF_COMMENT_LINES + 1} @@\n${Array.from({ length: MAX_DIFF_COMMENT_LINES + 1 }, (_, line) => ` crow ${line + 1}\n`).join("")}`;
    const manyRange = rangeInPatch(diff(many), "new", 1, MAX_DIFF_COMMENT_LINES + 1);
    expect(manyRange?.quote).toHaveLength(MAX_DIFF_COMMENT_LINES + 1);
    expect(quoteNotice(manyRange!)).toBe(`Select no more than ${MAX_DIFF_COMMENT_LINES} code lines.`);
    const long = `--- a/crow.ts\n+++ b/crow.ts\n@@ -1 +1 @@\n-${"x".repeat(MAX_DIFF_QUOTE_CHARS + 1)}\n+${"y".repeat(MAX_DIFF_QUOTE_CHARS + 1)}\n`;
    const longRange = rangeInPatch(diff(long), "new", 1, 1);
    expect(quoteNotice(longRange!)).toBe(`The selected code exceeds ${MAX_DIFF_QUOTE_CHARS} characters. Select a shorter range.`);
    expect(quoteNotice(rangeInPatch(diff(), "new", 2, 2)!)).toBeUndefined();
});

test("@core a selection on a later run's line resolves to that run's edit", () => {
    const first = `--- a/nest.ts\n+++ b/nest.ts\n@@ -0,0 +1,20 @@\n${Array.from({ length: 20 }, (_, line) => `+first ${line + 1}\n`).join("")}`;
    const second = `--- a/nest.ts\n+++ b/nest.ts\n@@ -10,7 +10,7 @@\n first 10\n first 11\n first 12\n-first 13\n+second 13\n first 14\n first 15\n first 16\n`;
    const keyed = parseKeyedPatches([first, second], ["edit-1", "edit-2"]);
    const runs = splitKeyedPatches(keyed, "nest.ts");
    expect(runs).toHaveLength(2);
    expect(resolveKeyedRange(keyed, { side: "additions", start: 13, end: 13 })?.patchKey).toBe("edit-1");
    expect(resolveKeyedRange(runs[1]!.patches, { side: "additions", start: 13, end: 13 })).toMatchObject({
        patchKey: "edit-2",
        range: { side: "new", startLine: 13, endLine: 13, quote: ["second 13"] },
    });
});

test("@core a selection crossing two edits of one file is refused", () => {
    const second = "--- a/crow.ts\n+++ b/crow.ts\n@@ -10,2 +10,2 @@\n crow ten\n crow eleven\n";
    const keyed = parseKeyedPatches([PATCH, second], ["edit-1", "edit-2"]);
    expect(resolveKeyedRange(keyed, { side: "additions", start: 2, end: 10 })).toBeUndefined();
    expect(resolveKeyedRange(keyed, { side: "additions", start: 10, end: 11 })).toMatchObject({ patchKey: "edit-2" });
});

test("@core a patch without keys has no comment controls", () => {
    expect(commentControlsEnabled("session-1", undefined, true)).toBe(false);
    expect(commentControlsEnabled("session-1", [], true)).toBe(false);
    expect(commentControlsEnabled(undefined, ["edit-1"], true)).toBe(false);
    expect(commentControlsEnabled("session-1", ["edit-1"], false)).toBe(false);
    expect(commentControlsEnabled("session-1", ["edit-1"], true)).toBe(true);
});

test("@core a malformed patch stays readable without invented line numbers", () => {
    const malformed = "not a patch\nstill not a patch";
    expect(rawPatchText([malformed])).toBe(malformed);
    const html = renderToStaticMarkup(createElement(PatchView, {
        path: "crow.ts",
        patches: [malformed],
        sessionId: "session-1",
        patchKeys: ["edit-1"],
    }));
    expect(html).toContain("Could not read this patch.");
    expect(html).toContain("not a patch");
    expect(html).toContain("still not a patch");
    expect(html).toContain('class="diff-raw"');
    expect(html).not.toContain("diff-number");
    expect(html).not.toContain("data-column-number");
});

test("@core comment location names the line range and old side", () => {
    expect(locationText(2, 2, false)).toBe("Comment on line 2");
    expect(locationText(9, 10, true)).toBe("Comment on lines 9 to 10 (old)");
});

test("@core comment note card shows the old-side range and Added to prompt", () => {
    const html = renderToStaticMarkup(createElement(CommentNote, {
        comment: comment({ side: "old", startLine: 9, endLine: 10, quote: ["old crow", "older crow"], note: "Keep the old crow" }),
    }));
    expect(html).toContain("Comment on lines 9 to 10 (old)");
    expect(html).toContain("Added to prompt");
    expect(html).toContain("Keep the old crow");
    expect(html).toContain("diff-comment-readonly");
    expect(html).not.toContain("diff-line-selected");
});

test("@core diff comment editor renders its prompt field and add action", () => {
    const empty = renderToStaticMarkup(createElement(CommentEditor, {
        title: "Line 2", note: "", notice: undefined, onNoteChange: () => {}, onClose: () => {}, onAdd: () => true,
    }));
    expect(empty).toContain("Add a comment...");
    expect(empty).toContain(">You<");
    expect(empty).toContain(">Line 2<");
    expect(empty).toContain(">Cancel<");
    expect(empty).toContain(">Comment<");
    expect(empty).toContain(`maxLength="2000"`);
    expect(empty).toContain("disabled");
    const filled = renderToStaticMarkup(createElement(CommentEditor, {
        title: "Lines 2 to 4", note: "Map the route", notice: undefined, onNoteChange: () => {}, onClose: () => {}, onAdd: () => true,
    }));
    expect(filled).toContain("Map the route");
    expect(filled).not.toContain("disabled");
});

test("@core comment editor handles empty, multiline, composition and escape keys", () => {
    let added = 0;
    let closed = 0;
    const press = (note: string, key: string, shiftKey = false, isComposing = false) => {
        const editor = CommentEditor({
            title: "Line 2", note, notice: undefined, onNoteChange: () => {},
            onAdd: () => { added += 1; return true; }, onClose: () => { closed += 1; },
        });
        const fields = editor.props.children as ReactElement<{ onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void }>[];
        let prevented = false;
        fields[1]!.props.onKeyDown({
            key, shiftKey, nativeEvent: { isComposing }, preventDefault: () => { prevented = true; },
        } as unknown as KeyboardEvent<HTMLTextAreaElement>);
        return prevented;
    };
    expect(press("   ", "Enter")).toBe(true);
    expect(closed).toBe(1);
    expect(added).toBe(0);
    expect(press("Map the crow's course", "Enter")).toBe(true);
    expect(added).toBe(1);
    expect(press("Map the crow's course", "Enter", true)).toBe(false);
    expect(press("Map the crow's course", "Enter", false, true)).toBe(false);
    expect(added).toBe(1);
    expect(press("Map the crow's course", "Escape")).toBe(true);
    expect(closed).toBe(2);
});
