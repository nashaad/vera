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
    }, {
        platform: "linux",
    });

    expect(copied).toEqual(["selected text"]);
});

test("TUI clipboard prefers native copy on macOS", async () => {
    const nativeCopies: string[] = [];
    const osc52Copies: string[] = [];

    await copyTuiText("selected text", {
        copyToClipboardOSC52(text): boolean {
            osc52Copies.push(text);
            return true;
        },
    }, {
        platform: "darwin",
        nativeClipboard: {
            async copy(text): Promise<void> {
                nativeCopies.push(text);
            },
        },
    });

    expect(nativeCopies).toEqual(["selected text"]);
    expect(osc52Copies).toEqual([]);
});

test("TUI clipboard falls back to OSC52 when native copy fails", async () => {
    const osc52Copies: string[] = [];

    await copyTuiText("selected text", {
        copyToClipboardOSC52(text): boolean {
            osc52Copies.push(text);
            return true;
        },
    }, {
        platform: "darwin",
        nativeClipboard: {
            async copy(): Promise<void> {
                throw new Error("pbcopy unavailable");
            },
        },
    });

    expect(osc52Copies).toEqual(["selected text"]);
});

test("TUI character count treats a Unicode code point as one character", () => {
    expect(countTuiCharacters("Vera ✨")).toBe(6);
});
