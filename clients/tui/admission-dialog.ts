import {
    BoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import {
    TUI_MUTED,
    TUI_NOTICE,
    TUI_PANEL,
    TUI_TEXT,
    tuiAdmissionStepLines,
    tuiAdmissionVerdictLine,
    type TuiAdmissionState,
} from "./state.ts";
import { centeredDialogSurface } from "./dialog-chrome.ts";
import {
    tuiThemeProperties,
    type TuiThemeBinding,
} from "./theme-bindings.ts";

export interface TuiAdmissionDialogState {
    readonly provider: string;
    readonly model: string;
    readonly requestId: string;
}

export type TuiAdmissionDialogPhase = "running" | "done";

export type TuiAdmissionDialogAction =
    | "hide"
    | "retry"
    | "dismiss";

export function startTuiAdmissionDialog(
    provider: string,
    model: string,
    requestId: string,
): TuiAdmissionDialogState {
    return { provider, model, requestId };
}

export function tuiAdmissionDialogPhase(
    dialog: TuiAdmissionDialogState,
    admission: TuiAdmissionState | undefined,
): TuiAdmissionDialogPhase {
    return admission?.requestId === dialog.requestId
            && admission.verdict !== undefined
        ? "done"
        : "running";
}

export function handleTuiAdmissionDialogKey(
    dialog: TuiAdmissionDialogState,
    admission: TuiAdmissionState | undefined,
    key: { readonly name: string },
): TuiAdmissionDialogAction | undefined {
    const enter = key.name === "return" || key.name === "enter";
    const escape = key.name === "escape";
    if (tuiAdmissionDialogPhase(dialog, admission) === "running") {
        return escape ? "hide" : undefined;
    }
    if (enter) {
        return admission?.verdict === "unavailable" ? "retry" : "dismiss";
    }
    return escape ? "dismiss" : undefined;
}

export interface TuiAdmissionDialogView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    readonly themeBindings: readonly TuiThemeBinding[];
    update(
        dialog: TuiAdmissionDialogState,
        admission: TuiAdmissionState | undefined,
    ): void;
}

function dialogTitle(
    dialog: TuiAdmissionDialogState,
    phase: TuiAdmissionDialogPhase,
    admission: TuiAdmissionState | undefined,
): string {
    const subject = `${dialog.provider}/${dialog.model}`;
    if (phase === "running") {
        return `Verifying ${subject}…`;
    }
    if (admission?.verdict === "added") {
        return `Verified ${subject}`;
    }
    return admission?.verdict === "unavailable"
        ? `Could not reach ${subject}`
        : `Could not verify ${subject}`;
}

function dialogBody(
    phase: TuiAdmissionDialogPhase,
    admission: TuiAdmissionState | undefined,
): string {
    if (admission === undefined) {
        return "Running a few small probe calls on your key.";
    }
    const lines = tuiAdmissionStepLines(admission);
    const verdict = tuiAdmissionVerdictLine(admission);
    return [
        ...lines,
        ...(verdict === undefined ? [] : ["", verdict]),
    ].join("\n");
}

function dialogFooter(
    phase: TuiAdmissionDialogPhase,
    admission: TuiAdmissionState | undefined,
): string {
    if (phase === "running") {
        return "esc hide, verification continues";
    }
    return admission?.verdict === "unavailable"
        ? "[enter] retry · [esc] close"
        : "[enter/esc] close";
}

export function createTuiAdmissionDialogView(
    renderer: RenderContext,
): TuiAdmissionDialogView {
    const title = new TextRenderable(renderer, {
        content: "",
        fg: TUI_NOTICE,
        width: "100%",
        height: 1,
    });
    const body = new TextRenderable(renderer, {
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const footer = new TextRenderable(renderer, {
        content: "",
        fg: TUI_MUTED,
        width: "100%",
        height: 1,
        marginTop: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "admission-dialog",
        border: false,
        backgroundColor: TUI_PANEL,
        width: "70%",
        height: "auto",
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        focusable: true,
    });
    box.add(title);
    box.add(body);
    box.add(footer);
    const surface = centeredDialogSurface(renderer, "admission-dialog-surface", box);
    return {
        box,
        surface,
        themeBindings: [
            tuiThemeProperties(title, { fg: "notice" }),
            tuiThemeProperties(body, { fg: "text" }),
            tuiThemeProperties(footer, { fg: "muted" }),
            tuiThemeProperties(box, { backgroundColor: "panel" }),
        ],
        update(dialog, admission): void {
            const phase = tuiAdmissionDialogPhase(dialog, admission);
            const relevant = admission?.requestId === dialog.requestId
                ? admission
                : undefined;
            title.content = dialogTitle(dialog, phase, relevant);
            body.content = dialogBody(phase, relevant);
            footer.content = dialogFooter(phase, relevant);
        },
    };
}
