import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";

import {
    createTuiSessionTrashConfirmView,
    handleTuiSessionTrashConfirmKey,
} from "../../clients/tui/session-trash-confirm.ts";

test("session trash requires the explicit numbered confirmation", () => {
    expect(handleTuiSessionTrashConfirmKey({ name: "1" })).toBe("confirm");
    expect(handleTuiSessionTrashConfirmKey({ name: "1", ctrl: true }))
        .toBeUndefined();
    expect(handleTuiSessionTrashConfirmKey({ name: "1", shift: true }))
        .toBeUndefined();
    expect(handleTuiSessionTrashConfirmKey({ name: "enter" })).toBeUndefined();
    expect(handleTuiSessionTrashConfirmKey({ name: "escape" })).toBe("cancel");
});

test("session trash confirmation names the recoverable conversation", async () => {
    const setup = await createTestRenderer({ width: 80, height: 24 });
    const view = createTuiSessionTrashConfirmView(setup.renderer);
    setup.renderer.root.add(view.box);
    view.box.visible = true;
    view.update("Continue the theme picker");
    try {
        await setup.flush();
        const frame = setup.captureCharFrame();
        expect(frame).toContain("Move conversation to Trash?");
        expect(frame).toContain("Continue the theme picker");
        expect(frame).toContain("[1] move to Trash");
    } finally {
        setup.renderer.destroy();
    }
});
