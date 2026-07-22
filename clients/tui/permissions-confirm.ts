import {
    BoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import { TUI_MUTED, TUI_PANEL, TUI_TEXT } from "./state.ts";
import { dialogHeaderNode } from "./dialog-chrome.ts";

export interface TuiPermissionsConfirmKey {
    readonly name: string;
}

export type TuiPermissionsConfirmResult = "confirm" | "cancel" | undefined;

export interface TuiPermissionsConfirmView {
    readonly box: BoxRenderable;
}

export function handleTuiPermissionsConfirmKey(
    key: TuiPermissionsConfirmKey,
): TuiPermissionsConfirmResult {
    if (key.name === "1" || key.name === "enter" || key.name === "return") {
        return "confirm";
    }
    if (key.name === "escape") {
        return "cancel";
    }
    return undefined;
}

export function createTuiPermissionsConfirmView(
    renderer: RenderContext,
): TuiPermissionsConfirmView {
    const header = dialogHeaderNode(renderer, "Confirm full access");
    const warning = new TextRenderable(renderer, {
        id: "permissions-confirm-warning",
        content: [
            "Full access lets commands run without approval using your full user permissions.",
            "This can modify or delete files and affect processes outside the workspace.",
        ].join("\n"),
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const footer = new TextRenderable(renderer, {
        id: "permissions-confirm-actions",
        content: "[1/enter] enable full access · [esc] cancel",
        fg: TUI_MUTED,
        width: "100%",
        height: "auto",
        marginTop: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "permissions-confirm-box",
        border: false,
        backgroundColor: TUI_PANEL,
        position: "absolute",
        bottom: 1,
        left: 1,
        right: 1,
        height: "auto",
        maxHeight: "90%",
        zIndex: 20,
        flexDirection: "column",
        paddingLeft: 2,
        paddingRight: 2,
        paddingTop: 1,
        visible: false,
    });
    box.add(header);
    box.add(warning);
    box.add(footer);
    return { box };
}
