/** The live colour bindings every TUI view draws with, and the one call that repoints them at a theme. Nothing here knows what a session is, so a view that needs only colour needs only this. */

import { VERA_TUI_THEME, type TuiTheme, type TuiThemeHud } from "./theme.ts";

export let TUI_ACCENT = VERA_TUI_THEME.accent;
export let TUI_TEXT = VERA_TUI_THEME.text;
export let TUI_MUTED = VERA_TUI_THEME.muted;
export let TUI_NOTICE = VERA_TUI_THEME.notice;
export let TUI_DANGER = VERA_TUI_THEME.danger;
export let TUI_SUCCESS = VERA_TUI_THEME.success;
export let TUI_CRITICAL = VERA_TUI_THEME.critical;
export let TUI_DIFF_ADDED = VERA_TUI_THEME.diffAdded;
export let TUI_DIFF_REMOVED = VERA_TUI_THEME.diffRemoved;
export let TUI_BACKGROUND = VERA_TUI_THEME.background;
export let TUI_PANEL = VERA_TUI_THEME.panel;
export let TUI_ELEMENT = VERA_TUI_THEME.element;
export let TUI_INPUT = VERA_TUI_THEME.input;
export let TUI_MENU = VERA_TUI_THEME.menu;
export let TUI_CHROME: "plain" | "norton" = "plain";
export let TUI_SELECTION_TEXT = VERA_TUI_THEME.selectionText;
export let TUI_HUD: TuiThemeHud | undefined = VERA_TUI_THEME.hud;

export function applyTuiTheme(theme: TuiTheme): void {
    TUI_ACCENT = theme.accent;
    TUI_TEXT = theme.text;
    TUI_MUTED = theme.muted;
    TUI_NOTICE = theme.notice;
    TUI_DANGER = theme.danger;
    TUI_SUCCESS = theme.success;
    TUI_CRITICAL = theme.critical;
    TUI_DIFF_ADDED = theme.diffAdded;
    TUI_DIFF_REMOVED = theme.diffRemoved;
    TUI_BACKGROUND = theme.background;
    TUI_PANEL = theme.panel;
    TUI_ELEMENT = theme.element;
    TUI_INPUT = theme.input;
    TUI_MENU = theme.menu;
    TUI_CHROME = theme.chrome;
    TUI_SELECTION_TEXT = theme.selectionText;
    TUI_HUD = theme.hud;
}
