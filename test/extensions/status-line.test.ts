import { expect, test } from "bun:test";

import {
    MAX_STATUS_LINE_SEGMENTS,
    parseStatusLineSegments,
} from "../../src/extensions/status-line.ts";

test("segments keep only the facts each kind declares", () => {
    expect(parseStatusLineSegments([
        { kind: "model", provider: "openrouter", model: "glm-5.2" },
        { kind: "context", tokens: 10, capacity: 40 },
        { kind: "note", text: "queued", tone: "warning" },
    ])).toEqual([
        { kind: "model", provider: "openrouter", model: "glm-5.2" },
        { kind: "context", tokens: 10, capacity: 40 },
        { kind: "note", text: "queued", tone: "warning" },
    ]);
});

test("one bad segment invalidates the whole list", () => {
    // Half a status line is worse than the built-in one: the client cannot
    // tell which facts the extension meant to drop.
    expect(parseStatusLineSegments([
        { kind: "model", model: "glm-5.2" },
        { kind: "context", tokens: -1 },
    ])).toBeUndefined();
});

test("segments refuse unknown kinds, stray keys, and non-lists", () => {
    expect(parseStatusLineSegments([{ kind: "vibe", text: "good" }]))
        .toBeUndefined();
    expect(parseStatusLineSegments([
        { kind: "permissions", mode: "auto", colour: "red" },
    ])).toBeUndefined();
    expect(parseStatusLineSegments([{ kind: "turn", state: "thinking" }]))
        .toBeUndefined();
    expect(parseStatusLineSegments({ kind: "note", text: "one" }))
        .toBeUndefined();
    expect(parseStatusLineSegments(Promise.resolve([]))).toBeUndefined();
});

test("segments are capped so one repaint cannot be flooded", () => {
    const segment = { kind: "note", text: "x" };
    expect(parseStatusLineSegments(
        Array.from({ length: MAX_STATUS_LINE_SEGMENTS }, () => segment),
    )).toHaveLength(MAX_STATUS_LINE_SEGMENTS);
    expect(parseStatusLineSegments(
        Array.from({ length: MAX_STATUS_LINE_SEGMENTS + 1 }, () => segment),
    )).toBeUndefined();
});
