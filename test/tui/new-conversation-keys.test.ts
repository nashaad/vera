import { expect, test } from "bun:test";
import {
    handleTuiSettingsPickerKey,
    startTuiCreateLeavePicker,
    type TuiSettingsPickerKey,
} from "../../clients/tui/settings-picker.ts";

for (const ignoreEnter of [false, true]) {
    for (const selectedIndex of [0, 1]) {
        for (const [name, sourceDisposition] of [["1", "stop"], ["2", "keep_running"]] as const) {
            test(`new conversation ${name} acts immediately from row ${selectedIndex}, enter guard ${ignoreEnter}`, () => {
                const state = { ...startTuiCreateLeavePicker(ignoreEnter), selectedIndex };
                const result = handleTuiSettingsPickerKey(state, { name });
                expect(result.handled).toBe(true);
                expect(result.selection).toEqual({ kind: "session_create_leave", sourceDisposition });
                expect(result.state).toBeUndefined();
            });
        }
    }
}

for (const modifier of ["ctrl", "meta", "super", "hyper", "shift"] as const) {
    test(`new conversation ignores ${modifier} digit shortcuts`, () => {
        for (const name of ["1", "2"]) {
            const key: TuiSettingsPickerKey = { name, [modifier]: true };
            expect(handleTuiSettingsPickerKey(startTuiCreateLeavePicker(), key).selection)
                .toBeUndefined();
        }
    });
}

test("new conversation consumes other digits without choosing", () => {
    for (const name of ["0", "3", "9"]) {
        const result = handleTuiSettingsPickerKey(startTuiCreateLeavePicker(), { name });
        expect(result.handled).toBe(true);
        expect(result.selection).toBeUndefined();
    }
});

test("switch confirmation does not acquire quick digit triggers", () => {
    const state = { ...startTuiCreateLeavePicker(), kind: "session_leave" as const };
    for (const name of ["1", "2"]) {
        expect(handleTuiSettingsPickerKey(state, { name }).selection).toBeUndefined();
    }
});
