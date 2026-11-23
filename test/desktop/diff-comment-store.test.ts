import { afterEach, expect, test } from "bun:test";

import { MAX_DIFF_COMMENT_CHARS, MAX_DIFF_COMMENT_LINES, MAX_DIFF_COMMENTS, MAX_DIFF_QUOTE_CHARS } from "../../clients/shared/diff-comment.ts";
import {
    addDiffComment,
    clearDiffCommentsForTest,
    getDiffComments,
    MAX_WINDOW_DIFF_COMMENTS,
    removeDiffComment,
    removeDiffComments,
    subscribeDiffComments,
    type StoredDiffComment,
} from "../../clients/ui/src/composer/diff-comments.ts";

function crow(overrides: Partial<Omit<StoredDiffComment, "id">> = {}): Omit<StoredDiffComment, "id"> {
    return {
        path: "src/crow.ts",
        patchKey: "captain-edit-1",
        startRow: 0,
        endRow: 0,
        startLine: 11,
        endLine: 11,
        side: "new",
        quote: ["const crow = 'captain';"],
        note: "Give the crow a map.",
        ...overrides,
    };
}

afterEach(clearDiffCommentsForTest);

test("@core diff comments wait for their own session and notify only its listeners", () => {
    const captain = addDiffComment("captain", crow());
    const mate = addDiffComment("mate", crow({ note: "Polish the compass." }));
    let captainChanges = 0;
    let mateChanges = 0;
    const stopCaptain = subscribeDiffComments("captain", () => { captainChanges++; });
    const stopMate = subscribeDiffComments("mate", () => { mateChanges++; });
    expect(getDiffComments("captain")).toEqual([captain!]);
    expect(getDiffComments("mate")).toEqual([mate!]);
    expect(getDiffComments("other")).toEqual([]);
    removeDiffComment("captain", captain!.id);
    expect(captainChanges).toBe(1);
    expect(mateChanges).toBe(0);
    expect(getDiffComments("mate")).toEqual([mate!]);
    stopCaptain();
    stopMate();
});

test("@core diff comment snapshots stay stable and removal clears only named chips", () => {
    const first = addDiffComment("captain", crow())!;
    const second = addDiffComment("captain", crow({ note: "Hoist the sail." }))!;
    const snapshot = getDiffComments("captain");
    expect(getDiffComments("captain")).toBe(snapshot);
    removeDiffComments("captain", [first.id, "missing"]);
    expect(snapshot).toEqual([first, second]);
    expect(getDiffComments("captain")).toEqual([second]);
    removeDiffComment("captain", second.id);
    expect(getDiffComments("captain")).toEqual([]);
});

test("@core diff comments refuse excess chips without displacing existing sessions", () => {
    for (let index = 0; index < MAX_DIFF_COMMENTS; index++) expect(addDiffComment("captain", crow())).toBeDefined();
    expect(addDiffComment("captain", crow())).toBeUndefined();
    for (let index = MAX_DIFF_COMMENTS; index < MAX_WINDOW_DIFF_COMMENTS; index++) {
        expect(addDiffComment(`crew-${index}`, crow())).toBeDefined();
    }
    expect(addDiffComment("stowaway", crow())).toBeUndefined();
    const first = getDiffComments("captain")[0]!;
    removeDiffComment("captain", first.id);
    expect(addDiffComment("stowaway", crow())).toBeDefined();
    expect(getDiffComments("captain")).toHaveLength(MAX_DIFF_COMMENTS - 1);
});

test("@core diff comments reject blank or over-limit notes and quotes", () => {
    expect(addDiffComment("captain", crow({ note: " \n " }))).toBeUndefined();
    expect(addDiffComment("captain", crow({ note: "x".repeat(MAX_DIFF_COMMENT_CHARS + 1) }))).toBeUndefined();
    expect(addDiffComment("captain", crow({ quote: Array(MAX_DIFF_COMMENT_LINES + 1).fill("crow") }))).toBeUndefined();
    expect(addDiffComment("captain", crow({ quote: ["x".repeat(MAX_DIFF_QUOTE_CHARS + 1)] }))).toBeUndefined();
    expect(getDiffComments("captain")).toEqual([]);
});

test("@core a file comment needs no line range or quote", () => {
    const file = addDiffComment("captain", crow({ file: true, startLine: 0, endLine: 0, quote: [] }));
    expect(file).toBeDefined();
    expect(file?.file).toBe(true);
    expect(file?.quote).toEqual([]);
    expect(getDiffComments("captain")).toEqual([file!]);
    expect(addDiffComment("captain", crow({ file: true, startLine: 0, endLine: 0, quote: [], note: " " }))).toBeUndefined();
});

test("@core diff comments copy quotes and ignore invalid destinations", () => {
    const quote = ["crow at sea"];
    expect(addDiffComment("", crow({ quote }))).toBeUndefined();
    const added = addDiffComment("captain", crow({ quote }))!;
    quote[0] = "crow ashore";
    expect(added.quote).toEqual(["crow at sea"]);
    expect(addDiffComment("captain", crow({ startLine: 0 }))).toBeUndefined();
    expect(addDiffComment("captain", crow({ endRow: -1 }))).toBeUndefined();
});
