import { expect, test } from "bun:test";
import { RGBA, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiPermissionsConfirmView,
    handleTuiPermissionsConfirmKey,
} from "../../clients/tui/permissions-confirm.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";

test("full access requires an explicit confirmation", () => {
    expect(handleTuiPermissionsConfirmKey({ name: "1" })).toBe("confirm");
    expect(handleTuiPermissionsConfirmKey({ name: "enter" })).toBe("confirm");
    expect(handleTuiPermissionsConfirmKey({ name: "escape" })).toBe("cancel");
    expect(handleTuiPermissionsConfirmKey({ name: "2" })).toBeUndefined();
});

test("full-access confirmation colors follow the active theme", async () => {
    const setup = await createTestRenderer({ width: 100, height: 24 });
    const view = createTuiPermissionsConfirmView(
        setup.renderer,
        VERA_TUI_THEME,
    );
    const nextTheme = {
        ...VERA_TUI_THEME,
        critical: "#123456",
        dangerSurface: "#654321",
    };

    try {
        view.setTheme(nextTheme);
        const critical = RGBA.fromHex(nextTheme.critical).toInts();
        const children = view.box.getChildren();
        const title = children[0]!.getChildren()[1]!;
        for (const child of [title, ...children.slice(1)]) {
            expect((child as TextRenderable).fg.toInts()).toEqual(critical);
        }
        expect(view.box.backgroundColor.toInts()).toEqual(
            RGBA.fromHex(nextTheme.dangerSurface).toInts(),
        );
    } finally {
        setup.renderer.destroy();
    }
});
