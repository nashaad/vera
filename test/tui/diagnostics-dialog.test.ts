import { expect, test } from "bun:test";

import {
    handleTuiDiagnosticsDialogKey,
    terminalDiagnosticsLines,
} from "../../clients/tui/diagnostics-dialog.ts";

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

test("diagnostics dialog renders Markdown tables as terminal tables", () => {
    expect(terminalDiagnosticsLines([
        "## Usage",
        "| Calls | Runtime |",
        "| --- | --- |",
        "| 1 | 2.69s |",
        "",
        "> Provider did not report cost.",
    ])).toEqual([
        "## Usage",
        "Calls  Runtime",
        "─────  ───────",
        "1      2.69s",
        "",
        "Note: Provider did not report cost.",
    ]);
});
