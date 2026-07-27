import { expect, test } from "bun:test";

import {
    parseExtensionCommandBody,
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
