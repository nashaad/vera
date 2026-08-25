import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import { createTuiComposer } from "../../clients/tui/composer.ts";
import {
    parseRawInputEvent,
    tuiInterruptAction,
} from "../../clients/tui/interrupt.ts";

test("raw TUI input identifies Ctrl+C before overlay handling", () => {
    expect(parseRawInputEvent({ name: "c", ctrl: true })).toEqual({
        type: "interrupt",
    });
    expect(parseRawInputEvent({ name: "c", ctrl: false })).toBeUndefined();
    expect(parseRawInputEvent({ name: "escape", ctrl: false })).toBeUndefined();
});

test("raw TUI input identifies Ctrl+P as the palette chord", () => {
    expect(parseRawInputEvent({ name: "p", ctrl: true })).toEqual({
        type: "open_palette",
    });
    // A bare p is composer text, so the chord has to carry ctrl.
    expect(parseRawInputEvent({ name: "p", ctrl: false })).toBeUndefined();
});

test("Ctrl+C aborts a working TUI turn once", () => {
    const key = { name: "c", ctrl: true };

    expect(tuiInterruptAction(key, true, false)).toBe("abort");
    expect(tuiInterruptAction(key, true, true)).toBe("quit");
});

test("Ctrl+C quits while a stop is already in flight", () => {
    const key = { name: "c", ctrl: true };

    expect(tuiInterruptAction(key, true, true)).toBe("quit");
    expect(tuiInterruptAction(key, false, true, true)).toBe("quit");
});

test("Ctrl+C quits the TUI while idle", () => {
    expect(tuiInterruptAction({ name: "c", ctrl: true }, false, false))
        .toBe("quit");
});

test("Escape aborts a working TUI turn and passes while idle", () => {
    const key = { name: "escape", ctrl: false };

    expect(tuiInterruptAction(key, true, false)).toBe("abort");
    expect(tuiInterruptAction(key, true, true)).toBe("consume");
    expect(tuiInterruptAction(key, false, false)).toBe("pass");
});

test("Escape aborts a manual compaction while no turn is working", () => {
    const key = { name: "escape", ctrl: false };
    expect(tuiInterruptAction(key, false, false, true)).toBe("abort");
    expect(tuiInterruptAction(key, false, true, true)).toBe("consume");
});

test("OpenTUI reports Escape as a TUI abort", async () => {
    const setup = await createTestRenderer({
        width: 20,
        height: 5,
        kittyKeyboard: true,
    });
    const actions: string[] = [];
    const composer = createTuiComposer(setup.renderer, () => {});
    setup.renderer.root.add(composer);
    composer.focus();
    setup.renderer.keyInput.on("keypress", (key) => {
        const action = tuiInterruptAction(key, true, false);
        if (action !== "pass") {
            actions.push(action);
        }
    });

    try {
        await setup.mockInput.typeText("redirect this");
        setup.mockInput.pressEscape();
        await setup.flush();

        expect(actions).toEqual(["abort"]);
        expect(composer.plainText).toBe("redirect this");
    } finally {
        setup.renderer.destroy();
    }
});

test("other keys pass through TUI interrupt handling", () => {
    expect(tuiInterruptAction({ name: "x", ctrl: true }, true, false))
        .toBe("pass");
    expect(tuiInterruptAction({ name: "c", ctrl: false }, true, false))
        .toBe("pass");
    expect(tuiInterruptAction({
        name: "escape",
        ctrl: false,
        meta: true,
    }, true, false)).toBe("pass");
});
