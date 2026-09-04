import { expect, test } from "bun:test";
import { RGBA, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiOverridesResetConfirmView,
    handleTuiOverridesResetConfirmKey,
    tuiOverridesResetLevers,
} from "../../clients/tui/overrides-reset-confirm.ts";
import { applyTuiThemeBindings } from "../../clients/tui/theme-bindings.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";
import { overrideRows } from "../../src/engine/override-rows.ts";

test("clearing every lever requires the explicit numbered confirmation", () => {
    expect(handleTuiOverridesResetConfirmKey({ name: "1" })).toBe("confirm");
    expect(handleTuiOverridesResetConfirmKey({ name: "1", ctrl: true }))
        .toBeUndefined();
    expect(handleTuiOverridesResetConfirmKey({ name: "1", shift: true }))
        .toBeUndefined();
    // Enter is the key that opened the card, so it must not also answer it.
    expect(handleTuiOverridesResetConfirmKey({ name: "enter" })).toBeUndefined();
    expect(handleTuiOverridesResetConfirmKey({ name: "y" })).toBeUndefined();
    expect(handleTuiOverridesResetConfirmKey({ name: "escape" })).toBe("cancel");
});

test("only the levers actually set are named, in the order the pane lists them", () => {
    const rows = overrideRows({
        toolResultCeilingBytes: 16_384,
        compactionTriggerFraction: 0.7,
    }, 200_000);

    expect(tuiOverridesResetLevers(rows))
        .toEqual(["Compaction trigger", "Tool result ceiling"]);
});

test("a config with nothing set names nothing", () => {
    expect(tuiOverridesResetLevers(overrideRows({}, 200_000))).toEqual([]);
});

test("the card names what is about to be cleared", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const view = createTuiOverridesResetConfirmView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(["Compaction trigger", "Tool result ceiling"]);
    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Reset every override to its default?");
        expect(frame).toContain("2 set: Compaction trigger, Tool result ceiling");
        expect(frame).toContain("[1] reset");
        expect(frame).toContain("[esc] keep them");
    } finally {
        setup.renderer.destroy();
    }
});

test("one lever reads as a sentence, not as a count of one", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const view = createTuiOverridesResetConfirmView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update(["Aging level"]);
    try {
        await setup.flush();
        expect(setup.captureCharFrame()).toContain("Aging level is set.");
    } finally {
        setup.renderer.destroy();
    }
});

test("the card repaints from its declarative bindings", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const view = createTuiOverridesResetConfirmView(setup.renderer);
    const nextTheme = {
        ...VERA_TUI_THEME,
        notice: "#123456",
        text: "#234567",
        muted: "#345678",
        panel: "#456789",
    };
    try {
        applyTuiThemeBindings(nextTheme, view.themeBindings);
        const text = view.box.getChildren() as TextRenderable[];

        expect(text[0]?.fg.toInts())
            .toEqual(RGBA.fromHex(nextTheme.notice).toInts());
        expect(text[1]?.fg.toInts())
            .toEqual(RGBA.fromHex(nextTheme.text).toInts());
        expect(text[2]?.fg.toInts())
            .toEqual(RGBA.fromHex(nextTheme.muted).toInts());
        expect(view.box.backgroundColor.toInts())
            .toEqual(RGBA.fromHex(nextTheme.panel).toInts());
    } finally {
        setup.renderer.destroy();
    }
});
