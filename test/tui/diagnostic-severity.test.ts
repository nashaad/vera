import { expect, test } from "bun:test";

import {
    resolveTuiDiagnostic,
    TUI_DIAGNOSTICS,
    type TuiDiagnosticCode,
} from "../../clients/tui/diagnostic-severity.ts";

test("diagnostic codes carry fixed severities and fatal state words", () => {
    expect(TUI_DIAGNOSTICS.permission_denied).toEqual({ severity: "error" });
    expect(TUI_DIAGNOSTICS.hook_failed).toEqual({ severity: "error" });
    expect(TUI_DIAGNOSTICS.file_skipped).toEqual({ severity: "notice" });
    expect(TUI_DIAGNOSTICS.resident_agent_stopped).toEqual({
        severity: "fatal",
        state: "stopped",
    });
    expect(TUI_DIAGNOSTICS.session_corrupt).toEqual({
        severity: "fatal",
        state: "ended",
    });
});

test("every declared diagnostic code resolves without message inspection", () => {
    const codes = Object.keys(TUI_DIAGNOSTICS) as TuiDiagnosticCode[];

    for (const code of codes) {
        const first = resolveTuiDiagnostic(code, "same message");
        const second = resolveTuiDiagnostic(code, "different message");
        expect(second.severity).toBe(first.severity);
    }
});
