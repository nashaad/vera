import {
    BoxRenderable,
    ScrollBoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import {
    DIALOG_CARD_Z_INDEX,
    dialogHeaderNode,
} from "./dialog-chrome.ts";
import {
    TUI_MUTED,
    TUI_PANEL,
    TUI_SUCCESS,
    TUI_TEXT,
} from "./state.ts";

export interface TuiDiagnosticsDialogState {
    readonly text: string;
    readonly copyReady?: boolean;
    readonly copyStatus?: "copied" | "failed";
}

export type TuiDiagnosticsDialogAction = "copy" | "dismiss";

export interface TuiDiagnosticsDialogKey {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
}

export interface TuiDiagnosticsDialogView {
    readonly box: BoxRenderable;
    focus(): void;
    update(state: TuiDiagnosticsDialogState): void;
    repaint(): void;
}

export function handleTuiDiagnosticsDialogKey(
    key: TuiDiagnosticsDialogKey,
): TuiDiagnosticsDialogAction | undefined {
    if (key.ctrl || key.meta || key.shift) {
        return undefined;
    }
    if (key.name === "escape") {
        return "dismiss";
    }
    if (
        key.name === "return"
        || key.name === "enter"
        || key.name === "kpenter"
    ) {
        return "copy";
    }
    return undefined;
}

export function createTuiDiagnosticsDialogView(
    renderer: RenderContext,
): TuiDiagnosticsDialogView {
    const box = new BoxRenderable(renderer, {
        id: "diagnostics-dialog",
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        top: "3%",
        left: "2%",
        width: "96%",
        height: "90%",
        zIndex: DIALOG_CARD_Z_INDEX,
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        paddingBottom: 1,
        focusable: true,
        visible: false,
    });
    const header = dialogHeaderNode(renderer, "Diagnostics");
    const bodyText = new TextRenderable(renderer, {
        id: "diagnostics-dialog-text",
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        selectable: true,
    });
    const body = new ScrollBoxRenderable(renderer, {
        id: "diagnostics-dialog-body",
        width: "100%",
        flexGrow: 1,
        minHeight: 1,
        marginTop: 1,
        scrollY: true,
        scrollX: false,
        focusable: true,
        viewportCulling: true,
        contentOptions: { flexDirection: "column" },
    });
    body.add(bodyText);
    const footer = new BoxRenderable(renderer, {
        id: "diagnostics-dialog-footer",
        width: "100%",
        height: 2,
        marginTop: 1,
        flexDirection: "row",
        justifyContent: "space-between",
    });
    const shareHint = new TextRenderable(renderer, {
        content: "Share this when reporting an issue.",
        fg: TUI_MUTED,
        height: 1,
    });
    const copyHint = new TextRenderable(renderer, {
        content: "copy  enter",
        fg: TUI_MUTED,
        height: 1,
    });
    footer.add(shareHint);
    footer.add(copyHint);
    box.add(header);
    box.add(body);
    box.add(footer);

    return {
        box,
        focus(): void {
            body.focus();
        },
        update(state): void {
            bodyText.content = state.text.split("\n").slice(1).join("\n");
            copyHint.content = state.copyStatus === "copied"
                ? "✓ copied"
                : state.copyStatus === "failed"
                ? "copy failed · enter retry"
                : state.copyReady === false
                ? "finding session path…"
                : "copy  enter";
            copyHint.fg = state.copyStatus === "copied"
                ? TUI_SUCCESS
                : TUI_MUTED;
        },
        repaint(): void {
            box.backgroundColor = TUI_PANEL;
            bodyText.fg = TUI_TEXT;
            shareHint.fg = TUI_MUTED;
            copyHint.fg = TUI_MUTED;
        },
    };
}
