import { expect, test } from "bun:test";
import { BoxRenderable, createCliRenderer, TextRenderable } from "@opentui/core";

import {
    refreshTuiExperimentalSlotVisibility,
    tuiExperimentalBottomInsetRows,
} from "../../clients/tui/experimental-tui-layout.ts";

test("experimental TUI layout reserves visible extension rows", async () => {
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
    });
    const transcriptTop = new BoxRenderable(renderer, { id: "top" });
    const transcriptBottom = new BoxRenderable(renderer, { id: "bottom" });
    const footer = new BoxRenderable(renderer, { id: "footer" });
    const composerAdornment = new BoxRenderable(renderer, { id: "adornment" });
    const overlay = new BoxRenderable(renderer, { id: "overlay" });
    try {
        const footerStack = new BoxRenderable(renderer, {
            id: "footer-stack",
            flexDirection: "column",
        });
        footerStack.add(new TextRenderable(renderer, {
            id: "footer-first",
            content: "first",
            height: 1,
        }));
        footerStack.add(new TextRenderable(renderer, {
            id: "footer-second",
            content: "second",
            height: 1,
        }));
        footer.add(footerStack);
        composerAdornment.add(new TextRenderable(renderer, {
            id: "adornment-text",
            content: "adornment",
            height: 1,
        }));
        overlay.add(new TextRenderable(renderer, {
            id: "overlay-text",
            content: "overlay",
            height: 1,
        }));

        refreshTuiExperimentalSlotVisibility({
            transcriptTop,
            transcriptBottom,
            footer,
            composerAdornment,
            overlay,
        });

        expect(footer.visible).toBe(true);
        expect(composerAdornment.visible).toBe(true);
        expect(overlay.visible).toBe(true);
        expect(tuiExperimentalBottomInsetRows(footer, composerAdornment)).toBe(3);
    } finally {
        for (const renderable of [
            transcriptTop,
            transcriptBottom,
            footer,
            composerAdornment,
            overlay,
        ]) {
            renderable.destroy();
        }
        renderer.destroy();
    }
});

test("experimental TUI layout hides empty slots and ignores hidden children", async () => {
    const renderer = await createCliRenderer({
        exitOnCtrlC: false,
        targetFps: 30,
    });
    const transcriptTop = new BoxRenderable(renderer, { id: "top" });
    const transcriptBottom = new BoxRenderable(renderer, { id: "bottom" });
    const footer = new BoxRenderable(renderer, { id: "footer" });
    const composerAdornment = new BoxRenderable(renderer, { id: "adornment" });
    const overlay = new BoxRenderable(renderer, { id: "overlay" });
    try {
        footer.add(new TextRenderable(renderer, {
            id: "hidden-footer",
            content: "hidden",
            height: 4,
            visible: false,
        }));
        refreshTuiExperimentalSlotVisibility({
            transcriptTop,
            transcriptBottom,
            footer,
            composerAdornment,
            overlay,
        });
        expect(footer.visible).toBe(false);
        expect(composerAdornment.visible).toBe(false);
        expect(overlay.visible).toBe(false);
        expect(tuiExperimentalBottomInsetRows(footer, composerAdornment)).toBe(0);
    } finally {
        for (const renderable of [
            transcriptTop,
            transcriptBottom,
            footer,
            composerAdornment,
            overlay,
        ]) {
            renderable.destroy();
        }
        renderer.destroy();
    }
});
