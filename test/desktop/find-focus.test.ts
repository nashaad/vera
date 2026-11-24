import { describe, expect, test } from "bun:test";
import { createContext, runInContext } from "node:vm";

import { finishFocus, rememberFocus, type FocusFrame } from "../../clients/desktop/src/find/focus.ts";

interface FocusElement {
    isConnected: boolean;
    focus(options: { preventScroll: boolean }): void;
}

function fixture(): { frame: FocusFrame; document: { activeElement: FocusElement | undefined }; original: FocusElement; calls: boolean[] } {
    const calls: boolean[] = [];
    const document: { activeElement: FocusElement | undefined } = { activeElement: undefined };
    const original: FocusElement = {
        isConnected: true,
        focus: (options) => { calls.push(options.preventScroll); document.activeElement = original; },
    };
    document.activeElement = original;
    const context = createContext({ document, WeakRef, Symbol, Date });
    const frame: FocusFrame = {
        isDestroyed: () => false,
        executeJavaScript: async (source) => runInContext(source, context),
    };
    return { frame, document, original, calls };
}

describe("find focus", () => {
    test("find restores the prior element without scrolling", async () => {
        const { frame, document, original, calls } = fixture();
        expect(await rememberFocus(frame, 1)).toBe(true);
        document.activeElement = undefined;
        await finishFocus(frame, 1, true);
        expect(document.activeElement as FocusElement | undefined).toBe(original);
        expect(calls).toEqual([true]);
    });

    test("find does not focus a detached element or after a background close", async () => {
        const { frame, document, original, calls } = fixture();
        expect(await rememberFocus(frame, 1)).toBe(true);
        original.isConnected = false;
        document.activeElement = undefined;
        await finishFocus(frame, 1, true);
        expect(calls).toEqual([]);
        original.isConnected = true;
        document.activeElement = original;
        expect(await rememberFocus(frame, 2)).toBe(true);
        document.activeElement = undefined;
        await finishFocus(frame, 2, false);
        expect(calls).toEqual([]);
    });

    test("find keeps a newer saved focus when an older request finishes", async () => {
        const { frame, document, original, calls } = fixture();
        expect(await rememberFocus(frame, 1)).toBe(true);
        expect(await rememberFocus(frame, 2)).toBe(true);
        document.activeElement = undefined;
        await finishFocus(frame, 1, true);
        expect(calls).toEqual([]);
        await finishFocus(frame, 2, true);
        expect(document.activeElement as FocusElement | undefined).toBe(original);
    });
});
