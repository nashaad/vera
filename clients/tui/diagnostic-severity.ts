export type TuiFatalState = "stopped" | "ended";

export type TuiDiagnosticCode =
    | "unknown"
    | "model_request_failed"
    | "attachment_failed"
    | "turn_interrupted"
    | "permission_denied"
    | "classifier_failed"
    | "file_skipped"
    | "hook_failed"
    | "resident_agent_stopped"
    | "session_corrupt";

interface TuiNoticeDiagnosticDefinition {
    readonly severity: "notice";
}

interface TuiErrorDiagnosticDefinition {
    readonly severity: "error";
    readonly title: string;
}

interface TuiFatalDiagnosticDefinition {
    readonly severity: "fatal";
    readonly state: TuiFatalState;
    readonly title: string;
}

export type TuiDiagnosticDefinition =
    | TuiNoticeDiagnosticDefinition
    | TuiErrorDiagnosticDefinition
    | TuiFatalDiagnosticDefinition;

export const TUI_DIAGNOSTICS = {
    unknown: { severity: "error", title: "ERROR" },
    model_request_failed: { severity: "error", title: "MODEL REQUEST FAILED" },
    attachment_failed: { severity: "error", title: "ATTACHMENT FAILED" },
    turn_interrupted: { severity: "notice" },
    permission_denied: { severity: "error", title: "CLASSIFIER DENIED" },
    classifier_failed: { severity: "error", title: "CLASSIFIER FAILED" },
    file_skipped: { severity: "notice" },
    hook_failed: { severity: "error", title: "HOOK FAILED" },
    resident_agent_stopped: { severity: "fatal", state: "stopped", title: "AGENT STOPPED" },
    session_corrupt: { severity: "fatal", state: "ended", title: "SESSION ENDED" },
} as const satisfies Record<TuiDiagnosticCode, TuiDiagnosticDefinition>;

interface TuiNoticeDiagnostic {
    readonly code: TuiDiagnosticCode;
    readonly severity: "notice";
    readonly message: string;
}

export interface TuiDiagnosticDetail {
    readonly headline?: string;
    readonly fix?: string;
}

interface TuiErrorDiagnostic extends TuiDiagnosticDetail {
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
    detail: TuiDiagnosticDetail = {},
): TuiDiagnostic {
    const definition = TUI_DIAGNOSTICS[code];
    if (definition.severity === "fatal") {
        return { code, severity: "fatal", state: definition.state, message };
    }
    if (definition.severity === "error") {
        return {
            code,
            severity: "error",
            message,
            ...(detail.headline === undefined ? {} : { headline: detail.headline }),
            ...(detail.fix === undefined ? {} : { fix: detail.fix }),
        };
    }
    return { code, severity: definition.severity, message };
}

export function tuiDiagnosticTitle(code: TuiDiagnosticCode): string | undefined {
    const definition: TuiDiagnosticDefinition = TUI_DIAGNOSTICS[code];
    return definition.severity === "notice" ? undefined : definition.title;
}
