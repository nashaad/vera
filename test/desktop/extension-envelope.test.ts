import { expect, test } from "bun:test";

import {
    isPlainData,
    MAX_KEY_CHARS,
    MAX_LOG_CHARS,
    MAX_REASON_CHARS,
    MAX_TOAST_CHARS,
    MAX_VALUE_CHARS,
    parseFromWorker,
    parseToWorker,
} from "../../clients/ui/src/extensions/envelope.ts";

test("@core messages to a worker survive structuredClone and JSON, and come back equal", () => {
    const messages = [
        { type: "load", source: "export function activate() {}", commands: ["demo.one", "demo.two"] },
        { type: "run", call: 3, command: "demo.one" },
        { type: "run", call: 4, command: "demo.one", args: { path: "a", list: [1, null, true], nested: { deep: "x" } } },
        { type: "ping", n: 9 },
    ];
    for (const message of messages) {
        expect(parseToWorker(structuredClone(message))).toEqual(message as never);
        expect(parseToWorker(JSON.parse(JSON.stringify(message)))).toEqual(message as never);
    }
});

test("@core messages from a worker survive structuredClone and JSON, and come back equal", () => {
    const messages = [
        { type: "loaded" },
        { type: "load-failed", reason: "no activate" },
        { type: "done", call: 1 },
        { type: "failed", call: 2, reason: "boom" },
        { type: "pong", n: 5 },
        { type: "toast", text: "hello" },
        { type: "toast", text: "hello", tone: "success" },
        { type: "log", level: "warn", text: "careful" },
        { type: "context", key: "demo.armed", value: true },
        { type: "context", key: "demo.count", value: 4 },
        { type: "context", key: "demo.name", value: "x" },
        { type: "context", key: "demo.armed" },
    ];
    for (const message of messages) {
        expect(parseFromWorker(structuredClone(message))).toEqual(message as never);
        expect(parseFromWorker(JSON.parse(JSON.stringify(message)))).toEqual(message as never);
    }
});

test("@core a worker's malformed messages are refused", () => {
    const refused: unknown[] = [
        undefined,
        null,
        "toast",
        [],
        {},
        { type: "unknown" },
        { type: "done" },
        { type: "done", call: -1 },
        { type: "done", call: 1.5 },
        { type: "failed", call: 1 },
        { type: "failed", call: 1, reason: "x".repeat(MAX_REASON_CHARS + 1) },
        { type: "toast", text: 5 },
        { type: "toast", text: "x".repeat(MAX_TOAST_CHARS + 1) },
        { type: "toast", text: "ok", tone: "loud" },
        { type: "log", level: "debug", text: "x" },
        { type: "log", level: "info", text: "x".repeat(MAX_LOG_CHARS + 1) },
        { type: "context", key: "", value: true },
        { type: "context", key: "k".repeat(MAX_KEY_CHARS + 1), value: true },
        { type: "context", key: "demo.a", value: "v".repeat(MAX_VALUE_CHARS + 1) },
        { type: "context", key: "demo.a", value: Number.NaN },
        { type: "context", key: "demo.a", value: { nested: true } },
        { type: "context", key: "demo.a", value: null },
        { type: "pong", n: "1" },
    ];
    for (const message of refused) expect(parseFromWorker(message)).toBeUndefined();
});

test("@core messages to a worker that are malformed are refused", () => {
    const refused: unknown[] = [
        null,
        { type: "load", source: 5, commands: [] },
        { type: "load", source: "", commands: "demo.one" },
        { type: "load", source: "", commands: [1] },
        { type: "load", source: "", commands: Array.from({ length: 501 }, (_, index) => `demo.${index}`) },
        { type: "run", call: "1", command: "demo.one" },
        { type: "run", call: 1, command: 5 },
        { type: "run", call: 1, command: "demo.one", args: () => 1 },
        { type: "run", call: 1, command: "demo.one", args: new Date() },
        { type: "ping" },
        { type: "ping", n: -2 },
    ];
    for (const message of refused) expect(parseToWorker(message)).toBeUndefined();
});

test("plain data refuses anything that is not data, and anything too large or deep", () => {
    class Box {
        readonly value = 1;
    }
    expect(isPlainData({ a: [1, "two", null, { b: false }] })).toBe(true);
    expect(isPlainData(Object.create(null))).toBe(true);
    expect(isPlainData(undefined)).toBe(false);
    expect(isPlainData(() => 1)).toBe(false);
    expect(isPlainData(new Box())).toBe(false);
    expect(isPlainData(new Map())).toBe(false);
    expect(isPlainData(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isPlainData({ a: undefined })).toBe(false);

    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(isPlainData(cycle)).toBe(false);

    let deep: unknown = "end";
    for (let level = 0; level < 12; level += 1) deep = { deeper: deep };
    expect(isPlainData(deep)).toBe(false);
    expect(isPlainData(Array.from({ length: 2_000 }, () => 1))).toBe(false);
    expect(isPlainData("x".repeat(MAX_LOG_CHARS + 1))).toBe(false);
});
