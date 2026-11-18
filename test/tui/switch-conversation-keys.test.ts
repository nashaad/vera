import { expect, test } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import {
    createTuiSettingsPickerView,
    handleTuiSettingsPickerKey,
    startTuiSessionPicker,
    type TuiSettingsPickerKey,
} from "../../clients/tui/settings-picker.ts";

function switchPicker(sessionId = true) {
    const browser = startTuiSessionPicker([{
        id: "target-session-id",
        workspace: "/work/alpha",
        session_path: "/sessions/target.jsonl",
        kind: "interactive",
        status: "idle",
        live: false,
        title: "A target with 2 in the title",
    }]);
    const index = browser.options.findIndex((option) => option.value === "/sessions/target.jsonl");
    const parent = {
        ...browser,
        selectedIndex: index,
        options: browser.options.map((option, row) => row === index && !sessionId
            ? { ...option, sessionId: undefined }
            : option),
    };
    const state = handleTuiSettingsPickerKey(parent, { name: "enter" }).state;
    if (state?.kind !== "session_leave") throw new Error("switch confirmation did not open");
    return { parent, state };
}

for (const selectedIndex of [0, 1]) {
    for (const [name, sourceDisposition] of [["1", "stop"], ["2", "keep_running"]] as const) {
        test(`switch ${name} acts immediately from row ${selectedIndex}`, () => {
            const { state } = switchPicker();
            const result = handleTuiSettingsPickerKey({ ...state, selectedIndex }, { name });
            expect(result.handled).toBe(true);
            expect(result.selection).toEqual({
                kind: "session",
                sessionPath: "/sessions/target.jsonl",
                sessionId: "target-session-id",
                sourceDisposition,
            });
            expect(result.state).toBeUndefined();
        });
    }
}

test("switch shortcuts preserve an absent session id and refuse missing targets", () => {
    const { state } = switchPicker(false);
    expect(handleTuiSettingsPickerKey(state, { name: "2" }).selection).toEqual({
        kind: "session",
        sessionPath: "/sessions/target.jsonl",
        sourceDisposition: "keep_running",
    });
    for (const name of ["1", "2"]) {
        expect(handleTuiSettingsPickerKey({ ...state, parent: undefined }, { name }).selection)
            .toBeUndefined();
        expect(handleTuiSettingsPickerKey({
            ...state,
            parent: { ...state.parent!, selectedIndex: state.parent!.options.length },
        }, { name }).selection).toBeUndefined();
    }
});

test("switch shortcuts reject modified keys and consume other digits", () => {
    const { state } = switchPicker();
    for (const modifier of ["ctrl", "meta", "super", "hyper", "shift"] as const) {
        for (const name of ["1", "2"]) {
            const key: TuiSettingsPickerKey = { name, [modifier]: true };
            expect(handleTuiSettingsPickerKey(state, key).selection).toBeUndefined();
        }
    }
    for (const name of ["0", "3", "9"]) {
        expect(handleTuiSettingsPickerKey(state, { name })).toEqual({ state, handled: true });
    }
});

test("switch confirmation retains arrow, Enter, and Escape behavior", () => {
    const { parent, state } = switchPicker();
    const keep = handleTuiSettingsPickerKey(state, { name: "down" }).state!;
    expect(keep.selectedIndex).toBe(1);
    expect(handleTuiSettingsPickerKey(keep, { name: "enter" }).selection)
        .toMatchObject({ kind: "session", sourceDisposition: "keep_running" });
    expect(handleTuiSettingsPickerKey(keep, { name: "up" }).state?.selectedIndex).toBe(0);
    expect(handleTuiSettingsPickerKey(keep, { name: "escape" }).state).toBe(parent);
});

test("digits remain search input in the conversation browser", async () => {
    const { parent } = switchPicker();
    const setup = await createTestRenderer({ width: 80, height: 24 });
    try {
        const view = createTuiSettingsPickerView(setup.renderer);
        view.update(parent);
        const result = view.handleEditorKey(parent, { name: "2", sequence: "2" });
        expect(result.handled).toBe(true);
        expect(result.state?.query).toBe("2");
        expect(result.selection).toBeUndefined();
    } finally {
        setup.renderer.destroy();
    }
});
