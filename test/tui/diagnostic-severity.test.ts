import { expect, test } from "bun:test";

import {
    resolveTuiDiagnostic,
    TUI_DIAGNOSTICS,
    type TuiDiagnosticCode,
} from "../../clients/tui/diagnostic-severity.ts";

test("diagnostic codes carry fixed severities, titles and fatal state words", () => {
    expect(TUI_DIAGNOSTICS.permission_denied).toEqual({
        severity: "error",
        title: "CLASSIFIER DENIED",
    });
    expect(TUI_DIAGNOSTICS.hook_failed).toEqual({ severity: "error", title: "HOOK FAILED" });
    expect(TUI_DIAGNOSTICS.file_skipped).toEqual({ severity: "notice" });
    expect(TUI_DIAGNOSTICS.resident_agent_stopped).toEqual({
        severity: "fatal",
        state: "stopped",
        title: "AGENT STOPPED",
    });
    expect(TUI_DIAGNOSTICS.session_corrupt).toEqual({
        severity: "fatal",
        state: "ended",
        title: "SESSION ENDED",
    });
});

test("only errors keep a headline and a fix", () => {
    const detail = { headline: "bash did not run", fix: "open /settings." };

    expect(resolveTuiDiagnostic("classifier_failed", "Out of usage.", detail)).toEqual({
        code: "classifier_failed",
        severity: "error",
        message: "Out of usage.",
        headline: "bash did not run",
        fix: "open /settings.",
    });
    expect(resolveTuiDiagnostic("file_skipped", "Skipped a file", detail)).toEqual({
        code: "file_skipped",
        severity: "notice",
        message: "Skipped a file",
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
