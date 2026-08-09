import { expect, test } from "bun:test";

import { handleTuiDiagnosticsDialogKey } from "../../clients/tui/diagnostics-dialog.ts";

test("diagnostics dialog copies on Enter and dismisses on Escape", () => {
    expect(handleTuiDiagnosticsDialogKey({ name: "enter" })).toBe("copy");
    expect(handleTuiDiagnosticsDialogKey({ name: "return" })).toBe("copy");
    expect(handleTuiDiagnosticsDialogKey({ name: "escape" })).toBe("dismiss");
});

test("diagnostics dialog leaves unrelated and modified keys alone", () => {
    expect(handleTuiDiagnosticsDialogKey({ name: "a" })).toBeUndefined();
    expect(handleTuiDiagnosticsDialogKey({ name: "enter", ctrl: true }))
        .toBeUndefined();
});
