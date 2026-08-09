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
import { DIALOG_CARD_Z_INDEX } from "./dialog-chrome.ts";

/**
 * The verification run this dialog reports on. It exists only once the probes
 * are on the wire: adding a model never opens it, because adding never waits
 * on a provider.
 */
export interface TuiAdmissionDialogState {
    readonly provider: string;
    readonly model: string;
    readonly requestId: string;
}

/**
 * What each phase means for the keys:
 *
 * `running`: probes are on the wire and cannot be aborted, so esc hides the
 * dialog and lets the transcript notice carry the outcome.
 * `done`: the verdict is on screen. Enter retries an unavailable run and
 * dismisses the other two; esc always dismisses.
 */
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
        position: "absolute",
        top: 2,
        left: "15%",
        width: "70%",
        height: "auto",
        zIndex: DIALOG_CARD_Z_INDEX,
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        focusable: true,
        visible: false,
    });
    box.add(title);
    box.add(body);
    box.add(footer);
    return {
        box,
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
