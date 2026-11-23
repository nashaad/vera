import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { appendDiffComments } from "../../clients/shared/diff-comment.ts";
import { DiffCommentChips } from "../../clients/ui/src/composer/DiffCommentChips.tsx";
import {
    addDiffComment,
    clearDiffCommentsForTest,
    getDiffComments,
    removeDiffComment,
    removeDiffComments,
} from "../../clients/ui/src/composer/diff-comments.ts";
import { sendPrompt } from "../../clients/ui/src/composer/requests.ts";
import { enterAction } from "../../clients/ui/src/composer/rules.ts";
import { collectChanges } from "../../clients/ui/src/session/changes.ts";
import type { Block } from "../../clients/ui/src/session/model.ts";

const crow = {
    path: "src/crow.ts",
    patchKey: "edit-1",
    startRow: 0,
    endRow: 1,
    startLine: 11,
    endLine: 12,
    side: "new" as const,
    quote: ["const crow = 'captain';", "crow.sail();"],
    note: "Give the crow a map.",
};

afterEach(clearDiffCommentsForTest);

test("@core a waiting diff comment renders a removable chip only in its own session", () => {
    const added = addDiffComment("captain", crow)!;
    const captain = renderToStaticMarkup(createElement(DiffCommentChips, { sessionId: "captain", comments: getDiffComments("captain") }));
    const mate = renderToStaticMarkup(createElement(DiffCommentChips, { sessionId: "mate", comments: getDiffComments("mate") }));
    expect(captain).toContain("Give the crow a map.");
    expect(captain).toContain('<span class="diff-comment-chip-location">src/crow.ts:11-12</span>');
    expect(captain).toContain('title="src/crow.ts:11-12: Give the crow a map."');
    expect(captain).toContain('aria-label="Remove comment on src/crow.ts:11-12"');
    expect(mate).toBe("");
    removeDiffComment("captain", added.id);
    expect(renderToStaticMarkup(createElement(DiffCommentChips, { sessionId: "captain", comments: getDiffComments("captain") }))).toBe("");
});

test("@core comment chips distinguish old and new sides at the same line", () => {
    const note = "Make the pirate crow check the compass before sailing past Nassau and spotting the ship.";
    const old = addDiffComment("captain", { ...crow, startLine: 9, endLine: 9, side: "old", note })!;
    const current = addDiffComment("captain", { ...crow, startLine: 9, endLine: 9, note })!;
    const oldHtml = renderToStaticMarkup(createElement(DiffCommentChips, { sessionId: "captain", comments: [old] }));
    const currentHtml = renderToStaticMarkup(createElement(DiffCommentChips, { sessionId: "captain", comments: [current] }));
    expect(oldHtml).toContain(`<span class="chip-label diff-comment-chip-note">${note}</span>`);
    expect(oldHtml).toContain('<span class="diff-comment-chip-location">src/crow.ts:9 (old)</span>');
    expect(oldHtml).toContain(`title="src/crow.ts:9 (old): ${note}"`);
    expect(oldHtml).toContain('title="Remove comment on src/crow.ts:9 (old)"');
    expect(oldHtml).toContain('aria-label="Remove comment on src/crow.ts:9 (old)"');
    expect(currentHtml).toContain('<span class="diff-comment-chip-location">src/crow.ts:9</span>');
    expect(currentHtml).toContain('aria-label="Remove comment on src/crow.ts:9"');
    expect(currentHtml).not.toContain("(old)");
    expect(currentHtml).not.toContain("(new)");
    const range = addDiffComment("captain", { ...crow, startLine: 9, endLine: 12, side: "old" })!;
    const rangeHtml = renderToStaticMarkup(createElement(DiffCommentChips, { sessionId: "captain", comments: [range] }));
    expect(rangeHtml).toContain('<span class="diff-comment-chip-location">src/crow.ts:9-12 (old)</span>');
    expect(rangeHtml).toContain('aria-label="Remove comment on src/crow.ts:9-12 (old)"');
});

test("@core a file comment chip shows the path alone", () => {
    const added = addDiffComment("captain", { ...crow, file: true, startLine: 0, endLine: 0, quote: [], note: "Review this file." })!;
    const html = renderToStaticMarkup(createElement(DiffCommentChips, { sessionId: "captain", comments: [added] }));
    expect(html).toContain('<span class="diff-comment-chip-location">src/crow.ts</span>');
    expect(html).toContain('title="src/crow.ts: Review this file."');
    expect(html).toContain('aria-label="Remove comment on src/crow.ts"');
});

test("@core comment chip styles reserve space for the full location", () => {
    const css = readFileSync(new URL("../../clients/ui/src/styles/composer.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.diff-comment-chip\s*\{[^}]*max-width:\s*calc\(var\(--vera-space\)\s*\*\s*80\);/s);
    expect(css).toMatch(/\.diff-comment-chip-note\s*\{[^}]*flex:\s*1\s+1\s+auto;/s);
    expect(css).toMatch(/\.chip-label\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;[^}]*text-overflow:\s*ellipsis;/s);
    expect(css).toMatch(/\.diff-comment-chip-location\s*\{[^}]*flex:\s*none;[^}]*white-space:\s*nowrap;/s);
});

test("@core diff comments become plain prompt text and do not consume later comments", () => {
    const first = addDiffComment("captain", crow)!;
    const sending = getDiffComments("captain");
    const content = appendDiffComments("Please inspect.", sending);
    const later = addDiffComment("captain", { ...crow, note: "Check the compass." })!;
    const other = addDiffComment("mate", { ...crow, note: "Hoist the sail." })!;
    const lines: string[] = [];
    const sent = sendPrompt((line) => lines.push(line), content);
    removeDiffComments("captain", sending.map((comment) => comment.id));
    expect(JSON.parse(lines[0]!)).toEqual({ type: "prompt", requestId: sent.requestId, content });
    expect(content).toContain("src/crow.ts:11-12 (new)");
    expect(content).toContain("> const crow = 'captain';\n> crow.sail();");
    expect(content).toContain("Give the crow a map.");
    expect(content).not.toContain("Check the compass.");
    expect(getDiffComments("captain")).toEqual([later]);
    expect(getDiffComments("mate")).toEqual([other]);
    expect(first.id).not.toBe(later.id);
    expect(enterAction({ shift: false, composing: false, empty: false, running: true, queued: true })).toBe("send");
});

test("@core card and Review collection give the same edit the same key", () => {
    const first: Block = { kind: "tools", key: "turn-1", active: false, calls: [{
        tool: "write", title: "Edit crow", args: {}, state: "done", presentation: {
            kind: "diff", diff: { path: "src/crow.ts", patch: "@@ -1 +1 @@\n-old crow\n+new crow", added: 1, removed: 1, scratch: false },
        },
    }] };
    const second: Block = { ...first, key: "turn-2" };
    const card = collectChanges([second]);
    const review = collectChanges([first, second]);
    expect(card[0]!.patchKeys[0]).toBe(review[0]!.patchKeys[1]);
    expect(review[0]!.patchKeys[0]).not.toBe(review[0]!.patchKeys[1]);
});

test("@core a rebuilt edit never inherits another patch's comment identity", () => {
    const diff = { path: "src/crow.ts", patch: "@@ -1 +1 @@\n-old crow\n+new crow", added: 1, removed: 1, scratch: false };
    const block = (value: typeof diff): Block => ({ kind: "tools", key: "l1", active: false, calls: [{
        tool: "write", title: "Edit crow", args: {}, state: "done", presentation: { kind: "diff", diff: value },
    }] });
    const original = collectChanges([block(diff)])[0]!.patchKeys[0]!;
    const rebuilt = collectChanges([block({ ...diff })])[0]!.patchKeys[0]!;
    const different = collectChanges([block({ ...diff, patch: "@@ -1 +1 @@\n-old crow\n+captain crow" })])[0]!.patchKeys[0]!;
    expect(rebuilt).not.toBe(original);
    expect(different).not.toBe(original);
    const comment = addDiffComment("captain", { ...crow, patchKey: original })!;
    expect(getDiffComments("captain")).toEqual([comment]);
    expect(appendDiffComments("", getDiffComments("captain"))).toContain("Give the crow a map.");
});

test("@core an edit's identity changes if its patch or path changes in place", () => {
    const diff = { path: "src/crow.ts", patch: "@@ -1 +1 @@\n-old crow\n+new crow", added: 1, removed: 1, scratch: false };
    const block: Block = { kind: "tools", key: "l1", active: false, calls: [{
        tool: "write", title: "Edit crow", args: {}, state: "done", presentation: { kind: "diff", diff },
    }] };
    const original = collectChanges([block])[0]!.patchKeys[0]!;
    diff.patch = "@@ -1 +1 @@\n-old crow\n+captain crow";
    const changed = collectChanges([block])[0]!.patchKeys[0]!;
    diff.path = "src/first-mate.ts";
    const moved = collectChanges([block])[0]!.patchKeys[0]!;
    expect(changed).not.toBe(original);
    expect(moved).not.toBe(changed);
});
