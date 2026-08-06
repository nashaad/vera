import {
    BoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import type { ModelReasoningEffort } from "../../src/model/types.ts";
import {
    TUI_MUTED,
    TUI_NOTICE,
    TUI_PANEL,
    TUI_TEXT,
    tuiAdmissionStepLines,
    tuiAdmissionVerdictLine,
    type TuiAdmissionState,
} from "./state.ts";

/**
 * The settings change that motivated this admission, applied only after an
 * "added" verdict. Absent when the user asked to add a model without choosing
 * it (the ctrl+s pool toggle).
 */
export interface TuiAdmissionApply {
    readonly provider: string;
    readonly model: string;
    readonly reasoningEffort?: ModelReasoningEffort;
}

export interface TuiAdmissionDialogState {
    readonly provider: string;
    readonly model: string;
    /** Set once the user confirmed and `pool_add` went out. */
    readonly requestId?: string;
    readonly apply?: TuiAdmissionApply;
}

/**
 * What each phase means for the keys:
 *
 * `confirm`: nothing has been sent. Enter starts the probes, esc walks away.
 * `running`: probes are on the wire and cannot be aborted, so esc hides the
 * dialog and lets the transcript notice carry the outcome.
 * `done`: the verdict is on screen. Enter retries an unavailable run and
 * dismisses the other two; esc always dismisses.
 */
export type TuiAdmissionDialogPhase = "confirm" | "running" | "done";

export type TuiAdmissionDialogAction =
    | "start"
    | "cancel"
    | "hide"
    | "retry"
    | "dismiss";

export function startTuiAdmissionDialog(
    provider: string,
    model: string,
    apply?: TuiAdmissionApply,
): TuiAdmissionDialogState {
    return {
        provider,
        model,
        ...(apply === undefined ? {} : { apply }),
    };
}

export function tuiAdmissionDialogPhase(
    dialog: TuiAdmissionDialogState,
    admission: TuiAdmissionState | undefined,
): TuiAdmissionDialogPhase {
    if (dialog.requestId === undefined) {
        return "confirm";
    }
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
    const phase = tuiAdmissionDialogPhase(dialog, admission);
    if (phase === "confirm") {
        if (enter) return "start";
        if (escape) return "cancel";
        return undefined;
    }
    if (phase === "running") {
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
    if (phase === "confirm") {
        return `Verify ${subject}?`;
    }
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
    if (phase === "confirm" || admission === undefined) {
        return "Runs a few small probe calls on your key.";
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
    if (phase === "confirm") {
        return "[enter] verify · [esc] cancel";
    }
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
        zIndex: 20,
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
