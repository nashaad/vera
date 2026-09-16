import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { TUI_ACCENT, TUI_MUTED, TUI_SELECTION_TEXT } from "../../clients/tui/state.ts";
import { createTestRenderer } from "@opentui/core/testing";
import {
    createTuiSettingsPickerView, handleTuiExtensionPickerKey, moveTuiSettingsPickerPointer,
    startTuiExtensionPicker, type TuiExtensionPickerState,
} from "../../clients/tui/settings-picker.ts";

function providers(): TuiExtensionPickerState {
    return startTuiExtensionPicker("Search providers", [
        { id: "brave", label: "Brave", meta: "Enabled", details: ["Brave", "", "Status: Enabled", "Key: Environment: BRAVE_API_KEY", "Fallback position: 1"] },
        { id: "duckduckgo", label: "DuckDuckGo", meta: "Enabled", details: ["DuckDuckGo", "", "No key required", "Fallback position: 2"] },
    ], "brave", [
        { id: "open", label: "manage", key: "enter" },
        { id: "connect", label: "Connect provider", key: "enter", button: true },
    ], "Search tries enabled providers from top to bottom.", false, { layout: "list-detail" });
}

test("provider sections preserve the highlighted provider while actions take focus", () => {
    let state = providers();
    state = handleTuiExtensionPickerKey(state, { name: "down" }).state!;
    state = handleTuiExtensionPickerKey(state, { name: "tab" }).state!;
    expect(state.focusedButton).toBe(0);
    expect(handleTuiExtensionPickerKey(state, { name: "return" }).selection).toMatchObject({ actionId: "connect", rowId: "duckduckgo" });
    state = handleTuiExtensionPickerKey(state, { name: "down" }).state!;
    expect(state.searchFocused).toBe(false);
    expect(state.focusedButton).toBeUndefined();
    state = handleTuiExtensionPickerKey(state, { name: "tab", shift: true }).state!;
    expect(state.focusedButton).toBe(0);
    expect(moveTuiSettingsPickerPointer(state, 0)).toMatchObject({ selectedIndex: 0, focusedButton: undefined, searchFocused: false });
    expect(moveTuiSettingsPickerPointer(state, -2)).toMatchObject({ focusedButton: 0 });
    expect(handleTuiExtensionPickerKey(state, { name: "escape" }).state).toBeUndefined();
});

for (const [width, height] of [[120, 36], [80, 24], [60, 24]] as const) {
    test(`provider layout keeps its actions and navigation visible at ${width}x${height}`, async () => {
        const setup = await createTestRenderer({ width, height });
        try {
            const view = createTuiSettingsPickerView(setup.renderer);
            setup.renderer.root.add(view.surface);
            view.surface.visible = true;
            view.update(providers());
            await setup.flush();
            const frame = setup.captureCharFrame();
            expect(frame).toContain("Connect provider");
            expect(frame.match(/Search providers/g)).toHaveLength(1);
            expect(frame).not.toContain("Manage provider");
            expect(frame).toContain("Tab sections");
            expect(frame).toContain("Fallback position: 1");
            expect(frame).toContain("› Brave");
            if (width > 60) expect(frame).toContain("› DuckDuckGo");
            expect(frame).not.toContain("1. Brave");
            if (width === 120) {
                expect(frame).toContain("│");
                const lines = frame.split("\n");
                const braveY = lines.findIndex((line) => line.includes("› Brave"));
                const duckY = lines.findIndex((line) => line.includes("› DuckDuckGo"));
                const caretX = lines[braveY]!.indexOf("›");
                const cells = (y: number) => setup.captureSpans().lines[y]!.spans.flatMap((span) =>
                    Array.from({ length: span.text.length }, () => ({ fg: span.fg.toInts(), bg: span.bg.toInts() })));
                expect(lines[duckY]!.indexOf("›")).toBe(caretX);
                const selected = cells(braveY);
                expect(selected[caretX]!.bg).toEqual(RGBA.fromHex(TUI_ACCENT).toInts());
                expect(selected[caretX - 1]!.bg).toEqual(selected[caretX]!.bg);
                expect(selected[caretX + 2]!.bg).toEqual(selected[caretX]!.bg);
                expect(selected[caretX]!.fg).toEqual(RGBA.fromHex(TUI_SELECTION_TEXT).toInts());
                expect(cells(duckY)[caretX]!.fg).toEqual(RGBA.fromHex(TUI_MUTED).toInts());
                view.update({ ...providers(), selectedIndex: 1 });
                await setup.flush();
                expect(setup.captureCharFrame()).toContain("› Brave");
                expect(cells(braveY)[caretX]!.fg).toEqual(RGBA.fromHex(TUI_MUTED).toInts());
                expect(cells(duckY)[caretX]!.fg).toEqual(RGBA.fromHex(TUI_SELECTION_TEXT).toInts());
            }
        } finally { setup.renderer.destroy(); }
    });
}

test("provider actions separate groups with gaps and put verification help below the list", async () => {
    const setup = await createTestRenderer({ width: 100, height: 36 });
    try {
        const view = createTuiSettingsPickerView(setup.renderer);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        view.update(startTuiExtensionPicker("Manage Exa", [
            { id: "key", label: "Set API key", group: "key" },
            { id: "verify", label: "Verify", group: "key", details: ["Runs one search for “Vera search test”.", "API charges may apply."] },
            { id: "remove-key", label: "Remove saved key", group: "key" },
            { id: "up", label: "Move up", group: "order" },
            { id: "down", label: "Move down", group: "order" },
            { id: "toggle", label: "Disable", group: "state" },
            { id: "remove", label: "Remove provider", group: "state" },
        ], "verify", [{ id: "open", label: "open", key: "enter" }], "Saved key.", false, { layout: "menu" }));
        await setup.flush();
        const frame = setup.captureCharFrame();
        const lines = frame.split("\n").map((line) => line.trim().replace(/^› /, ""));
        expect(lines[lines.indexOf("Set API key") + 1]).toBe("Verify");
        expect(lines[lines.indexOf("Verify") + 1]).toBe("Remove saved key");
        expect(lines[lines.indexOf("Remove saved key") + 1]).toBe("");
        expect(lines[lines.indexOf("Disable") + 1]).toBe("Remove provider");
        expect(lines[lines.indexOf("Move up") + 1]).toBe("Move down");
        expect(lines[lines.indexOf("Move down") + 1]).toBe("");
        expect(frame).toContain("Runs one search for “Vera search test”.");
        expect(frame).toContain("API charges may apply.");
    } finally { setup.renderer.destroy(); }
});
