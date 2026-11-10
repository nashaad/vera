import { expect, test } from "bun:test";

import {
    EMPTY_HISTORY_WINDOW,
    HISTORY_PAGE_VERSION,
    historyUserPrompts,
    historyUserTexts,
    historyWindowFirstUserText,
    mergeHistoryUpdate,
    mergeKnownUserPrompts,
    prependHistoryPage,
    type HistoryPageSlice,
    type HistoryWindow,
} from "../../clients/shared/history-window.ts";
import type { HistoryPageInfo, TranscriptEntry } from "../../src/engine/protocol.ts";

function row(id: string, kind: "assistant" | "user" = "assistant"): TranscriptEntry {
    return kind === "user"
        ? { kind: "user", id, text: `text ${id}` }
        : { kind: "assistant", id, text: `text ${id}` };
}

function window(
    entries: readonly TranscriptEntry[],
    hasEarlier = false,
    olderBefore?: string,
): HistoryWindow {
    return {
        entries,
        hasEarlier,
        ...(olderBefore === undefined ? {} : { olderBefore }),
        headId: entries.at(-1)?.id,
    };
}

function pageInfo(hasMore: boolean, olderBefore?: string): HistoryPageInfo {
    return {
        pageVersion: HISTORY_PAGE_VERSION,
        hasMore,
        ...(olderBefore === undefined ? {} : { olderBefore }),
        headId: "e",
        tailId: "e",
    };
}

function page(
    before: string,
    entries: readonly TranscriptEntry[],
    hasMore: boolean,
    olderBefore?: string,
): HistoryPageSlice {
    return {
        before,
        entries,
        page: pageInfo(hasMore, olderBefore),
    };
}

test("prompt recall retains attachment ids across a replaced page", () => {
    const older: TranscriptEntry = { kind: "user", id: "old", text: "map", attachments: [{ id: "image-old" }] };
    const newer: TranscriptEntry = { kind: "user", id: "new", text: "map", attachments: [{ id: "image-new" }] };
    const known = historyUserPrompts([older]);
    const merged = mergeHistoryUpdate(window([older], true, "old"), {
        entries: [newer], page: pageInfo(true, "new"), seq: 4,
    });
    expect(mergeKnownUserPrompts(known, merged, [newer])).toEqual([
        { text: "map", attachmentIds: ["image-old"] },
        { text: "map", attachmentIds: ["image-new"] },
    ]);
});

test("a history without page info replaces the window", () => {
    const current = window([row("a"), row("b")], true, "a");
    const merged = mergeHistoryUpdate(current, {
        entries: [row("x"), row("y")],
        seq: 3,
    });
    expect(merged.kind).toBe("replace");
    expect(merged.window.entries.map((entry) => entry.id)).toEqual(["x", "y"]);
    expect(merged.window.hasEarlier).toBe(false);
    expect(merged.window.olderBefore).toBeUndefined();
});

test("an unknown page version is treated as a full history", () => {
    const merged = mergeHistoryUpdate(EMPTY_HISTORY_WINDOW, {
        entries: [row("a")],
        page: { ...pageInfo(true, "a"), pageVersion: 99 },
        seq: 3,
    });
    expect(merged.kind).toBe("replace");
    expect(merged.window.hasEarlier).toBe(false);
});

test("the first tail page records how far back it reaches", () => {
    const merged = mergeHistoryUpdate(EMPTY_HISTORY_WINDOW, {
        entries: [row("c"), row("d")],
        page: pageInfo(true, "c"),
        seq: 3,
    });
    expect(merged.kind).toBe("replace");
    expect(merged.window.hasEarlier).toBe(true);
    expect(merged.window.olderBefore).toBe("c");
    expect(merged.window.headId).toBe("e");
});

test("a tail page keeps the older loaded prefix by entry id", () => {
    const current = window(
        [row("a"), row("b"), row("c"), row("d")],
        false,
        undefined,
    );
    const merged = mergeHistoryUpdate(current, {
        entries: [row("c"), row("d"), row("e")],
        page: pageInfo(true, "c"),
        seq: 4,
    });
    expect(merged.kind).toBe("append");
    expect(merged.window.entries.map((entry) => entry.id)).toEqual([
        "a",
        "b",
        "c",
        "d",
        "e",
    ]);
    expect(merged.window.hasEarlier).toBe(false);
});

test("a page with no shared id replaces the loaded window", () => {
    const current = window([row("a"), row("b")], true, "a");
    const merged = mergeHistoryUpdate(current, {
        entries: [row("x"), row("y")],
        page: pageInfo(false),
        seq: 5,
    });
    expect(merged.kind).toBe("replace");
    expect(merged.window.entries.map((entry) => entry.id)).toEqual(["x", "y"]);
    expect(merged.window.hasEarlier).toBe(false);
});

test("a page already inside the window changes nothing", () => {
    const current = window([row("a"), row("b"), row("c")], true, "a");
    const merged = mergeHistoryUpdate(current, {
        entries: [row("b"), row("c")],
        page: pageInfo(true, "b"),
        seq: 5,
    });
    expect(merged.kind).toBe("append");
    expect(merged.window.entries.map((entry) => entry.id)).toEqual([
        "a",
        "b",
        "c",
    ]);
    expect(merged.window.hasEarlier).toBe(true);
    expect(merged.window.olderBefore).toBe("a");
});

test("an older page prepends when the cursor still matches", () => {
    const current = window([row("c"), row("d")], true, "c");
    const merged = prependHistoryPage(current, page("c", [row("a"), row("b")], false));
    expect(merged.kind).toBe("prepend");
    expect(merged.window.entries.map((entry) => entry.id)).toEqual([
        "a",
        "b",
        "c",
        "d",
    ]);
    expect(merged.window.hasEarlier).toBe(false);
    expect(merged.window.olderBefore).toBeUndefined();
});

test("an older page with a stale cursor is ignored", () => {
    const current = window([row("c"), row("d")], true, "c");
    const merged = prependHistoryPage(current, page("b", [row("a")], false));
    expect(merged.kind).toBe("keep");
    expect(merged.window).toBe(current);
});

test("an older page does not duplicate entries already loaded", () => {
    const current = window([row("b"), row("c")], true, "b");
    const merged = prependHistoryPage(current, page("b", [row("a"), row("b")], false));
    expect(merged.kind).toBe("prepend");
    expect(merged.window.entries.map((entry) => entry.id)).toEqual([
        "a",
        "b",
        "c",
    ]);
});

test("a page that adds nothing is kept as is", () => {
    const current = window([row("b"), row("c")], true, "b");
    const merged = prependHistoryPage(current, page("b", [row("b")], true, "b"));
    expect(merged.kind).toBe("keep");
});

test("user texts keep their order and only a start window names the title", () => {
    const tail = window([row("b", "user"), row("c")], true, "b");
    expect(historyUserTexts(tail.entries)).toEqual(["text b"]);
    expect(historyWindowFirstUserText(tail)).toBeUndefined();
    const start = window([row("a", "user"), row("b", "user")], false);
    expect(historyWindowFirstUserText(start)).toBe("text a");
});

test("an older cursor on a page that adds nothing moves the cursor", () => {
    const current = window([row("c"), row("d")], true, "c");
    const merged = prependHistoryPage(current, page("c", [row("c")], true, "a"));
    expect(merged.kind).toBe("advance");
    expect(merged.window.entries.map((entry) => entry.id)).toEqual(["c", "d"]);
    expect(merged.window.olderBefore).toBe("a");
    expect(merged.window.hasEarlier).toBe(true);
});

test("a page that adds nothing and reaches the start ends the window", () => {
    const current = window([row("c"), row("d")], true, "c");
    const merged = prependHistoryPage(current, page("c", [row("c")], false));
    expect(merged.kind).toBe("advance");
    expect(merged.window.hasEarlier).toBe(false);
    expect(merged.window.olderBefore).toBeUndefined();
});
