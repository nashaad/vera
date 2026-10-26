import { BoxRenderable, fg, StyledText, TextRenderable, type RenderContext } from "@opentui/core";

import { DIALOG_CARD_Z_INDEX } from "./dialog-chrome.ts";
import { activeTuiKeymap, TUI_KEYMAP, tuiChordLabel, tuiKeyChordLabel, type TuiKeyScope } from "./keymap.ts";
import { TUI_ACCENT, TUI_HUD, TUI_MUTED, TUI_PANEL, TUI_TEXT } from "./palette.ts";

export interface TuiKeysCardRow {
    readonly chord: string;
    readonly label: string;
}

// Stopping is a turn whose abort is in flight: Esc does nothing and Ctrl+C quits.
export type TuiKeysCardTurn = "idle" | "working" | "stopping";

export const TUI_KEYS_CARD_TURNS: readonly TuiKeysCardTurn[] = ["idle", "working", "stopping"];

const CARD_SCOPES: readonly TuiKeyScope[] = ["global", "conversation", "composer"];
const HIDDEN: ReadonlySet<string> = new Set(["open_model_prefix", "interrupt"]);
// Bindings whose hint is the bare chord; their descriptions are too long for a cell.
const SHORT_LABELS: Readonly<Record<string, string>> = {
    jump_to_bottom: "follow bottom",
    "cycle-reasoning": "reasoning level",
};
// The card already has its own "close" line, so these read differently here.
const CARD_LABELS: Readonly<Record<string, string>> = {
    close_session: "park",
};

// The keys that work where you are, from the keymap's own hints, so a remap
// shows here without a second list to update. Every turn has the same row
// count, so the card keeps its shape when a turn starts or ends.
export function tuiKeysCardRows(turn: TuiKeysCardTurn): TuiKeysCardRow[] {
    const rows: TuiKeysCardRow[] = [stopRow(turn)];
    for (const binding of activeTuiKeymap()) {
        if (!CARD_SCOPES.includes(binding.scope) || binding.hint === undefined || binding.hint === "") continue;
        if (HIDDEN.has(binding.id)) continue;
        rows.push({
            chord: tuiKeyChordLabel(binding.id),
            label: CARD_LABELS[binding.id] ?? hintLabel(binding.id, binding.hint, binding.description),
        });
    }
    const prefix = tuiKeyChordLabel("open_model_prefix");
    rows.push(
        { chord: `${prefix} ${tuiKeyChordLabel("model_prefix_sidebar")}`, label: "sidebar" },
        { chord: `${prefix} ${tuiKeyChordLabel("model_prefix_open")}`, label: "models" },
        { chord: `${prefix} ${tuiKeyChordLabel("model_prefix_keys")}`, label: "this card" },
    );
    return rows;
}

function stopRow(turn: TuiKeysCardTurn): TuiKeysCardRow {
    const interrupt = tuiKeyChordLabel("interrupt");
    if (turn === "working") return { chord: `esc or ${interrupt}`, label: "stop" };
    if (turn === "stopping") return { chord: interrupt, label: "quit" };
    // Idle, one press only arms the quit.
    return { chord: `${interrupt} ${interrupt}`, label: "quit" };
}

// A running turn owns Esc, so the card names the keys that still close it.
export function tuiKeysCardFooter(turn: TuiKeysCardTurn): string {
    const close = turn === "idle"
        ? "esc"
        : `${tuiKeyChordLabel("open_model_prefix")} ${tuiKeyChordLabel("model_prefix_keys")}`;
    return `/help every key · ${close} close`;
}

// Hints are written with the default chord in front: "Ctrl+P commands".
function hintLabel(id: string, hint: string, description: string): string {
    const original = TUI_KEYMAP.find((binding) => binding.id === id)?.keys[0];
    const chord = original === undefined ? "" : tuiChordLabel(original);
    if (hint === chord) return SHORT_LABELS[id] ?? description;
    return hint.startsWith(`${chord} `) ? hint.slice(chord.length + 1) : hint;
}

export interface TuiKeysCardLayout {
    readonly lines: readonly (readonly { readonly chord: string; readonly label: string }[])[];
    readonly chordColumns: number;
    readonly cellColumns: number;
}

export interface TuiKeysCardFit {
    // Rows whose widths set the cells, so cells hold still while the rows change.
    readonly sizing?: readonly TuiKeysCardRow[];
    // Rows past maxLines in every column are left off; /help still lists them.
    readonly maxLines?: number;
}

const CELL_GAP = 4;
const MIN_LABEL = 12;
// A longer label is cut rather than collapsing the card to one column.
const MAX_LABEL = 20;

// Rows fill top to bottom, then the next column, like a which-key menu.
export function layoutTuiKeysCard(
    rows: readonly TuiKeysCardRow[],
    width: number,
    fit: TuiKeysCardFit = {},
): TuiKeysCardLayout {
    const sizing = fit.sizing ?? rows;
    const chordColumns = Math.max(0, ...sizing.map((row) => Bun.stringWidth(row.chord)));
    const labelColumns = Math.min(MAX_LABEL, Math.max(MIN_LABEL, ...sizing.map((row) => Bun.stringWidth(row.label))));
    const natural = chordColumns + 2 + labelColumns;
    const columns = Math.max(1, Math.min(3, Math.floor((width + CELL_GAP) / (natural + CELL_GAP))));
    const cellColumns = Math.min(natural, Math.floor((width - CELL_GAP * (columns - 1)) / columns));
    const height = Math.min(Math.ceil(rows.length / columns), Math.max(1, fit.maxLines ?? Infinity));
    const lines = Array.from({ length: height }, (_unused, line) =>
        Array.from({ length: columns }, (_unused, column) => rows[column * height + line])
            .filter((row): row is TuiKeysCardRow => row !== undefined)
    );
    return { lines, chordColumns, cellColumns };
}

// The card around its lines: padding, the title and the blank under it, the
// blank and closing line under the keys, and the gap above the composer.
export const TUI_KEYS_CARD_CHROME_ROWS = 7;

export interface TuiKeysCardView {
    readonly box: BoxRenderable;
    update(turn: TuiKeysCardTurn, width: number, maxLines: number): void;
}

export function createTuiKeysCardView(renderer: RenderContext): TuiKeysCardView {
    const text = new TextRenderable(renderer, {
        id: "keys-card-text",
        content: "",
        fg: TUI_TEXT,
        width: "100%",
        wrapMode: "none",
    });
    const box = new BoxRenderable(renderer, {
        id: "keys-card",
        // No borderColor either: OpenTUI treats any border* option as wanting a border.
        border: false,
        backgroundColor: TUI_HUD?.background ?? TUI_PANEL,
        marginBottom: 1,
        paddingTop: 1,
        paddingBottom: 1,
        flexDirection: "column",
        flexShrink: 0,
        zIndex: DIALOG_CARD_Z_INDEX,
        visible: false,
    });
    box.add(text);
    return {
        box,
        update(turn, width, maxLines) {
            const layout = layoutTuiKeysCard(tuiKeysCardRows(turn), width, {
                sizing: TUI_KEYS_CARD_TURNS.flatMap((each) => tuiKeysCardRows(each)),
                maxLines,
            });
            const muted = TUI_HUD?.muted ?? TUI_MUTED;
            const accent = TUI_HUD?.accent ?? TUI_ACCENT;
            const plain = TUI_HUD?.text ?? TUI_TEXT;
            const labelColumns = Math.max(1, layout.cellColumns - layout.chordColumns - 2);
            const chunks = [fg(accent)("Keys"), fg(muted)("\n\n")];
            layout.lines.forEach((line, index) => {
                line.forEach((row, column) => {
                    const label = fitLabel(row.label, labelColumns);
                    const pad = column === line.length - 1
                        ? ""
                        : " ".repeat(labelColumns - Bun.stringWidth(label) + CELL_GAP);
                    chunks.push(fg(plain)(row.chord.padEnd(layout.chordColumns + 2)), fg(muted)(`${label}${pad}`));
                });
                if (index < layout.lines.length - 1) chunks.push(fg(muted)("\n"));
            });
            chunks.push(fg(muted)(`\n\n${tuiKeysCardFooter(turn)}`));
            box.backgroundColor = TUI_HUD?.background ?? TUI_PANEL;
            // The height getter reads the last layout, which is 0 before the first open.
            const textHeight = layout.lines.length + 4;
            text.height = textHeight;
            box.height = textHeight + 2;
            text.content = new StyledText(chunks);
        },
    };
}

function fitLabel(label: string, columns: number): string {
    if (Bun.stringWidth(label) <= columns) return label;
    let out = "";
    for (const character of label) {
        if (Bun.stringWidth(`${out}${character}…`) > columns) break;
        out += character;
    }
    return `${out}…`;
}
