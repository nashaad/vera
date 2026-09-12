import {
    BoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import { dialogHeaderNode } from "./dialog-header.ts";

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
import { OVERRIDE_VALUE_ROWS } from "./settings-picker-starters.ts";
import type { OverrideRow } from "../../src/engine/override-rows.ts";

export type TuiOverridesResetConfirmResult = "confirm" | "cancel" | undefined;

/** The levers a reset would clear, named as the pane names them. A count alone does not tell the user whether they meant it. */
export function tuiOverridesResetLevers(
    rows: readonly OverrideRow[],
): readonly string[] {
    return OVERRIDE_VALUE_ROWS.filter((row) =>
        rows.some((fact) => fact.key === row.key && fact.source === "configured")
    ).map((row) => row.label);
}

export interface TuiOverridesResetConfirmView {
    readonly box: BoxRenderable;
    readonly surface: BoxRenderable;
    readonly themeBindings: readonly TuiThemeBinding[];
    update(levers: readonly string[]): void;
}

export function handleTuiOverridesResetConfirmKey(
    key: {
        readonly name: string;
        readonly ctrl?: boolean;
        readonly meta?: boolean;
        readonly shift?: boolean;
        readonly super?: boolean;
        readonly hyper?: boolean;
    },
): TuiOverridesResetConfirmResult {
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

export function createTuiOverridesResetConfirmView(
    renderer: RenderContext,
): TuiOverridesResetConfirmView {
    const title = new TextRenderable(renderer, {
        content: "Reset every override to its default?",
        fg: TUI_NOTICE,
        width: "100%",
        height: 1,
    });
    const levers = new TextRenderable(renderer, {
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const detail = new TextRenderable(renderer, {
        content: "These drop out of your config and go back to the values Vera ships with. Nothing else in the config is touched.",
        fg: TUI_MUTED,
        width: "100%",
        height: "auto",
        wrapMode: "word",
        marginTop: 1,
    });
    const footer = new TextRenderable(renderer, {
        content: "[1] reset · [esc] keep them",
        fg: TUI_NOTICE,
        width: "100%",
        height: 1,
        marginTop: 1,
    });
    const box = new BoxRenderable(renderer, {
        id: "overrides-reset-confirm",
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
    box.add(dialogHeaderNode(renderer, title));
    box.add(levers);
    box.add(detail);
    box.add(footer);
    const surface = centeredDialogSurface(
        renderer,
        "overrides-reset-confirm-surface",
        box,
    );
    return {
        box,
        surface,
        themeBindings: [
            tuiThemeProperties(title, { fg: "notice" }),
            tuiThemeProperties(levers, { fg: "text" }),
            tuiThemeProperties(detail, { fg: "muted" }),
            tuiThemeProperties(footer, { fg: "notice" }),
            tuiThemeProperties(box, { backgroundColor: "panel" }),
        ],
        update(chosen): void {
            levers.content = chosen.length === 1
                ? `${chosen[0]} is set.`
                : `${chosen.length} set: ${chosen.join(", ")}.`;
        },
    };
}
