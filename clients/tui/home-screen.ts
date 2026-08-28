import {
    BoxRenderable,
    parseColor,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import { DIALOG_BACKGROUND_Z_INDEX } from "./dialog-chrome.ts";
import { TUI_ACCENT, TUI_MUTED, TUI_TEXT } from "./state.ts";

/** The letterspaced name at the head of the card. */
export const HOME_WORDMARK = "V  E  R  A";

/** The last line of the card: the composer is not on screen to say it. */
export const HOME_TYPING_HINT = "or just start typing";

export type HomeRowId = "new" | "all" | "search" | "commands";

export interface HomeRow {
    readonly id: HomeRowId;
    readonly label: string;
    readonly keyHint: string;
}

/** Every row the card knows, whether or not this machine offers all of them. */
const HOME_ROWS: readonly HomeRow[] = [
    { id: "new", label: "New conversation", keyHint: "enter" },
    { id: "all", label: "All conversations", keyHint: "ctrl+r" },
    { id: "search", label: "Search past work", keyHint: "ctrl+shift+f" },
    { id: "commands", label: "Commands", keyHint: "ctrl+p" },
];

/**
 * The column the labels start on, past the one the cursor claims.
 *
 * The rule and the typing hint start here too, so the card has one left edge
 * rather than one per kind of line.
 */
export const HOME_CONTENT_INDENT = 2;

/**
 * The column every key hint starts on.
 *
 * The hints are a column, so they line up on their left edge: `enter` and
 * `ctrl+r` are different lengths, and hanging them off their right edges
 * staggers the letter the eye lands on first. The column clears the longest
 * label the card knows, including one this machine is not showing, so the
 * hints do not move when a row is absent.
 */
const HOME_HINT_COLUMN = HOME_CONTENT_INDENT
    + Math.max(...HOME_ROWS.map((row) => row.label.length)) + 2;

/** Every column the card occupies, rule and rows alike. */
export const HOME_CARD_COLUMNS = HOME_HINT_COLUMN
    + Math.max(...HOME_ROWS.map((row) => row.keyHint.length));

/** The line under the wordmark, run to the far edge of the hint column. */
export const HOME_RULE = "─".repeat(
    HOME_CARD_COLUMNS - HOME_CONTENT_INDENT,
);

/** The column the caret parks on: a space past the end of the typing hint. */
const HOME_HINT_CARET_COLUMN = HOME_CONTENT_INDENT
    + HOME_TYPING_HINT.length + 1;

export interface HomeState {
    readonly selectedId: HomeRowId;
    /** False on a machine with no conversations yet: the row is absent. */
    readonly hasSessions: boolean;
}

export type HomeAction =
    | { readonly kind: "new_session" }
    | { readonly kind: "resume_picker" }
    | { readonly kind: "search" }
    | { readonly kind: "palette" }
    | { readonly kind: "type"; readonly text: string };

export function createHomeState(hasSessions: boolean): HomeState {
    return { selectedId: "new", hasSessions };
}

/** The rows that need a past to act on, so a new machine offers neither. */
const HOME_PAST_ROWS: readonly HomeRowId[] = ["all", "search"];

/**
 * The chords the card answers itself.
 *
 * `Commands` and `Search past work` are on the card as well, but `ctrl+p` and
 * `ctrl+shift+f` are global bindings: home lets them fall through to the one
 * place that owns them rather than becoming a second way in.
 */
const HOME_OWN_CHORDS: readonly HomeRowId[] = ["all"];

/**
 * The rows on offer.
 *
 * A machine with no conversations has nothing to list and nothing to search,
 * so those rows are absent rather than greyed: a card where a row is dead
 * reads as a menu that is broken, not as a machine that is new.
 */
export function homeRows(state: HomeState): readonly HomeRow[] {
    return HOME_ROWS.filter((row) =>
        state.hasSessions || !HOME_PAST_ROWS.includes(row.id)
    );
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
        { text: `${indent()}${HOME_RULE}`, tone: "rule" },
        { text: "", tone: "rule" },
        ...rows.map((row) => ({
            text: rowText(row, row.id === selected),
            tone: "row" as const,
            selected: row.id === selected,
        })),
        { text: "", tone: "rule" },
        {
            text: `${indent()}${HOME_TYPING_HINT}`,
            tone: "hint" as const,
        },
    ];
}

/**
 * What a key does on the home card.
 *
 * Arrows move the cursor, Enter runs the row it is on, and a row's chord runs
 * it from anywhere on the card. Every plain character is the first one of a
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
        // A chord for a row this machine is not offering does nothing, so the
        // card never opens a surface its own list says is not there.
        const chord = rows.find((row) =>
            HOME_OWN_CHORDS.includes(row.id)
            && row.keyHint === `ctrl+${key.name}`
        );
        return chord === undefined
            ? { handled: false }
            : { action: rowAction(chord.id), handled: true };
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
    if (id === "search") return { kind: "search" };
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
    const gap = Math.max(1, HOME_HINT_COLUMN - head.length);
    return `${head}${" ".repeat(gap)}${row.keyHint}`;
}

/** Centred over the content, which starts past the cursor column. */
function centered(text: string): string {
    const width = HOME_CARD_COLUMNS - HOME_CONTENT_INDENT;
    const lead = Math.max(0, Math.floor((width - text.length) / 2));
    return `${indent()}${" ".repeat(lead)}${text}`;
}

function indent(): string {
    return " ".repeat(HOME_CONTENT_INDENT);
}

function isPrintable(key: { readonly name: string }): boolean {
    return key.name.length === 1 || key.name === "space";
}

/**
 * The hint line, which parks the terminal's own cursor a space past its end.
 *
 * Home draws no composer, so nothing else claims the cursor and it stays in
 * the corner of the screen. The caret is what says typing works here, so it
 * belongs beside the line that says so. It is parked only while the card holds
 * the keyboard, so a rail that has taken focus does not leave a caret sitting
 * on the card behind it.
 */
class HomeHintRenderable extends TextRenderable {
    holdsKeyboard: () => boolean = () => true;

    protected override renderSelf(
        buffer: Parameters<TextRenderable["renderSelf"]>[0],
    ): void {
        super.renderSelf(buffer);
        if (!this.holdsKeyboard()) return;
        // One-based: the terminal counts its own cursor from column and row 1.
        this._ctx.setCursorPosition(
            this.x + HOME_HINT_CARET_COLUMN + 1,
            this.y + 1,
            true,
        );
    }

    protected override destroySelf(): void {
        this._ctx.setCursorPosition(0, 0, false);
        super.destroySelf();
    }
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
    renderer.setCursorStyle({
        style: "block",
        blinking: true,
        color: parseColor(TUI_ACCENT),
    });
    let lines: TextRenderable[] = [];
    let rendered: HomeState | undefined;
    const paint = (state: HomeState): void => {
        for (const line of lines) line.destroyRecursively();
        lines = [];
        for (const [index, line] of homeCardLines(state).entries()) {
            const options = {
                id: `home-line-${index}`,
                content: line.text,
                fg: lineColor(line, colors),
                width: "100%" as const,
                height: 1,
                onMouseDown: line.tone === "row"
                    ? () => onRun(rowActionFor(state, index))
                    : undefined,
            };
            let text: TextRenderable;
            if (line.tone === "hint") {
                const hint = new HomeHintRenderable(renderer, options);
                hint.holdsKeyboard = () => box.focused;
                text = hint;
            } else {
                text = new TextRenderable(renderer, options);
            }
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
