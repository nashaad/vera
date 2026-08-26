import { expect, test } from "bun:test";

import {
    applyTuiThemeBindings,
    tuiThemeProperties,
} from "../../clients/tui/theme-bindings.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";

test("theme bindings paint declared roles and derived colors", () => {
    const target = {
        fg: "before",
        backgroundColor: "before",
        untouched: "before",
    };
    const theme = {
        ...VERA_TUI_THEME,
        text: "#111111",
        background: "#222222",
    };

    applyTuiThemeBindings(theme, [
        tuiThemeProperties(target, {
            fg: "text",
            backgroundColor: (active) => active.background,
        }),
    ]);

    expect(target).toEqual({
        fg: "#111111",
        backgroundColor: "#222222",
        untouched: "before",
    });
});

test("theme bindings run in declaration order", () => {
    const applied: string[] = [];

    applyTuiThemeBindings(VERA_TUI_THEME, [
        () => applied.push("state"),
        () => applied.push("renderables"),
        () => applied.push("repaint"),
    ]);

    expect(applied).toEqual(["state", "renderables", "repaint"]);
});

test("theme bindings reject a property missing from the target", () => {
    const binding = tuiThemeProperties(
        {} as { fg: string },
        { fg: "text" },
    );

    expect(() => binding(VERA_TUI_THEME)).toThrow(
        "Theme property fg is not present on its target",
    );
});

test("theme bindings reject a property that cannot be updated", () => {
    const target = Object.defineProperty({}, "fg", {
        value: "before",
        writable: false,
    }) as { fg: string };
    const binding = tuiThemeProperties(target, { fg: "text" });

    expect(() => binding(VERA_TUI_THEME)).toThrow(
        "Theme property fg could not be updated",
    );
});
