import {
    BoxRenderable,
    parseColor,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import { DIALOG_BACKGROUND_Z_INDEX } from "./dialog-chrome.ts";
import { TUI_ACCENT, TUI_MUTED, TUI_TEXT } from "./state.ts";

export const HOME_WORDMARK = "V  E  R  A";

export const HOME_TYPING_HINT = "or just start typing";

export const HOME_COLD_HINT = "Vera has no provider yet";

export type HomeRowId = "connect" | "new" | "all" | "search" | "commands";

export interface HomeRow {
    readonly id: HomeRowId;
    readonly label: string;
    readonly keyHint: string;
}

const HOME_ROWS: readonly HomeRow[] = [
    { id: "connect", label: "Connect a provider", keyHint: "enter" },
    { id: "new", label: "New conversation", keyHint: "enter" },
    { id: "all", label: "All conversations", keyHint: "ctrl+r" },
    { id: "search", label: "Search past work", keyHint: "ctrl+shift+f" },
    { id: "commands", label: "Commands", keyHint: "ctrl+p" },
];

export const HOME_CONTENT_INDENT = 2;

const HOME_HINT_COLUMN = HOME_CONTENT_INDENT
    + Math.max(...HOME_ROWS.map((row) => row.label.length)) + 2;

export const HOME_CARD_COLUMNS = HOME_HINT_COLUMN
    + Math.max(...HOME_ROWS.map((row) => row.keyHint.length));

export const HOME_RULE = "─".repeat(
    HOME_CARD_COLUMNS - HOME_CONTENT_INDENT,
);

function hintCaretColumn(hint: string): number {
    return HOME_CONTENT_INDENT + hint.length + 1;
}

export interface HomeState {
    readonly selectedId: HomeRowId;
    readonly hasSessions: boolean;
    /** No provider has answered yet, so the card leads with the way to fix that. */
    readonly needsProvider: boolean;
}

export type HomeAction =
    | { readonly kind: "connect_provider" }
    | { readonly kind: "new_session" }
    | { readonly kind: "resume_picker" }
    | { readonly kind: "search" }
    | { readonly kind: "palette" }
    | { readonly kind: "type"; readonly text: string };

export function createHomeState(
    hasSessions: boolean,
    needsProvider = false,
): HomeState {
    return {
        selectedId: needsProvider ? "connect" : "new",
        hasSessions,
        needsProvider,
    };
}

const HOME_PAST_ROWS: readonly HomeRowId[] = ["all", "search"];

const HOME_OWN_CHORDS: readonly HomeRowId[] = ["all"];

export function homeRows(state: HomeState): readonly HomeRow[] {
    const rows = HOME_ROWS.filter((row) =>
        (row.id !== "connect" || state.needsProvider)
        && (state.hasSessions || !HOME_PAST_ROWS.includes(row.id))
    );
    // Only one row can claim enter, and while a provider is missing it is the
    // one that leads there.
    return rows.map((row) =>
        state.needsProvider && row.id === "new" ? { ...row, keyHint: "" } : row
    );
}

export type HomeLineTone =
    | "wordmark"
    | "rule"
    | "notice"
    | "row"
    | "hint";

export interface HomeLine {
    readonly text: string;
    readonly tone: HomeLineTone;
    readonly rowId?: HomeRowId;
    readonly selected?: boolean;
}

const BLANK: HomeLine = { text: "", tone: "rule" };

export function homeCardLines(state: HomeState): readonly HomeLine[] {
    const selected = selectedRowId(state);
    const rows = homeRows(state).flatMap((row) => {
        const line: HomeLine = {
            text: rowText(row, row.id === selected),
            tone: "row",
            rowId: row.id,
            selected: row.id === selected,
        };
        // The row that leads out of a cold start stands on its own, so the
        // rows that need a provider first do not read as alternatives to it.
        return row.id === "connect" ? [line, BLANK] : [line];
    });
    if (state.needsProvider) {
        return [
            { text: centered(HOME_WORDMARK), tone: "wordmark" },
            { text: `${indent()}${HOME_RULE}`, tone: "rule" },
            BLANK,
            // Above the rows, where the reason for the first one belongs. Below
            // them it read as a status line about something already decided.
            { text: `${indent()}${HOME_COLD_HINT}`, tone: "notice" },
            BLANK,
            ...rows,
        ];
    }
    return [
        { text: centered(HOME_WORDMARK), tone: "wordmark" },
        { text: `${indent()}${HOME_RULE}`, tone: "rule" },
        BLANK,
        ...rows,
        BLANK,
        { text: `${indent()}${HOME_TYPING_HINT}`, tone: "hint" },
    ];
}

/** The line the caret sits on, which exists only while there is somewhere to send a prompt. */
export function homeHint(state: HomeState): string | undefined {
    return state.needsProvider ? undefined : HOME_TYPING_HINT;
}

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
        const chord = rows.find((row) =>
            HOME_OWN_CHORDS.includes(row.id)
            && row.keyHint === `ctrl+${key.name}`
        );
        return chord === undefined
            ? { handled: false }
            : { action: rowAction(chord.id, state), handled: true };
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
        return { action: rowAction(selectedRowId(state), state), handled: true };
    }
    const typed = homeTypedCharacter(key);
    if (typed !== undefined) {
        return { action: { kind: "type", text: typed }, handled: true };
    }
    return { handled: false };
}

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

function rowAction(id: HomeRowId, state: HomeState): HomeAction {
    if (id === "connect") return { kind: "connect_provider" };
    if (id === "all") return { kind: "resume_picker" };
    if (id === "search") return { kind: "search" };
    if (id === "commands") return { kind: "palette" };
    // A conversation with nothing to answer it is not a conversation, so the
    // row that would open one leads to the provider instead.
    return state.needsProvider
        ? { kind: "connect_provider" }
        : { kind: "new_session" };
}

function selectedRowId(state: HomeState): HomeRowId {
    const rows = homeRows(state);
    if (rows.some((row) => row.id === state.selectedId)) {
        return state.selectedId;
    }
    return state.needsProvider ? "connect" : "new";
}

function rowText(row: HomeRow, selected: boolean): string {
    const head = `${selected ? "❯" : " "} ${row.label}`;
    if (row.keyHint === "") return head;
    const gap = Math.max(1, HOME_HINT_COLUMN - head.length);
    return `${head}${" ".repeat(gap)}${row.keyHint}`;
}

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

class HomeHintRenderable extends TextRenderable {
    holdsKeyboard: () => boolean = () => true;

    caretColumn = hintCaretColumn(HOME_TYPING_HINT);

    protected override renderSelf(
        buffer: Parameters<TextRenderable["renderSelf"]>[0],
    ): void {
        super.renderSelf(buffer);
        if (!this.holdsKeyboard()) return;
        this._ctx.setCursorPosition(
            this.x + this.caretColumn + 1,
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
                hint.caretColumn = hintCaretColumn(HOME_TYPING_HINT);
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

function rowActionFor(state: HomeState, lineIndex: number): HomeAction {
    const id = homeCardLines(state)[lineIndex]?.rowId;
    return id === undefined ? { kind: "new_session" } : rowAction(id, state);
}

function lineColor(
    line: HomeLine,
    colors: {
        readonly textColor: string;
        readonly mutedColor: string;
        readonly accentColor: string;
    },
): string {
    if (line.tone === "wordmark") return colors.accentColor;
    if (line.tone === "notice") return colors.textColor;
    if (line.selected === true) return colors.textColor;
    return colors.mutedColor;
}
