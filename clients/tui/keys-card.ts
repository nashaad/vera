import { BoxRenderable, fg, StyledText, TextRenderable, type RenderContext } from "@opentui/core";

import { DIALOG_CARD_Z_INDEX } from "./dialog-chrome.ts";
import { activeTuiKeymap, TUI_KEYMAP, tuiChordLabel, tuiKeyChordLabel, type TuiKeyScope } from "./keymap.ts";
import { TUI_ACCENT, TUI_HUD, TUI_MUTED, TUI_PANEL, TUI_TEXT } from "./palette.ts";

export interface TuiKeysCardRow {
    readonly chord: string;
    readonly label: string;
}

const CARD_SCOPES: readonly TuiKeyScope[] = ["global", "conversation", "composer"];
// Shown only while a turn runs; idle they read as quit or do nothing.
const WORKING_ONLY: ReadonlySet<string> = new Set(["interrupt"]);
const HIDDEN: ReadonlySet<string> = new Set(["open_model_prefix"]);
// Bindings whose hint is the bare chord; their descriptions are too long for a cell.
const SHORT_LABELS: Readonly<Record<string, string>> = {
    jump_to_bottom: "follow bottom",
    "cycle-reasoning": "reasoning level",
};

// The keys that work where you are, from the keymap's own hints, so a remap
// shows here without a second list to update.
export function tuiKeysCardRows(working: boolean): TuiKeysCardRow[] {
    const rows: TuiKeysCardRow[] = working ? [{ chord: "esc", label: "stop" }] : [];
    for (const binding of activeTuiKeymap()) {
        if (!CARD_SCOPES.includes(binding.scope) || binding.hint === undefined || binding.hint === "") continue;
        if (HIDDEN.has(binding.id) || (!working && WORKING_ONLY.has(binding.id))) continue;
        rows.push({ chord: tuiKeyChordLabel(binding.id), label: hintLabel(binding.id, binding.hint, binding.description) });
    }
    const prefix = tuiKeyChordLabel("open_model_prefix");
    rows.push(
        { chord: `${prefix} ${tuiKeyChordLabel("model_prefix_open")}`, label: "models" },
        { chord: `${prefix} ${tuiKeyChordLabel("model_prefix_keys")}`, label: "this card" },
    );
    return rows;
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

const CELL_GAP = 4;
const MIN_LABEL = 12;
// A longer label is cut rather than collapsing the card to one column.
const MAX_LABEL = 20;

// Rows fill top to bottom, then the next column, like a which-key menu.
export function layoutTuiKeysCard(rows: readonly TuiKeysCardRow[], width: number): TuiKeysCardLayout {
    const chordColumns = Math.max(0, ...rows.map((row) => Bun.stringWidth(row.chord)));
    const labelColumns = Math.min(MAX_LABEL, Math.max(MIN_LABEL, ...rows.map((row) => Bun.stringWidth(row.label))));
    const natural = chordColumns + 2 + labelColumns;
    const columns = Math.max(1, Math.min(3, Math.floor((width + CELL_GAP) / (natural + CELL_GAP))));
    const cellColumns = Math.min(natural, Math.floor((width - CELL_GAP * (columns - 1)) / columns));
    const height = Math.ceil(rows.length / columns);
    const lines = Array.from({ length: height }, (_unused, line) =>
        Array.from({ length: columns }, (_unused, column) => rows[column * height + line])
            .filter((row): row is TuiKeysCardRow => row !== undefined)
    );
    return { lines, chordColumns, cellColumns };
}

export interface TuiKeysCardView {
    readonly box: BoxRenderable;
    update(rows: readonly TuiKeysCardRow[], width: number): void;
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
        update(rows, width) {
            const layout = layoutTuiKeysCard(rows, width);
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
            chunks.push(fg(muted)("\n\n/help every key · esc close"));
            box.backgroundColor = TUI_HUD?.background ?? TUI_PANEL;
            text.height = layout.lines.length + 4;
            box.height = text.height + 2;
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
