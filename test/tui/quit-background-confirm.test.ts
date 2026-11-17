import { expect, test } from "bun:test";
import { RGBA } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import {
    handleTuiSettingsPickerKey,
    startTuiQuitConfirmPicker,
    createTuiSettingsPickerView,
    pickerFooter,
} from "../../clients/tui/settings-picker.ts";
import { TUI_MUTED, TUI_TEXT } from "../../clients/tui/state.ts";

const key = (name: string) => ({ name });

test("@core quit confirm keys stop, keep running, and cancel", () => {
    const state = startTuiQuitConfirmPicker(
        "2 background commands are running in this conversation.",
    );
    const stop = handleTuiSettingsPickerKey(state, key("1"));
    expect(stop.selection).toEqual({
        kind: "session_close",
        sourceDisposition: "stop",
    });

    const keep = handleTuiSettingsPickerKey(state, key("2"));
    expect(keep.selection).toEqual({
        kind: "session_close",
        sourceDisposition: "keep_running",
    });

    const cancel = handleTuiSettingsPickerKey(state, key("escape"));
    expect(cancel.handled).toBe(true);
    expect(cancel.state).toBeUndefined();
});

test("@core quit confirm arrows and Enter select the highlighted action", () => {
    const state = startTuiQuitConfirmPicker("1 background command is running.");
    const selected = handleTuiSettingsPickerKey(state, key("down"));
    expect(selected.state?.selectedIndex).toBe(1);
    expect(handleTuiSettingsPickerKey(selected.state!, key("enter")).selection)
        .toEqual({ kind: "session_close", sourceDisposition: "keep_running" });
});

for (const [width, height] of [[80, 24], [120, 36]] as const) {
    test(`@core quit confirmation renders with spacing at ${width}x${height}`, async () => {
        const setup = await createTestRenderer({ width, height });
        const view = createTuiSettingsPickerView(setup.renderer);
        const message = "3 background commands are running in 2 conversations.";
        const state = startTuiQuitConfirmPicker(message);
        setup.renderer.root.add(view.surface);
        view.surface.visible = true;
        view.update(state);
        try {
            await setup.flush();
            const frame = setup.captureCharFrame();
            const lines = frame.split("\n");
            const heading = lines.findIndex((line) => line.includes("Quit Vera"));
            const summary = lines.findIndex((line) => line.includes(message));
            const stop = lines.findIndex((line) => line.includes("1. Stop them and quit"));
            const keep = lines.findIndex((line) => line.includes("2. Keep running"));
            const footer = lines.findIndex((line) => line.includes("esc cancel"));
            expect(heading).toBeGreaterThan(0);
            expect(summary).toBeGreaterThan(heading);
            expect(stop - summary).toBe(2);
            expect(lines[summary + 1]!.trim()).toBe("");
            expect(keep).toBe(stop + 1);
            expect(lines[keep]).toMatch(/2\. Keep running\s{2,}stays up ten idle minutes, then stops/);
            const colors = setup.captureSpans().lines[keep]!.spans.flatMap((span) =>
                Array.from({ length: span.text.length }, () => span.fg.toInts()));
            expect(colors[lines[keep]!.indexOf("Keep running")]).toEqual(RGBA.fromHex(TUI_TEXT).toInts());
            expect(colors[lines[keep]!.indexOf("stays up")]).toEqual(RGBA.fromHex(TUI_MUTED).toInts());
            expect(footer).toBeGreaterThan(keep);
            for (const index of [heading, summary, stop, keep, footer]) {
                expect(lines[index]!.search(/\S/)).toBeGreaterThan(0);
                expect(lines[index]!.trimEnd().length).toBeLessThan(width);
            }
            expect(pickerFooter(state)).toContain("1/2 quit · ↑↓ choose · ⏎ quit · esc cancel");
            expect(view.box.screenY).toBeGreaterThan(0);
            expect(height - view.box.screenY - view.box.height).toBeGreaterThan(0);
            expect(view.box.screenX).toBeGreaterThan(0);
            expect(width - view.box.screenX - view.box.width).toBeGreaterThan(0);
        } finally {
            setup.renderer.destroy();
        }
    });
}
