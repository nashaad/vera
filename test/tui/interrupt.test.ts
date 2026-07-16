import { expect, test } from "bun:test";

import { tuiInterruptAction } from "../../clients/tui/interrupt.ts";

test("Ctrl+C aborts a working TUI turn once", () => {
    const key = { name: "c", ctrl: true };

    expect(tuiInterruptAction(key, true, false)).toBe("abort");
    expect(tuiInterruptAction(key, true, true)).toBe("consume");
});

test("Ctrl+C quits the TUI while idle", () => {
    expect(tuiInterruptAction({ name: "c", ctrl: true }, false, false))
        .toBe("quit");
});

test("other keys pass through TUI interrupt handling", () => {
    expect(tuiInterruptAction({ name: "x", ctrl: true }, true, false))
        .toBe("pass");
    expect(tuiInterruptAction({ name: "c", ctrl: false }, true, false))
        .toBe("pass");
});
