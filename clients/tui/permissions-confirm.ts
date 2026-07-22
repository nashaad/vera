import {
    BoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

const DANGER = "#ff3b30";
const DANGER_BACKGROUND = "#210b0b";

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
    const header = new TextRenderable(renderer, {
        id: "permissions-confirm-header",
        content: "⚠  DANGER: ENTER FULL-ACCESS RED ZONE",
        fg: DANGER,
        width: "100%",
        height: 1,
    });
    const warning = new TextRenderable(renderer, {
        id: "permissions-confirm-warning",
        content: [
            "Vera will run commands WITHOUT ASKING FOR APPROVAL.",
            "Commands inherit your full user permissions—not just workspace access.",
            "A mistaken or malicious command could permanently delete files, expose secrets,",
            "install software, or affect other processes on this computer.",
            "",
            "Only continue if you accept those risks and intend to supervise this session.",
        ].join("\n"),
        fg: DANGER,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const footer = new TextRenderable(renderer, {
        id: "permissions-confirm-actions",
        content: "[1/enter] I understand — ENTER RED ZONE · [esc] keep protections",
        fg: DANGER,
        width: "100%",
        height: "auto",
        marginTop: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "permissions-confirm-box",
        border: false,
        backgroundColor: DANGER_BACKGROUND,
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
        paddingBottom: 1,
        visible: false,
    });
    box.add(header);
    box.add(warning);
    box.add(footer);
    return { box };
}
