import { expect, test } from "bun:test";
import { parseColor } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import { stopAndCreateDescription } from "../../clients/tui/background-command-count.ts";
import { TUI_ACCENT, TUI_SELECTION_TEXT } from "../../clients/tui/state.ts";
import {
    createTuiSettingsPickerView,
    handleTuiSettingsPickerKey,
    startTuiCreateLeavePicker,
    startTuiSessionClosePicker,
    startTuiSessionPicker,
} from "../../clients/tui/settings-picker.ts";

const session = {
    id: "other-session",
    workspace: "/work",
    session_path: "/sessions/other.jsonl",
    kind: "interactive" as const,
    status: "idle" as const,
    live: false,
    title: "Other conversation",
};

test("@core close-picker keys choose or cancel", () => {
    const picker = startTuiSessionClosePicker("A conversation", 1);
    expect(handleTuiSettingsPickerKey(picker, { name: "1" }).selection)
        .toEqual({ kind: "session_close", sourceDisposition: "stop" });
    expect(handleTuiSettingsPickerKey(picker, { name: "2" }).selection)
        .toEqual({ kind: "session_close", sourceDisposition: "keep_running" });
    expect(handleTuiSettingsPickerKey(picker, { name: "escape" }))
        .toEqual({ handled: true });
    expect(handleTuiSettingsPickerKey(picker, { name: "enter" }).selection)
        .toEqual({ kind: "session_close", sourceDisposition: "stop" });
    const second = handleTuiSettingsPickerKey(picker, { name: "down" }).state!;
    expect(handleTuiSettingsPickerKey(second, { name: "enter" }).selection)
        .toEqual({ kind: "session_close", sourceDisposition: "keep_running" });
    expect(handleTuiSettingsPickerKey(picker, { name: "1", ctrl: true }).handled)
        .toBe(false);
});

test("@core new-conversation leave digits choose immediately", () => {
    const picker = startTuiCreateLeavePicker();
    expect(handleTuiSettingsPickerKey(picker, { name: "1" }).selection)
        .toEqual({ kind: "session_create_leave", sourceDisposition: "stop" });
    expect(handleTuiSettingsPickerKey(picker, { name: "2" }).selection)
        .toEqual({ kind: "session_create_leave", sourceDisposition: "keep_running" });
    expect(handleTuiSettingsPickerKey(picker, { name: "1", ctrl: true }).selection)
        .toBeUndefined();
});

test("@core close-picker descriptions and padding fit both target sizes", async () => {
    for (const [width, height] of [[80, 24], [120, 36]] as const) {
        for (const count of [0, 1, 2]) {
            const setup = await createTestRenderer({ width, height });
            const view = createTuiSettingsPickerView(setup.renderer);
            setup.renderer.root.add(view.surface);
            view.surface.visible = true;
            try {
                view.update(startTuiSessionClosePicker("The crow's chart", count));
                await setup.flush();
                const frame = setup.captureCharFrame();
                const lines = frame.split("\n");
                const heading = lines.findIndex((line) => line.includes("Close The crow's chart"));
                const stop = lines.findIndex((line) => line.includes("1. Stop & close"));
                const keep = lines.findIndex((line) => line.includes("2. Keep running"));
                const footer = lines.findIndex((line) => line.includes("1/2 close"));
                expect(heading).toBeGreaterThan(0);
                expect(stop - heading).toBeGreaterThan(1);
                expect(keep).toBeGreaterThan(stop);
                expect(footer).toBeGreaterThan(keep);
                expect(footer).toBeLessThan(height - 1);
                expect(lines[keep]).toContain("leave it open");
                expect(frame).toContain("↑↓ choose · ⏎ close · esc back");
                const description = lines.slice(stop, keep).join(" ").replace(/\s+/g, " ");
                const expected = count === 0
                    ? "stop this conversation and its running turn"
                    : `stop this conversation and its ${count} background command${count === 1 ? "" : "s"}`;
                expect(description).toContain(expected);
                const descriptionColumn = lines[stop]!.indexOf("stop this conversation");
                expect(descriptionColumn).toBeGreaterThan(lines[stop]!.indexOf("1. Stop & close"));
                for (const continuation of lines.slice(stop + 1, keep)) {
                    if (continuation.trim().length === 0) continue;
                    expect(continuation.search(/\S/)).toBe(descriptionColumn);
                }
                for (const index of [heading, stop, keep, footer]) {
                    expect(lines[index]!.search(/\S/)).toBeGreaterThan(0);
                    expect(lines[index]!.trimEnd().length).toBeLessThan(width);
                }
            } finally {
                setup.renderer.destroy();
            }
        }
    }
});

test("@core leave descriptions wrap with their count at target sizes", async () => {
    for (const [width, height] of [[80, 24], [120, 36]] as const) {
        for (const kind of ["switch", "create"] as const) {
            for (const count of [0, 1, 2]) {
                const setup = await createTestRenderer({ width, height });
                const view = createTuiSettingsPickerView(setup.renderer);
                setup.renderer.root.add(view.surface);
                view.surface.visible = true;
                try {
                    const source = startTuiSessionPicker([session], "current-session", false);
                    const switched = handleTuiSettingsPickerKey(
                        { ...source, backgroundCommandCount: count }, { name: "enter" },
                    ).state!;
                    const created = startTuiCreateLeavePicker();
                    const options = created.options.map((option) => count > 0 && option.value === "stop"
                        ? { ...option, description: stopAndCreateDescription(count) } : option);
                    const state = kind === "switch" ? switched
                        : { ...created, backgroundCommandCount: count, options, allOptions: options };
                    view.update(state);
                    await setup.flush();
                    const frame = setup.captureCharFrame();
                    const lines = frame.split("\n");
                    const row = lines.findIndex((line) => line.includes("1. "));
                    const keep = lines.findIndex((line) => line.includes("2. "));
                    expect(row).toBeGreaterThan(0);
                    expect(keep).toBeGreaterThan(row);
                    expect(keep).toBeLessThan(height - 1);
                    const selected = setup.captureSpans().lines[row]!.spans
                        .find((span) => span.text.includes("1. "))!;
                    expect(selected.fg.toInts()).toEqual(parseColor(TUI_SELECTION_TEXT).toInts());
                    expect(selected.bg.toInts()).toEqual(parseColor(TUI_ACCENT).toInts());
                    if (count === 0) {
                        expect(frame).not.toContain("background command");
                    } else {
                        const words = lines.slice(row, keep).join(" ").replace(/\s+/g, " ");
                        const commands = `${count} background command${count === 1 ? "" : "s"}`;
                        const expected = kind === "switch"
                            ? `stop this conversation and its ${commands}, then open the one you picked`
                            : `stop it and its ${commands}, then start a new one`;
                        expect(words).toContain(expected);
                        const description = kind === "switch" ? "stop this conversation" : "stop it and its";
                        const descriptionColumn = lines[row]!.indexOf(description);
                        expect(descriptionColumn).toBeGreaterThan(0);
                        for (const continuation of lines.slice(row + 1, keep)) {
                            if (continuation.trim().length === 0) continue;
                            expect(continuation.search(/\S/)).toBe(descriptionColumn);
                        }
                    }
                } finally {
                    setup.renderer.destroy();
                }
            }
        }
    }
});

test("@core switch-leave digits choose immediately and preserve the target", () => {
    const picker = startTuiSessionPicker([session], "current-session", false);
    const leave = handleTuiSettingsPickerKey(picker, { name: "enter" }).state!;
    expect(leave.kind).toBe("session_leave");
    expect(handleTuiSettingsPickerKey(leave, { name: "1" }).selection)
        .toMatchObject({
            kind: "session",
            sessionPath: "/sessions/other.jsonl",
            sessionId: "other-session",
            sourceDisposition: "stop",
        });
    expect(handleTuiSettingsPickerKey(leave, { name: "2" }).selection)
        .toMatchObject({
            kind: "session",
            sessionPath: "/sessions/other.jsonl",
            sourceDisposition: "keep_running",
        });
});
