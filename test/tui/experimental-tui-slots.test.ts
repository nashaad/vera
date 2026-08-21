import { expect, test } from "bun:test";
import { createCliRenderer } from "@opentui/core";

import { createTuiExperimentalSlotRegistry } from "../../clients/tui/experimental-tui-slots.ts";
import { DIALOG_CARD_Z_INDEX } from "../../clients/tui/dialog-chrome.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";

test("experimental TUI slots route and destroy client-owned regions", async () => {
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
    });
    const registry = createTuiExperimentalSlotRegistry({
        renderer,
        theme: VERA_TUI_THEME,
    });
    try {
        expect(registry.slotFor("footer")).toBe(registry.footer);
        expect(registry.slotFor("overlay")).toBe(registry.overlay);
        expect(registry.footer.id).toBe("experimental-tui-footer");
        expect(registry.overlay.zIndex).toBe(DIALOG_CARD_Z_INDEX - 1);
    } finally {
        registry.destroy();
        renderer.destroy();
    }
});
