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

test("a page keeps reasoning with the whole turn across messages", () => {
    const body = "x".repeat(600 * 1024);
    const entries: TranscriptEntry[] = [
        { kind: "user", id: "one#0", text: "one" },
        { kind: "reasoning", id: "two#r0", text: "first summary" },
        { kind: "tool", id: "two#0", tool: "read", args: {} },
        { kind: "tool_result", id: "three#0", tool: "read", output: body, isError: false },
        assistant("four#0", "first answer"),
        { kind: "user", id: "five#0", text: "two" },
        { kind: "reasoning", id: "six#r0", text: "second summary" },
        assistant("six#0", body),
    ];
    const tail = historyPageFromEntries(entries);
    if (tail.kind !== "page") throw new Error("expected a tail page");
    expect(ids(tail.entries)).toEqual(["five#0", "six#r0", "six#0"]);
    const older = historyPageFromEntries(entries, tail.page.olderBefore);
    if (older.kind !== "page") throw new Error("expected an older page");
    expect(ids(older.entries)).toEqual(["one#0", "two#r0", "two#0", "three#0", "four#0"]);
});

test("a long turn pages at message boundaries without gaps or overlap", () => {
    for (const outputLength of [16, 8_586]) {
        const entries: TranscriptEntry[] = [{ kind: "user", id: "user#0", text: "find the island" }];
        for (let index = 0; index < 600; index += 1) {
            if (index === 100) {
                entries.push({ kind: "reasoning", id: `call-${index}#r0`, text: "check the stars" });
            }
            entries.push(
                { kind: "tool", id: `call-${index}#0`, tool: "read", args: { index } },
                {
                    kind: "tool_result",
                    id: `result-${index}#0`,
                    tool: "read",
                    output: "x".repeat(outputLength),
                    isError: false,
                },
            );
        }
        const pages: TranscriptEntry[][] = [];
        const seen = new Set<string>();
        let source: readonly TranscriptEntry[] = entries;
        let before: string | undefined;
        while (true) {
            const page = historyPageFromEntries(source, before);
            if (page.kind !== "page") throw new Error(`expected a page, got ${page.kind}`);
            expect(page.entries.length).toBeLessThanOrEqual(HISTORY_PAGE_MAX_ENTRIES);
            expect(Buffer.byteLength(JSON.stringify(page.entries), "utf8"))
                .toBeLessThanOrEqual(HISTORY_PAGE_MAX_BYTES);
            if (pages.length === 0) {
                if (outputLength === 16) expect(page.entries).toHaveLength(HISTORY_PAGE_MAX_ENTRIES);
                else expect(page.entries.length).toBeLessThan(HISTORY_PAGE_MAX_ENTRIES);
            }
            pages.unshift([...page.entries]);
            if (!page.page.hasMore) break;
            before = page.page.olderBefore;
            if (before === undefined || seen.has(before)) throw new Error("invalid page cursor");
            seen.add(before);
            const messageId = before.slice(0, before.lastIndexOf("#"));
            const cursorEnd = entries.findLastIndex((entry) => entry.id?.startsWith(`${messageId}#`)) + 1;
            source = entries.slice(0, cursorEnd);
        }
        expect(pages.length).toBeGreaterThan(1);
        expect(ids(pages.flat())).toEqual(ids(entries));
    }
});

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
