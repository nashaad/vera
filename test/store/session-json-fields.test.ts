import { expect, test } from "bun:test";
import { sessionFirstUserTitle, sessionJsonFields, SessionFieldScanner } from "../../src/store/session-json-fields.ts";
import { canonicalCompactMeasurementLength, measurementComponentsCanonical } from "../../src/store/session-measurement-fields.ts";

test("extracts root metadata around nested bodies and duplicate keys", () => {
    const line = '{"message":{"content":[{"text":"braces } and \\" quotes","input":{"id":7}}]},"id":"old","parentId":null,"type":"message","id":"new","timestamp":"today"}';
    expect(sessionJsonFields(Buffer.from(line))).toEqual({ type: "message", id: "new", parentId: null, timestamp: "today", message: {} });
});

test("validates compact measurement recipes before skipping old bodies", () => {
    const component = { kind: "message", id: "m", owner: "session", source: "user", displayName: "message", count: 1, estimatedTokens: 4 };
    const measurement = { tokens: 4, estimated: true, projection: { estimatedTokens: 4, components: [component] } };
    const record = (recipe: object, data: object = measurement) => Buffer.from(JSON.stringify({
        type: "context_measurement", timestamp: "now", afterMessageId: "one", measurement: data, contextRecipe: recipe,
    }));
    const keyframe = { version: 1, keyframe: true, append: [component], update: [] };
    const delta = { version: 1, keyframe: false, append: [], update: [[0, component]] };
    expect(canonicalCompactMeasurementLength(record(keyframe), undefined, "one")).toBe(1);
    expect(canonicalCompactMeasurementLength(record(delta), 1, "one")).toBe(1);
    expect(canonicalCompactMeasurementLength(record(delta), undefined, "one")).toBeUndefined();
    expect(canonicalCompactMeasurementLength(record({ ...delta, update: [[1, component]] }), 1, "one")).toBeUndefined();
    expect(canonicalCompactMeasurementLength(record({ ...delta, truncate: 2 }), 1, "one")).toBeUndefined();
    expect(canonicalCompactMeasurementLength(record({ ...keyframe, version: 2 }), undefined, "one")).toBeUndefined();
    expect(canonicalCompactMeasurementLength(record(keyframe, { ...measurement, tokens: 5 }), undefined, "one")).toBeUndefined();
    expect(canonicalCompactMeasurementLength(record(keyframe), undefined, "other")).toBeUndefined();
});

test("rejects malformed complete values without decoding bodies", () => {
    for (const line of ['{"type":"message","message":[1,]}', '{"type":"message","message":{"a" 2}}',
        '{"type":"message","message":"bad\\q"}', '{"type":"message","message":01}', '{"type":"message",}']) {
        expect(sessionJsonFields(Buffer.from(line))).toBeUndefined();
    }
});

test("handles deeply nested values without recursive calls", () => {
    const depth = 20000;
    const line = '{"type":"message","body":' + '['.repeat(depth) + '0' + ']'.repeat(depth) + ',"id":"last"}';
    expect(sessionJsonFields(Buffer.from(line))).toEqual({ type: "message", id: "last" });
});

test("recognizes escaped metadata keys without decoding unrelated keys", () => {
    const line = '{"t\\u0079pe":"message","i\\u0064":"entry","message":{"r\\u006fle":"user","content":[]}}';
    expect(sessionJsonFields(Buffer.from(line))).toEqual({ type: "message", id: "entry", message: { role: "user" } });
});

test("reads a bounded title through escaped and large text blocks", () => {
    for (const parts of [
        ["   captain\n🦜  ", "  chart\\sea  "],
        [" ".repeat(5000), "a".repeat(79) + "   b"],
        ["", "\ud800", "x".repeat(10000)],
        [" ", "\t"],
        ['\0\r\n"\\/\u00a0🦜', "\udfff", "next"],
    ]) {
        const line = JSON.stringify({ type: "message", message: { role: "user", content: parts.map((text) => ({ type: "text", text })) } });
        const expected = parts.join(" ").replaceAll(/\s+/g, " ").trim().slice(0, 80);
        expect(sessionFirstUserTitle(Buffer.from(line))).toBe(expected || undefined);
    }
});

test("detects extra fields in retained measurement components and their parts", () => {
    const component = { kind: "message", id: "m", owner: "session", source: "user", displayName: "message", count: 1, estimatedTokens: 4 };
    const line = (value: object) => Buffer.from(JSON.stringify({ type: "context_measurement", contextRecipe: { append: [value], update: [] } }));
    expect(measurementComponentsCanonical(line(component), true)).toBe(true);
    expect(measurementComponentsCanonical(line({ ...component, tag: "old" }), true)).toBe(false);
    expect(measurementComponentsCanonical(line({ ...component, kind: "unknown" }), true)).toBe(false);
    expect(measurementComponentsCanonical(line({ ...component, count: -1 }), true)).toBe(false);
    expect(measurementComponentsCanonical(line({ ...component, estimatedTokens: "4" }), true)).toBe(false);
    const part = { id: "p", displayName: "part", scope: "project", bytes: 1, estimatedTokens: 1 };
    expect(measurementComponentsCanonical(line({ ...component, parts: [part] }), true)).toBe(true);
    expect(measurementComponentsCanonical(line({ ...component, parts: [{ ...part, other: true }] }), true)).toBe(false);
    expect(measurementComponentsCanonical(line({ ...component, parts: [{ ...part, imported: false }] }), true)).toBe(false);
    expect(measurementComponentsCanonical(line({ ...component, parts: [{ ...part, scope: "other" }] }), true)).toBe(false);
});

test("extracts nested fields when the parent contains whitespace", () => {
    const fields = sessionJsonFields(Buffer.from('{ "type" : "message", "message" : { "role" : "assistant", "source" : { "provider" : "p", "model" : "m", "api" : "test" } , "usage" : { "inputTokens" : 2 } } }'));
    expect(fields?.message?.source?.provider).toBe("p");
    expect(fields?.message?.usage?.inputTokens).toBe(2);
});

test("a reused field scanner clears fields between records", () => {
    const scanner = new SessionFieldScanner();
    for (const value of [
        { type: "message", id: "one", parentId: null, message: { role: "assistant", source: { provider: "p", model: "m", api: "test" }, usage: { inputTokens: 1 }, turnTiming: {} } },
        { type: "rewind", userMessageId: "one", previousHeadId: "one", headId: null },
        { type: "message", id: "two", parentId: null, message: { role: "user", content: [{ type: "text", text: "hello" }] } },
    ]) {
        const bytes = Buffer.from(JSON.stringify(value));
        expect(JSON.stringify(scanner.read(bytes))).toBe(JSON.stringify(sessionJsonFields(bytes, false, true)));
    }
});

test("the scan checks timestamp type without retaining the timestamp body", () => {
    const scanner = new SessionFieldScanner();
    const valid = scanner.read(Buffer.from('{"type":"message","timestamp":"2026-01-01T00:00:00Z"}'));
    expect(valid?.timestampStringPresent).toBe(true);
    expect(valid?.timestamp).toBeUndefined();
    const invalid = scanner.read(Buffer.from('{"type":"message","timestamp":"first","timestamp":null}'));
    expect(invalid?.timestampStringPresent).toBe(false);
});
