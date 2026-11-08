import {
    bg,
    BoxRenderable,
    fg,
    parseColor,
    StyledText,
    TextRenderable,
    type RenderContext,
} from "@opentui/core";

import type { RestartCause } from "../../src/store/restart-records.ts";
import { DIALOG_BACKGROUND_Z_INDEX } from "./dialog-chrome.ts";
import { tuiBindingId, tuiKeyHint } from "./keymap.ts";
import {
    TUI_ACCENT,
    TUI_BACKGROUND,
    TUI_MUTED,
    TUI_SUCCESS,
    TUI_TEXT,
} from "./state.ts";

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
    { id: "all", label: "All conversations", keyHint: "Ctrl+R" },
    { id: "search", label: "Search past work", keyHint: "Ctrl+Shift+F" },
    { id: "commands", label: "Commands", keyHint: "Ctrl+P" },
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

/** A session whose turn a restart or crash cut short, listed above the rows. */
export interface HomeRestart {
    readonly sessionId: string;
    readonly sessionPath: string;
    readonly title: string;
    readonly cause: RestartCause;
}

export interface HomeState {
    readonly selectedId: HomeRowId;
    readonly hasSessions: boolean;
    /** No provider has answered yet, so the card leads with the way to fix that. */
    readonly needsProvider: boolean;
    readonly restarts: readonly HomeRestart[];
    /** Set while the cursor is on a restart entry; the rows then show no cursor. */
    readonly selectedRestartId: string | undefined;
}

export type HomeAction =
    | { readonly kind: "connect_provider" }
    | { readonly kind: "new_session" }
    | { readonly kind: "resume_picker" }
    | { readonly kind: "search" }
    | { readonly kind: "palette" }
    | { readonly kind: "open_restart"; readonly sessionId: string }
    | { readonly kind: "dismiss_restart"; readonly sessionId: string }
    | { readonly kind: "command" }
    | { readonly kind: "type"; readonly text: string };

export function createHomeState(
    hasSessions: boolean,
    needsProvider = false,
): HomeState {
    return {
        selectedId: needsProvider ? "connect" : "new",
        hasSessions,
        needsProvider,
        restarts: [],
        selectedRestartId: undefined,
    };
}

/** Replaces the restart block. A cursor on an entry that is no longer listed moves to the rows. */
export function homeStateWithRestarts(
    state: HomeState,
    restarts: readonly HomeRestart[],
): HomeState {
    const kept = restarts.some((restart) =>
        restart.sessionId === state.selectedRestartId
    );
    return {
        ...state,
        restarts,
        selectedRestartId: kept ? state.selectedRestartId : undefined,
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
    | "restart"
    | "block"
    | "hint";

/** The half-open column range a row fills, which is how a row is drawn as a button. */
export interface HomeLineFill {
    readonly from: number;
    readonly to: number;
}

export interface HomeLine {
    readonly text: string;
    readonly tone: HomeLineTone;
    readonly rowId?: HomeRowId;
    readonly restartId?: string;
    readonly selected?: boolean;
    readonly fill?: HomeLineFill;
}

const BLANK: HomeLine = { text: "", tone: "rule" };

export function homeCardLines(state: HomeState): readonly HomeLine[] {
    const selected = state.selectedRestartId === undefined
        ? selectedRowId(state)
        : undefined;
    const rows = homeRows(state).flatMap((row) => {
        const line: HomeLine = {
            text: rowText(row, row.id === selected),
            tone: "row",
            rowId: row.id,
            selected: row.id === selected,
            ...(row.id === "connect" ? { fill: BUTTON_FILL } : {}),
        };
        // The row that leads out of a cold start stands on its own, so the
        // rows that need a provider first do not read as alternatives to it.
        return row.id === "connect" ? [line, BLANK] : [line];
    });
    const block = restartBlockLines(state);
    if (state.needsProvider) {
        return [
            { text: centered(HOME_WORDMARK), tone: "wordmark" },
            { text: `${indent()}${HOME_RULE}`, tone: "rule" },
            BLANK,
            ...block,
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
        ...block,
        ...rows,
        BLANK,
        { text: `${indent()}${HOME_TYPING_HINT}`, tone: "hint" },
    ];
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
    if (
        state.selectedRestartId !== undefined
        && key.ctrl !== true
        && tuiBindingId("home", key) === "home_dismiss_restart"
    ) {
        return {
            action: { kind: "dismiss_restart", sessionId: state.selectedRestartId },
            handled: true,
        };
    }
    if (key.ctrl === true) {
        const chord = rows.find((row) =>
            HOME_OWN_CHORDS.includes(row.id)
            && row.keyHint.toLowerCase() === `ctrl+${key.name}`
        );
        return chord === undefined
            ? { handled: false }
            : { action: rowAction(chord.id, state), handled: true };
    }
    if (key.meta === true || key.super === true || key.hyper === true) {
        return { handled: false };
    }
    if (key.name === "up" || key.name === "down") {
        const entries = homeEntries(state);
        const current = entries.findIndex((entry) => entryIsSelected(entry, state));
        const next = entries[
            (current + (key.name === "down" ? 1 : entries.length - 1)) % entries.length
        ];
        if (next === undefined) return { handled: true };
        return {
            state: next.kind === "restart"
                ? { ...state, selectedRestartId: next.sessionId }
                : { ...state, selectedId: next.rowId, selectedRestartId: undefined },
            handled: true,
        };
    }
    if (key.name === "return" || key.name === "enter") {
        if (state.selectedRestartId !== undefined) {
            return {
                action: { kind: "open_restart", sessionId: state.selectedRestartId },
                handled: true,
            };
        }
        return { action: rowAction(selectedRowId(state), state), handled: true };
    }
    const typed = homeTypedCharacter(key);
    if (typed !== undefined) {
        if (typed === "/") return { action: { kind: "command" }, handled: true };
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

type HomeEntry =
    | { readonly kind: "restart"; readonly sessionId: string }
    | { readonly kind: "row"; readonly rowId: HomeRowId };

/** Restart entries come first, then the rows, so Up and Down move through the card as one list. */
function homeEntries(state: HomeState): readonly HomeEntry[] {
    return [
        ...state.restarts.map((restart): HomeEntry => ({
            kind: "restart",
            sessionId: restart.sessionId,
        })),
        ...homeRows(state).map((row): HomeEntry => ({
            kind: "row",
            rowId: row.id,
        })),
    ];
}

function entryIsSelected(entry: HomeEntry, state: HomeState): boolean {
    if (entry.kind === "restart") {
        return entry.sessionId === state.selectedRestartId;
    }
    return state.selectedRestartId === undefined
        && entry.rowId === selectedRowId(state);
}

const HOME_RESTART_WINDOW = 3;

const HOME_RESTART_CAUSE_WORDS: Readonly<Record<RestartCause, string>> = {
    stop: "stopped",
    update: "updated",
    crash: "crashed",
};

const HOME_RESTART_CAUSE_COLUMNS = Math.max(
    ...Object.values(HOME_RESTART_CAUSE_WORDS).map((word) => word.length),
);

const HOME_RESTART_TITLE_COLUMNS = HOME_CARD_COLUMNS
    - HOME_CONTENT_INDENT
    - "❯ ".length
    - 1
    - HOME_RESTART_CAUSE_COLUMNS;

/**
 * Shows a window of the restart entries around the cursor, and a footer that
 * names the two keys. A restart-free home has no block at all.
 */
function restartBlockLines(state: HomeState): readonly HomeLine[] {
    if (state.restarts.length === 0) return [];
    const count = state.restarts.length;
    const cursor = state.restarts.findIndex((restart) =>
        restart.sessionId === state.selectedRestartId
    );
    const start = cursor < 0
        ? 0
        : Math.min(Math.max(0, cursor - 1), Math.max(0, count - HOME_RESTART_WINDOW));
    const visible = state.restarts.slice(start, start + HOME_RESTART_WINDOW);
    return [
        { text: `${indent()}Cut short (${count})`, tone: "notice" },
        ...visible.map((restart): HomeLine => {
            const selected = restart.sessionId === state.selectedRestartId;
            return {
                text: restartText(restart, selected),
                tone: "restart",
                restartId: restart.sessionId,
                selected,
            };
        }),
        {
            text: `${indent()}enter opens  ${tuiKeyHint("home_dismiss_restart")}`,
            tone: "block",
        },
        BLANK,
    ];
}

function restartText(restart: HomeRestart, selected: boolean): string {
    const marker = selected ? "❯" : " ";
    const title = restart.title.replace(/\s+/g, " ").trim();
    const fitted = title.length > HOME_RESTART_TITLE_COLUMNS
        ? `${title.slice(0, HOME_RESTART_TITLE_COLUMNS - 1)}…`
        : title.padEnd(HOME_RESTART_TITLE_COLUMNS);
    const cause = HOME_RESTART_CAUSE_WORDS[restart.cause].padStart(
        HOME_RESTART_CAUSE_COLUMNS,
    );
    return `${indent()}${marker} ${fitted} ${cause}`;
}

function selectedRowId(state: HomeState): HomeRowId {
    const rows = homeRows(state);
    if (rows.some((row) => row.id === state.selectedId)) {
        return state.selectedId;
    }
    return state.needsProvider ? "connect" : "new";
}

/**
 * The one row that leads out of a cold start is drawn as a filled button, so
 * it reads as the thing to press rather than as the first of five lines. The
 * space either side of its label is inside the fill, which is why the label
 * starts a column earlier than every other row and the key hints still line up.
 */
const BUTTON_FILL: HomeLineFill = {
    from: 1,
    to: 1 + "Connect a provider".length + 2,
};

function rowText(row: HomeRow, selected: boolean): string {
    const marker = selected ? "❯" : " ";
    const head = row.id === "connect"
        ? `${marker} ${row.label} `
        : `${marker} ${row.label}`;
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

export interface HomeAppearance {
    readonly textColor: string;
    readonly mutedColor: string;
    readonly accentColor: string;
    readonly successColor: string;
    readonly backgroundColor: string;
}

export interface TuiHomeView {
    readonly surface: BoxRenderable;
    readonly box: BoxRenderable;
    update(state: HomeState): void;
    applyAppearance(appearance: HomeAppearance): void;
}

export function createTuiHomeView(
    renderer: RenderContext,
    onRun: (action: HomeAction) => void,
): TuiHomeView {
    let colors: HomeAppearance = {
        textColor: TUI_TEXT,
        mutedColor: TUI_MUTED,
        accentColor: TUI_ACCENT,
        successColor: TUI_SUCCESS,
        backgroundColor: TUI_BACKGROUND,
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
                content: lineContent(line, colors),
                fg: lineColor(line, colors),
                width: "100%" as const,
                height: 1,
                onMouseDown: line.tone === "row" || line.tone === "restart"
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
    const line = homeCardLines(state)[lineIndex];
    if (line?.restartId !== undefined) {
        return { kind: "open_restart", sessionId: line.restartId };
    }
    const id = line?.rowId;
    return id === undefined ? { kind: "new_session" } : rowAction(id, state);
}

/** A filled row is three spans: the marker, the button, and the key hint beside it. */
function lineContent(
    line: HomeLine,
    colors: HomeAppearance,
): string | StyledText {
    if (line.fill === undefined) return line.text;
    const around = fg(lineColor(line, colors));
    return new StyledText([
        around(line.text.slice(0, line.fill.from)),
        bg(colors.successColor)(
            fg(colors.backgroundColor)(
                line.text.slice(line.fill.from, line.fill.to),
            ),
        ),
        around(line.text.slice(line.fill.to)),
    ]);
}

function lineColor(
    line: HomeLine,
    colors: HomeAppearance,
): string {
    if (line.tone === "wordmark") return colors.accentColor;
    if (line.tone === "notice") return colors.textColor;
    if (line.selected === true) return colors.textColor;
    return colors.mutedColor;
}
