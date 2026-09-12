import { expect, test } from "bun:test";
import { BoxRenderable, RGBA, TextareaRenderable, TextRenderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { configureDialogSearch, createDialogSearchNode, refreshDialogSearch, updateDialogSearchNode } from "../../clients/tui/dialog-search.ts";
import { applyTuiTheme, TUI_ELEMENT } from "../../clients/tui/palette.ts";
import { VERA_TUI_THEME } from "../../clients/tui/theme.ts";
import { tuiTextareaKey } from "../../clients/tui/single-line-editor.ts";

test("search border and fill are exclusive and preserve native editing and geometry", async () => {
    for (const width of [24, 80]) for (const height of [20, 40]) {
        const setup = await createTestRenderer({ width, height });
        configureDialogSearch(setup.renderer, "border");
        const card = new BoxRenderable(setup.renderer, { width: "100%", padding: 2, backgroundColor: "#123456" });
        const search = createDialogSearchNode(setup.renderer, "test-search");
        const before = new TextRenderable(setup.renderer, { content: "Before", height: 1 });
        const after = new TextRenderable(setup.renderer, { content: "After", height: 1 });
        card.add(before);
        card.add(search.box);
        card.add(after);
        setup.renderer.root.add(card);
        try {
            updateDialogSearchNode(search, "needle", "Search models");
            search.editor.focus();
            await setup.renderOnce();
            const geometry = [search.box.screenX, search.box.screenY, search.box.width, search.box.height,
                search.editor.screenX, search.editor.screenY, search.editor.width];
            const frame = setup.captureCharFrame();
            expect(search.box.screenY).toBe(before.screenY + before.height + 1);
            expect(after.screenY).toBe(search.box.screenY + search.box.height + 1);
            expect(frame).toContain("┌");
            expect(frame).toContain("└");
            expect(frame).toContain("│ needle");
            expect(search.editor).toBeInstanceOf(TextareaRenderable);
            expect(search.box.backgroundColor.a).toBe(0);
            const content = () => setup.captureSpans().lines[search.editor.screenY]!.spans
                .find((span) => span.text.includes("needle"))!;
            expect(content().bg.toInts()).toEqual(RGBA.fromHex("#123456").toInts());
            configureDialogSearch(setup.renderer, "fill");
            await setup.renderOnce();
            expect(setup.captureCharFrame()).not.toMatch(/[┌┐└┘│─]/);
            expect(after.screenY).toBe(search.box.screenY + search.box.height + 1);
            expect([search.box.screenX, search.box.screenY, search.box.width, search.box.height,
                search.editor.screenX, search.editor.screenY, search.editor.width]).toEqual(geometry);
            expect(content().bg.toInts()).toEqual(RGBA.fromHex(TUI_ELEMENT).toInts());
            search.editor.handleKeyPress(tuiTextareaKey({ name: "left" }));
            search.editor.handleKeyPress(tuiTextareaKey({ name: "x", sequence: "x" }));
            expect(search.editor.plainText).toBe("needlxe");
            const cursor = search.editor.cursorOffset;
            configureDialogSearch(setup.renderer, "border");
            expect(search.editor.plainText).toBe("needlxe");
            expect(search.editor.cursorOffset).toBe(cursor);
            expect(search.editor.focused).toBe(true);
            configureDialogSearch(setup.renderer, "plain");
            await setup.renderOnce();
            expect(search.box.height).toBe(1);
            expect(search.box.screenY).toBe(before.screenY + before.height + 1);
            expect(search.editor.screenX).toBe(search.box.screenX);
            expect(search.editor.screenY).toBe(search.box.screenY);
            expect(after.screenY).toBe(search.box.screenY + 2);
            expect(search.box.backgroundColor.a).toBe(0);
            expect(setup.captureCharFrame()).not.toMatch(/[┌┐└┘│─]/);
            expect(search.editor.plainText).toBe("needlxe");
            expect(search.editor.cursorOffset).toBe(cursor);
            expect(search.editor.focused).toBe(true);
            configureDialogSearch(setup.renderer, "fill");
            await setup.renderOnce();
            expect([search.box.screenX, search.box.screenY, search.box.width, search.box.height,
                search.editor.screenX, search.editor.screenY, search.editor.width]).toEqual(geometry);
        } finally { setup.renderer.destroy(); }
    }
});

test("search styles belong to their renderer and repaint with the theme", async () => {
    const first = await createTestRenderer({ width: 50, height: 20 });
    const second = await createTestRenderer({ width: 50, height: 20 });
    const a = createDialogSearchNode(first.renderer, "first-search");
    const b = createDialogSearchNode(second.renderer, "second-search");
    first.renderer.root.add(a.box);
    second.renderer.root.add(b.box);
    try {
        configureDialogSearch(second.renderer, "border");
        applyTuiTheme({ ...VERA_TUI_THEME, element: "#224466" });
        refreshDialogSearch();
        await first.renderOnce();
        await second.renderOnce();
        expect(a.box.backgroundColor.toInts()).toEqual(RGBA.fromHex("#224466").toInts());
        expect(b.box.backgroundColor.a).toBe(0);
        expect(first.captureCharFrame()).not.toContain("┌");
        expect(second.captureCharFrame()).toContain("┌");
    } finally {
        first.renderer.destroy(); second.renderer.destroy();
        applyTuiTheme(VERA_TUI_THEME); refreshDialogSearch();
    }
});
