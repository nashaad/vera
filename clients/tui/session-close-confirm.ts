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

export type TuiSessionCloseConfirmResult = "confirm" | "cancel" | undefined;

export interface TuiSessionCloseConfirmView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    readonly themeBindings: readonly TuiThemeBinding[];
    update(label: string): void;
}

export function handleTuiSessionCloseConfirmKey(
    key: {
        readonly name: string;
        readonly ctrl?: boolean;
        readonly meta?: boolean;
        readonly shift?: boolean;
        readonly super?: boolean;
        readonly hyper?: boolean;
    },
): TuiSessionCloseConfirmResult {
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

export function createTuiSessionCloseConfirmView(
    renderer: RenderContext,
): TuiSessionCloseConfirmView {
    const title = new TextRenderable(renderer, {
        content: "Stop this conversation?",
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
        content: "Work is still in flight. Closing stops it; the file stays and you can resume.",
        fg: TUI_MUTED,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const footer = new TextRenderable(renderer, {
        content: "[1] close · [esc] keep running",
        fg: TUI_NOTICE,
        width: "100%",
        height: 1,
        marginTop: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "session-close-confirm",
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
    const surface = centeredDialogSurface(renderer, "session-close-confirm-surface", box);
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
