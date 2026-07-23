import { expect, test } from "bun:test";

import {
    parseExtensionCommandBody,
    parseExtensionCommandDeclarations,
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

test("command declarations reject duplicate names and handler IDs", () => {
    const declaration = {
        handlerId: "command:1",
        kind: "command",
        name: "hello",
        spec: {
            description: "Say hello",
            usage: "/hello",
        },
    } as const;

    expect(parseExtensionCommandDeclarations([declaration])).toEqual([
        declaration,
    ]);
    expect(parseExtensionCommandDeclarations([
        declaration,
        { ...declaration, handlerId: "command:2" },
    ])).toBeUndefined();
    expect(parseExtensionCommandDeclarations([
        declaration,
        { ...declaration, name: "other" },
    ])).toBeUndefined();
});
