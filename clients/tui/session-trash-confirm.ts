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
} from "./state.ts";
import { centeredDialogSurface } from "./dialog-chrome.ts";
import {
    tuiThemeProperties,
    type TuiThemeBinding,
} from "./theme-bindings.ts";

export type TuiSessionTrashConfirmResult = "confirm" | "cancel" | undefined;

export interface TuiSessionTrashConfirmView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    readonly themeBindings: readonly TuiThemeBinding[];
    update(label: string): void;
}

export function handleTuiSessionTrashConfirmKey(
    key: {
        readonly name: string;
        readonly ctrl?: boolean;
        readonly meta?: boolean;
        readonly shift?: boolean;
        readonly super?: boolean;
        readonly hyper?: boolean;
    },
): TuiSessionTrashConfirmResult {
    if (
        key.name === "1"
        && !key.ctrl
        && !key.meta
        && !key.shift
        && !key.super
        && !key.hyper
    ) {
        return "confirm";
    }
    if (key.name === "escape") {
        return "cancel";
    }
    return undefined;
}

export function createTuiSessionTrashConfirmView(
    renderer: RenderContext,
): TuiSessionTrashConfirmView {
    const title = new TextRenderable(renderer, {
        content: "Move conversation to Trash?",
        fg: TUI_NOTICE,
        width: "100%",
        height: 1,
    });
    const name = new TextRenderable(renderer, {
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const detail = new TextRenderable(renderer, {
        content: "The conversation and its saved images can be recovered from the system Trash.",
        fg: TUI_MUTED,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const footer = new TextRenderable(renderer, {
        content: "[1] move to Trash · [esc] cancel",
        fg: TUI_NOTICE,
        width: "100%",
        height: 1,
        marginTop: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "session-trash-confirm",
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
    box.add(name);
    box.add(detail);
    box.add(footer);
    const surface = centeredDialogSurface(renderer, "session-trash-confirm-surface", box);
    return {
        box,
        surface,
        themeBindings: [
            tuiThemeProperties(title, { fg: "notice" }),
            tuiThemeProperties(name, { fg: "text" }),
            tuiThemeProperties(detail, { fg: "muted" }),
            tuiThemeProperties(footer, { fg: "notice" }),
            tuiThemeProperties(box, { backgroundColor: "panel" }),
        ],
        update(label): void {
            name.content = label;
        },
    };
}
