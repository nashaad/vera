import { expect, test } from "bun:test";

import {
    findTuiExperimentalKeybinding,
    tuiExperimentalKeyEvent,
} from "../../clients/tui/experimental-tui-input.ts";

test("experimental TUI input normalizes keys and finds bindings", () => {
    const key = {
        name: "o",
        ctrl: true,
        shift: true,
        meta: false,
    };
    expect(tuiExperimentalKeyEvent(key)).toEqual({
        chord: "ctrl+shift+o",
        name: "o",
        ctrl: true,
        shift: true,
        meta: false,
    });
    expect(findTuiExperimentalKeybinding(key, [
        { keys: ["ctrl+shift+o"], action: "open" },
    ])?.action).toBe("open");
});

test("experimental TUI input leaves unsupported modifier keys unbound", () => {
    const key = { name: "o", meta: true };
    expect(tuiExperimentalKeyEvent(key).chord).toBe("o");
    expect(findTuiExperimentalKeybinding(key, [
        { keys: ["o"], action: "open" },
    ])).toBeUndefined();
});
