import { expect, test } from "bun:test";

import {
    copyTuiText,
    countTuiCharacters,
} from "../../clients/tui/clipboard.ts";

test("TUI clipboard uses terminal OSC52 support when available", async () => {
    const copied: string[] = [];

    await copyTuiText("selected text", {
        copyToClipboardOSC52(text): boolean {
            copied.push(text);
            return true;
        },
    });

    expect(copied).toEqual(["selected text"]);
});

test("TUI character count treats a Unicode code point as one character", () => {
    expect(countTuiCharacters("Vera ✨")).toBe(6);
});
