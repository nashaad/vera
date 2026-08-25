import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiSessionCloseConfirmView,
    handleTuiSessionCloseConfirmKey,
} from "../../clients/tui/session-close-confirm.ts";

test("session close requires the explicit numbered confirmation", () => {
    expect(handleTuiSessionCloseConfirmKey({ name: "1" })).toBe("confirm");
    expect(handleTuiSessionCloseConfirmKey({ name: "1", ctrl: true }))
        .toBeUndefined();
    expect(handleTuiSessionCloseConfirmKey({ name: "1", shift: true }))
        .toBeUndefined();
    expect(handleTuiSessionCloseConfirmKey({ name: "enter" })).toBeUndefined();
    expect(handleTuiSessionCloseConfirmKey({ name: "escape" })).toBe("cancel");
});

test("session close confirmation names the in-flight conversation", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const view = createTuiSessionCloseConfirmView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update("Continue the theme picker");
    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Stop this conversation?");
        expect(frame).toContain("Continue the theme picker");
        expect(frame).toContain("[1] close");
        expect(frame).toContain("[esc] keep running");
    } finally {
        setup.renderer.destroy();
    }
});
