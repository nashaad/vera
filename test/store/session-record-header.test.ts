import { expect, test } from "bun:test";
import { compactionRecordHeader, contextMeasurementHeader, messageRecordHeader } from "../../src/store/session-record-header.ts";

test("reads canonical headers without decoding their bodies", () => {
    const record = {
        type: "turn_start" as const, id: 'crow-🦜-"\\', parentId: "parent-\ud800", timestamp: "2026-01-01",
        message: { role: "user", content: [{ type: "text", text: "x".repeat(10000) }] },
    };
    expect(messageRecordHeader(Buffer.from(JSON.stringify(record)))).toEqual({
        type: record.type, id: record.id, parentId: record.parentId, timestamp: record.timestamp,
    });
    expect(messageRecordHeader(Buffer.from(JSON.stringify({ ...record, type: "message", parentId: null }))))
        .toEqual({ type: "message", id: record.id, parentId: null, timestamp: record.timestamp });
});

test("reads compaction boundaries without decoding their projections", () => {
    const record = { type: "compaction" as const, id: "compact", timestamp: "today", boundaryMessageId: "a",
        firstRetainedMessageId: "b", projection: [{ role: "user", content: [{ type: "text", text: "x".repeat(10000) }] }] };
    expect(compactionRecordHeader(Buffer.from(JSON.stringify(record)))).toEqual({ type: "compaction", id: "compact",
        timestamp: "today", boundaryMessageId: "a", firstRetainedMessageId: "b" });
    expect(compactionRecordHeader(Buffer.from(JSON.stringify({ ...record, firstRetainedMessageId: null }))))
        .toEqual({ type: "compaction", id: "compact", timestamp: "today", boundaryMessageId: "a", firstRetainedMessageId: null });
});

test("reads measurement ancestry without decoding its components", () => {
    const record = { type: "context_measurement", timestamp: "today", afterMessageId: 'message-"🦜',
        measurement: { projection: "x".repeat(10000) }, contextRecipe: { keyframe: true } };
    expect(contextMeasurementHeader(Buffer.from(JSON.stringify(record))))
        .toEqual({ afterMessageId: record.afterMessageId, compact: true });
    expect(contextMeasurementHeader(Buffer.from(JSON.stringify({ ...record, afterMessageId: null, contextRecipe: undefined }))))
        .toEqual({ afterMessageId: null, compact: false });
});

test("returns no header when the prefix is incomplete, reordered, or malformed", () => {
    expect(messageRecordHeader(Buffer.from('{"type":"message","id":"' + "a".repeat(600)))).toBeUndefined();
    expect(messageRecordHeader(Buffer.from('{"id":"a","type":"message","parentId":null}'))).toBeUndefined();
    expect(messageRecordHeader(Buffer.from('{"type":"message","id":"\\q","parentId":null,"timestamp":"x",'))).toBeUndefined();
});
