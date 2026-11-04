import { expect, test } from "bun:test";

import type { TranscriptEntry } from "../../src/engine/protocol.ts";
import {
    HISTORY_PAGE_MAX_BYTES,
    HISTORY_PAGE_MAX_ENTRIES,
    historyPageFromEntries,
} from "../../src/host/history-page.ts";

function assistant(id: string, text = id): TranscriptEntry {
    return { kind: "assistant", id, text };
}

function ids(entries: readonly TranscriptEntry[]): Array<string | undefined> {
    return entries.map((entry) => entry.id);
}

test("pages backward from the newest entries without overlap", () => {
    const entries = Array.from(
        { length: 500 },
        (_, index) => assistant(`message-${index}#0`),
    );
    const tail = historyPageFromEntries(entries);
    if (tail.kind !== "page") throw new Error("expected a tail page");
    expect(tail.entries).toHaveLength(HISTORY_PAGE_MAX_ENTRIES);
    expect(tail.entries[0]!.id).toBe("message-260#0");
    expect(tail.entries.at(-1)!.id).toBe("message-499#0");
    expect(tail.page).toEqual({
        pageVersion: 1,
        hasMore: true,
        olderBefore: "message-260#0",
        headId: "message-499",
        tailId: "message-499#0",
    });

    const middle = historyPageFromEntries(entries, tail.page.olderBefore);
    if (middle.kind !== "page") throw new Error("expected a middle page");
    expect(middle.entries).toHaveLength(HISTORY_PAGE_MAX_ENTRIES);
    expect(middle.entries[0]!.id).toBe("message-20#0");
    expect(middle.entries.at(-1)!.id).toBe("message-259#0");
    expect(middle.page).toEqual({
        pageVersion: 1,
        hasMore: true,
        olderBefore: "message-20#0",
        headId: "message-499",
        tailId: "message-259#0",
    });

    const oldest = historyPageFromEntries(entries, middle.page.olderBefore);
    if (oldest.kind !== "page") throw new Error("expected an oldest page");
    expect(oldest.entries).toHaveLength(20);
    expect(oldest.page.hasMore).toBe(false);
    expect(oldest.page.olderBefore).toBeUndefined();
    expect(ids([...oldest.entries, ...middle.entries, ...tail.entries]))
        .toEqual(ids(entries));
});

test("a page keeps every entry of one message together", () => {
    const body = "x".repeat(600 * 1024);
    const entries = [
        assistant("one#0", body),
        assistant("one#1", body),
        assistant("two#0", body),
        assistant("two#1", body),
    ];
    const tail = historyPageFromEntries(entries);
    if (tail.kind !== "page") throw new Error("expected a tail page");
    expect(ids(tail.entries)).toEqual(["two#0", "two#1"]);
    expect(Buffer.byteLength(JSON.stringify(tail.entries))).toBeGreaterThan(
        HISTORY_PAGE_MAX_BYTES,
    );
    expect(tail.page.olderBefore).toBe("two#0");

    const older = historyPageFromEntries(entries, tail.page.olderBefore);
    if (older.kind !== "page") throw new Error("expected an older page");
    expect(ids(older.entries)).toEqual(["one#0", "one#1"]);
    expect(older.page.hasMore).toBe(false);
});

test("an entry over the byte budget is returned alone, not split", () => {
    const entries = [
        assistant("small#0"),
        assistant("large#0", "y".repeat(2 * 1024 * 1024)),
    ];
    const tail = historyPageFromEntries(entries);
    if (tail.kind !== "page") throw new Error("expected a tail page");
    expect(ids(tail.entries)).toEqual(["large#0"]);
    expect(tail.entries[0]!.kind).toBe("assistant");
    expect(tail.page.hasMore).toBe(true);
    expect(tail.page.olderBefore).toBe("large#0");
});

test("an entry over the hard cap fails the page instead of truncating", () => {
    const entries = [
        assistant("small#0"),
        assistant("huge#0", "z".repeat(9 * 1024 * 1024)),
        assistant("newest#0"),
    ];
    const tail = historyPageFromEntries(entries);
    if (tail.kind !== "page") throw new Error("expected a tail page");
    expect(ids(tail.entries)).toEqual(["newest#0"]);

    const older = historyPageFromEntries(entries, tail.page.olderBefore);
    expect(older).toEqual({ kind: "page_too_large" });
});

test("an unknown cursor is reported instead of guessing", () => {
    expect(historyPageFromEntries(
        [assistant("one#0")],
        "missing#0",
    )).toEqual({ kind: "cursor_not_found" });
});

test("a page before the first entry is empty and has no tail", () => {
    const entries = [assistant("one#0"), assistant("two#0")];
    const page = historyPageFromEntries(entries, "one#0");
    if (page.kind !== "page") throw new Error("expected a page");
    expect(page.entries).toEqual([]);
    expect(page.page).toEqual({
        pageVersion: 1,
        hasMore: false,
        headId: "two",
    });
});

test("harness rows stay with the message before them", () => {
    const body = "h".repeat(600 * 1024);
    const entries: TranscriptEntry[] = [
        assistant("one#0", body),
        { kind: "harness", text: body, tone: "soft" },
        assistant("two#0", body),
        { kind: "harness", id: "harness:7", text: body, tone: "soft" },
        assistant("three#0", body),
    ];
    const tail = historyPageFromEntries(entries);
    if (tail.kind !== "page") throw new Error("expected a tail page");
    expect(ids(tail.entries)).toEqual(["three#0"]);

    const older = historyPageFromEntries(entries, tail.page.olderBefore);
    if (older.kind !== "page") throw new Error("expected an older page");
    expect(ids(older.entries)).toEqual(["two#0", "harness:7"]);
    expect(older.page.olderBefore).toBe("two#0");

    const oldest = historyPageFromEntries(entries, older.page.olderBefore);
    if (oldest.kind !== "page") throw new Error("expected an oldest page");
    expect(ids(oldest.entries)).toEqual(["one#0", undefined]);
    expect(oldest.page.hasMore).toBe(false);
});

test("a transcript with no entry ids is one unpaged group", () => {
    const entries: TranscriptEntry[] = [
        { kind: "user", text: "hello" },
        { kind: "assistant", text: "hi" },
    ];
    const page = historyPageFromEntries(entries);
    if (page.kind !== "page") throw new Error("expected a page");
    expect(page.entries).toEqual(entries);
    expect(page.page.hasMore).toBe(false);
    expect(page.page.headId).toBeUndefined();
    expect(page.page.tailId).toBeUndefined();
});
