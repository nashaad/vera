import { expect, test } from "bun:test";

import {
    parseExtensionCommandBody,
    parseExtensionCommandResult,
    type ExtensionCommandResult,
} from "../../src/extensions/commands.ts";

test("command bodies accept only text and attributed notice content", () => {
    expect(parseExtensionCommandBody({
        kind: "text",
        text: "hello",
    })).toEqual({
        kind: "text",
        text: "hello",
    });
    expect(parseExtensionCommandBody({
        kind: "notice",
        level: "warning",
        text: "careful",
    })).toEqual({
        kind: "notice",
        level: "warning",
        text: "careful",
    });
    expect(parseExtensionCommandBody({
        kind: "action",
        text: "unsupported",
    })).toBeUndefined();
    expect(parseExtensionCommandBody({
        kind: "text",
        text: "",
    })).toBeUndefined();
    expect(parseExtensionCommandBody({
        kind: "text",
        text: "hello",
        source: "spoofed",
    })).toBeUndefined();
});

test("command results preserve scalar session state and reject invalid values", () => {
    const result: ExtensionCommandResult = { version: 1, source: "test/value", body: { kind: "text", text: "saved" },
        extensionState: { test: { amount: 3, enabled: true } } };
    expect(parseExtensionCommandResult(result)).toEqual(result);
    expect(parseExtensionCommandResult({ ...result, extensionState: { test: { amount: NaN } } })).toBeUndefined();
    expect(parseExtensionCommandResult({ ...result, extensionState: { test: { nested: {} } } })).toBeUndefined();
});
