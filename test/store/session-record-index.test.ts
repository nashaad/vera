import { describe, expect, test } from "bun:test";
import { SessionRecordIndex } from "../../src/store/session-record-index.ts";

describe("session record index", () => {
    test("preserves IDs through growth and distinguishes UTF-16 strings", () => {
        const index = new SessionRecordIndex();
        const ids = Array.from({ length: 1000 }, (_, number) => `entry-${number}-${number % 2 === 0 ? "🦜" : "\ud800"}`);
        ids.push("crow-🐦", "crow-\ud800", "crow-\ufffd", "");
        for (const [number, id] of ids.entries()) {
            index.append(number * 100, number + 1, {
                type: "message", id, parentId: number === 0 ? null : ids[number - 1],
            });
        }
        for (const [number, id] of ids.entries()) {
            expect(index.messageRecord(id)).toBe(number);
            expect(index.messageId(number)).toBe(id);
            expect(index.location(number)).toEqual({ offset: number * 100, length: number + 1 });
        }
        expect(index.messageRecord("missing")).toBeUndefined();
        index.append(200000, 1, { type: "message", id: ids[0], parentId: null });
        expect(index.messageRecord(ids[0]!)).toBe(ids.length);
        expect(index.messageRecord(ids[1]!)).toBe(1);
    });

    test("preserves record lengths above the packed column range", () => {
        const index = new SessionRecordIndex();
        index.append(7, 0x100000001, { type: "message", id: "large", parentId: null });
        expect(index.location(0)).toEqual({ offset: 7, length: 0x100000001 });
        expect(index.location(1)).toBeUndefined();
    });

    test("indexes ASCII IDs without creating strings and shares lookup with other IDs", () => {
        const index = new SessionRecordIndex();
        const first = Buffer.from("entry-one");
        index.appendAsciiMessage(0, 1, { type: "message", message: { role: "user" } }, first, 0, first.length, undefined);
        index.append(1, 1, { type: "message", id: "🦜", parentId: "entry-one", message: { role: "assistant" } });
        const third = Buffer.from("prefix-entry-three-suffix");
        index.appendAsciiMessage(2, 1, { type: "message", message: { role: "user" } }, third, 7, 18, 1);
        expect(index.messageRecord("entry-one")).toBe(0);
        expect(index.messageRecordAscii(first, 0, first.length)).toBe(0);
        expect(index.messageId(2)).toBe("entry-three");
        expect(index.parent(2)).toBe(1);
        expect(index.messageIdMatchesAscii(0, first, 0, first.length)).toBe(true);
        expect(index.messageIdMatchesAscii(1, first, 0, first.length)).toBe(false);
    });

    test("resolves compaction anchors against the current branch, including later records", () => {
        const index = new SessionRecordIndex();
        index.append(0, 1, { type: "message", id: "first", parentId: null, message: { role: "user" } });
        index.append(1, 1, { type: "compaction", boundaryMessageId: "first", firstRetainedMessageId: "later" });
        index.append(2, 1, { type: "message", id: "later", parentId: "first", message: { role: "user" } });
        expect(index.latestApplicableCompaction("later")).toBe(1);
        index.append(3, 1, { type: "message", id: "barrier", parentId: "later", message: { role: "user", compactionBarrier: true } });
        index.append(4, 1, { type: "compaction", boundaryMessageId: "barrier", firstRetainedMessageId: null });
        expect(index.latestApplicableCompaction("barrier")).toBe(1);
        index.append(5, 1, { type: "message", id: "tool", parentId: "first", message: { role: "tool_result" } });
        expect(index.latestApplicableCompaction("tool")).toBeUndefined();
    });

    test("finds the newest measurement on each branch", () => {
        const index = new SessionRecordIndex();
        index.append(0, 1, { type: "message", id: "first", parentId: null, message: { role: "user" } });
        index.append(1, 1, { type: "context_measurement", afterMessageId: "first" });
        index.append(2, 1, { type: "message", id: "abandoned", parentId: "first", message: { role: "user" } });
        index.append(3, 1, { type: "context_measurement", afterMessageId: "abandoned", contextRecipe: {} });
        index.append(4, 1, { type: "message", id: "current", parentId: "first", message: { role: "user" } });
        expect(index.latestMeasurement("current")).toBe(1);
        expect(index.latestMeasurement("abandoned")).toBe(3);
        index.append(5, 1, { type: "context_measurement", afterMessageId: null });
        expect(index.latestMeasurement("current")).toBe(5);
        expect(index.latestMeasurement(null)).toBe(5);
    });
});
