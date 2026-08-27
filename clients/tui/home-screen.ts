import {
    BoxRenderable,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import { DIALOG_BACKGROUND_Z_INDEX } from "./dialog-chrome.ts";
import { TUI_ACCENT, TUI_MUTED, TUI_TEXT } from "./state.ts";

/** The letterspaced name at the head of the card. */
export const HOME_WORDMARK = "V  E  R  A";

/** The line under the wordmark. */
export const HOME_RULE = "─".repeat(23);

/** The last line of the card: the composer is not on screen to say it. */
export const HOME_TYPING_HINT = "or just start typing";

/** Every column the card occupies, rule and rows alike. */
export const HOME_CARD_COLUMNS = 27;

export type HomeRowId = "new" | "all" | "commands";

export interface HomeRow {
    readonly id: HomeRowId;
    readonly label: string;
    readonly keyHint: string;
}

export interface HomeState {
    readonly selectedId: HomeRowId;
    /** False on a machine with no conversations yet: the row is absent. */
    readonly hasSessions: boolean;
}

export type HomeAction =
    | { readonly kind: "new_session" }
    | { readonly kind: "resume_picker" }
    | { readonly kind: "palette" }
    | { readonly kind: "type"; readonly text: string };

export function createHomeState(hasSessions: boolean): HomeState {
    return { selectedId: "new", hasSessions };
}

/**
 * The rows on offer.
 *
 * A machine with no conversations has nothing to list, so that row is absent
 * rather than greyed: a card of three rows where one is dead reads as a menu
 * that is broken, not as a machine that is new.
 */
export function homeRows(state: HomeState): readonly HomeRow[] {
    return [
        { id: "new", label: "New conversation", keyHint: "enter" },
        ...(state.hasSessions
            ? [{
                id: "all" as const,
                label: "All conversations",
                keyHint: "ctrl+r",
            }]
            : []),
        { id: "commands", label: "Commands", keyHint: "ctrl+p" },
    ];
}

export type HomeLineTone = "wordmark" | "rule" | "row" | "hint";

export interface HomeLine {
    readonly text: string;
    readonly tone: HomeLineTone;
    readonly selected?: boolean;
}

/** The card, line by line, each already padded to `HOME_CARD_COLUMNS`. */
export function homeCardLines(state: HomeState): readonly HomeLine[] {
    const rows = homeRows(state);
    const selected = selectedRowId(state);
    return [
        { text: centered(HOME_WORDMARK), tone: "wordmark" },
        { text: centered(HOME_RULE), tone: "rule" },
        { text: "", tone: "rule" },
        ...rows.map((row) => ({
            text: rowText(row, row.id === selected),
            tone: "row" as const,
            selected: row.id === selected,
        })),
        { text: "", tone: "rule" },
        { text: `  ${HOME_TYPING_HINT}`, tone: "hint" as const },
    ];
}

/**
 * What a key does on the home card.
 *
 * Arrows move the cursor, Enter runs the row it is on, and ctrl+r opens the
 * session list from anywhere. Every plain character is the first one of a
 * message, so it starts a conversation with that character already typed: a
 * row key that was not a chord would eat the messages that begin with it.
 */
export function handleHomeKey(
    state: HomeState,
    key: {
        readonly name: string;
        readonly sequence?: string;
        readonly ctrl?: boolean;
        readonly meta?: boolean;
        readonly shift?: boolean;
        readonly super?: boolean;
        readonly hyper?: boolean;
    },
): {
    readonly state?: HomeState;
    readonly action?: HomeAction;
    readonly handled: boolean;
} {
    const rows = homeRows(state);
    if (key.ctrl === true) {
        return key.name === "r" && rows.some((row) => row.id === "all")
            ? { action: { kind: "resume_picker" }, handled: true }
            : { handled: false };
    }
    if (key.meta === true || key.super === true || key.hyper === true) {
        return { handled: false };
    }
    if (key.name === "up" || key.name === "down") {
        const current = rows.findIndex((row) => row.id === selectedRowId(state));
        const next = rows[
            (current + (key.name === "down" ? 1 : rows.length - 1)) % rows.length
        ];
        return next === undefined
            ? { handled: true }
            : { state: { ...state, selectedId: next.id }, handled: true };
    }
    if (key.name === "return" || key.name === "enter") {
        return { action: rowAction(selectedRowId(state)), handled: true };
    }
    const typed = homeTypedCharacter(key);
    if (typed !== undefined) {
        return { action: { kind: "type", text: typed }, handled: true };
    }
    return { handled: false };
}

/**
 * The character a key would put in the composer, or undefined for a key that
 * would not type at all.
 *
 * Starting a conversation takes long enough for the rest of a sentence to
 * arrive before the composer exists, so the caller keeps asking this while it
 * waits and appends what comes back.
 */
export function homeTypedCharacter(
    key: {
        readonly name: string;
        readonly sequence?: string;
        readonly ctrl?: boolean;
        readonly meta?: boolean;
        readonly super?: boolean;
        readonly hyper?: boolean;
    },
): string | undefined {
    if (
        key.ctrl === true || key.meta === true || key.super === true
        || key.hyper === true
    ) {
        return undefined;
    }
    if (key.name === "space") return " ";
    return isPrintable(key) ? (key.sequence ?? key.name) : undefined;
}

function rowAction(id: HomeRowId): HomeAction {
    if (id === "all") return { kind: "resume_picker" };
    if (id === "commands") return { kind: "palette" };
    return { kind: "new_session" };
}

/** The cursor never rests on a row that is not there. */
function selectedRowId(state: HomeState): HomeRowId {
    const rows = homeRows(state);
    return rows.some((row) => row.id === state.selectedId)
        ? state.selectedId
        : "new";
}

function rowText(row: HomeRow, selected: boolean): string {
    const head = `${selected ? "❯" : " "} ${row.label}`;
    const gap = Math.max(1, HOME_CARD_COLUMNS - head.length - row.keyHint.length);
    return `${head}${" ".repeat(gap)}${row.keyHint}`;
}

function centered(text: string): string {
    const lead = Math.max(0, Math.floor((HOME_CARD_COLUMNS - text.length) / 2));
    return `${" ".repeat(lead)}${text}`;
}

function isPrintable(key: { readonly name: string }): boolean {
    return key.name.length === 1 || key.name === "space";
}

export interface TuiHomeView {
    readonly surface: BoxRenderable;
    readonly box: BoxRenderable;
    update(state: HomeState): void;
    applyAppearance(appearance: {
        readonly textColor: string;
        readonly mutedColor: string;
        readonly accentColor: string;
    }): void;
}

/**
 * The card, centred on an otherwise empty screen.
 *
 * It sits at the background layer, not the dialog layer: home is what the
 * screen is, so every overlay opened from it draws over the card.
 */
export function createTuiHomeView(
    renderer: RenderContext,
    onRun: (action: HomeAction) => void,
): TuiHomeView {
    let colors = {
        textColor: TUI_TEXT,
        mutedColor: TUI_MUTED,
        accentColor: TUI_ACCENT,
    };
    const box = new BoxRenderable(renderer, {
        id: "home-card",
        border: false,
        width: HOME_CARD_COLUMNS,
        height: "auto",
        flexDirection: "column",
        focusable: true,
    });
    const surface = new BoxRenderable(renderer, {
        id: "home-surface",
        border: false,
        position: "absolute",
        top: 0,
        left: 0,
        width: "100%",
        height: "100%",
        zIndex: DIALOG_BACKGROUND_Z_INDEX,
        alignItems: "center",
        justifyContent: "center",
        visible: false,
    });
    surface.add(box);
    let lines: TextRenderable[] = [];
    let rendered: HomeState | undefined;
    const paint = (state: HomeState): void => {
        for (const line of lines) line.destroyRecursively();
        lines = [];
        for (const [index, line] of homeCardLines(state).entries()) {
            const text = new TextRenderable(renderer, {
                id: `home-line-${index}`,
                content: line.text,
                fg: lineColor(line, colors),
                width: "100%",
                height: 1,
                onMouseDown: line.tone === "row"
                    ? () => onRun(rowActionFor(state, index))
                    : undefined,
            });
            lines.push(text);
            box.add(text);
        }
    };
    return {
        surface,
        box,
        update(state): void {
            rendered = state;
            paint(state);
        },
        applyAppearance(appearance): void {
            colors = appearance;
            if (rendered !== undefined) paint(rendered);
        },
    };
}

/** Which row a click landed on, given its line in the painted card. */
function rowActionFor(state: HomeState, lineIndex: number): HomeAction {
    const rows = homeRows(state);
    const row = rows[lineIndex - HOME_ROWS_START];
    return row === undefined ? { kind: "new_session" } : rowAction(row.id);
}

/** Wordmark, rule, and the blank line under it precede the first row. */
const HOME_ROWS_START = 3;

function lineColor(
    line: HomeLine,
    colors: {
        readonly textColor: string;
        readonly mutedColor: string;
        readonly accentColor: string;
    },
): string {
    if (line.tone === "wordmark") return colors.accentColor;
    if (line.selected === true) return colors.textColor;
    return colors.mutedColor;
}
