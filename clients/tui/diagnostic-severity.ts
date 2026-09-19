export type TuiFatalState = "stopped" | "ended";

export type TuiDiagnosticCode =
    | "unknown"
    | "model_request_failed"
    | "attachment_failed"
    | "turn_interrupted"
    | "permission_denied"
    | "file_skipped"
    | "hook_failed"
    | "resident_agent_stopped"
    | "session_corrupt";

interface TuiNoticeDiagnosticDefinition {
    readonly severity: "notice";
}

interface TuiErrorDiagnosticDefinition {
    readonly severity: "error";
}

interface TuiFatalDiagnosticDefinition {
    readonly severity: "fatal";
    readonly state: TuiFatalState;
}

export type TuiDiagnosticDefinition =
    | TuiNoticeDiagnosticDefinition
    | TuiErrorDiagnosticDefinition
    | TuiFatalDiagnosticDefinition;

export const TUI_DIAGNOSTICS = {
    unknown: { severity: "error" },
    model_request_failed: { severity: "error" },
    attachment_failed: { severity: "error" },
    turn_interrupted: { severity: "notice" },
    permission_denied: { severity: "error" },
    file_skipped: { severity: "notice" },
    hook_failed: { severity: "error" },
    resident_agent_stopped: { severity: "fatal", state: "stopped" },
    session_corrupt: { severity: "fatal", state: "ended" },
} as const satisfies Record<TuiDiagnosticCode, TuiDiagnosticDefinition>;

interface TuiNoticeDiagnostic {
    readonly code: TuiDiagnosticCode;
    readonly severity: "notice";
    readonly message: string;
}

interface TuiErrorDiagnostic {
    readonly code: TuiDiagnosticCode;
    readonly severity: "error";
    readonly message: string;
}

interface TuiFatalDiagnostic {
    readonly code: TuiDiagnosticCode;
    readonly severity: "fatal";
    readonly state: TuiFatalState;
    readonly message: string;
}

export type TuiDiagnostic =
    | TuiNoticeDiagnostic
    | TuiErrorDiagnostic
    | TuiFatalDiagnostic;

export function resolveTuiDiagnostic(
    code: TuiDiagnosticCode,
    message: string,
): TuiDiagnostic {
    const definition = TUI_DIAGNOSTICS[code];
    if (definition.severity === "fatal") {
        return { code, severity: "fatal", state: definition.state, message };
    }
    return { code, severity: definition.severity, message };
}
