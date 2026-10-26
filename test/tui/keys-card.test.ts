import { expect, test } from "bun:test";

import { layoutTuiKeysCard, TUI_KEYS_CARD_TURNS, tuiKeysCardFooter, tuiKeysCardRows } from "../../clients/tui/keys-card.ts";
import { activeTuiKeymap, installTuiKeymap } from "../../clients/tui/keymap.ts";

test("idle leads with the quit press instead of the stop keys", () => {
    const rows = tuiKeysCardRows("idle");
    expect(rows[0]).toEqual({ chord: "Ctrl+C Ctrl+C", label: "quit" });
    expect(rows[1]).toEqual({ chord: "Ctrl+P", label: "commands" });
    expect(rows.map((row) => row.label)).not.toContain("stop");
    expect(rows.map((row) => row.chord)).not.toContain("Ctrl+X");
    expect(rows.slice(-3)).toEqual([
        { chord: "Ctrl+X b", label: "sidebar" },
        { chord: "Ctrl+X m", label: "models" },
        { chord: "Ctrl+X h", label: "this card" },
    ]);
});

test("a running turn leads with one stop row for Esc and Ctrl+C", () => {
    const rows = tuiKeysCardRows("working");
    expect(rows[0]).toEqual({ chord: "esc or Ctrl+C", label: "stop" });
    expect(rows.filter((row) => row.label === "stop")).toHaveLength(1);
});

test("while stopping, Ctrl+C reads quit, since one more press quits", () => {
    const rows = tuiKeysCardRows("stopping");
    expect(rows[0]).toEqual({ chord: "Ctrl+C", label: "quit" });
    expect(rows.map((row) => row.label)).not.toContain("stop");
});

test("every turn has the same rows after the first, so nothing shifts", () => {
    const [idle, working, stopping] = TUI_KEYS_CARD_TURNS.map((turn) => tuiKeysCardRows(turn));
    expect(working!.slice(1)).toEqual(idle!.slice(1));
    expect(stopping!.slice(1)).toEqual(idle!.slice(1));
});

test("Ctrl+W reads park, apart from the card's own close line", () => {
    expect(tuiKeysCardRows("idle")).toContainEqual({ chord: "Ctrl+W", label: "park" });
});

test("a running turn names Ctrl+X h as the way to close, since Escape stops", () => {
    expect(tuiKeysCardFooter("idle")).toBe("/help every key · esc close");
    expect(tuiKeysCardFooter("working")).toBe("/help every key · Ctrl+X h close");
    expect(tuiKeysCardFooter("stopping")).toBe("/help every key · Ctrl+X h close");
});

test("a bare-chord hint gets a short label, not its description", () => {
    expect(tuiKeysCardRows("idle")).toContainEqual({ chord: "Ctrl+End", label: "follow bottom" });
});

test("a remapped key shows its new chord", () => {
    const original = activeTuiKeymap();
    try {
        installTuiKeymap(original.map((binding) =>
            binding.id === "open_palette" ? { ...binding, keys: ["ctrl+k"] } : binding
        ));
        expect(tuiKeysCardRows("idle")).toContainEqual({ chord: "Ctrl+K", label: "commands" });
    } finally {
        installTuiKeymap(original);
    }
});

test("rows fill each column top to bottom, up to three columns", () => {
    const rows = Array.from({ length: 7 }, (_unused, index) => ({ chord: `Ctrl+${index}`, label: `crow ${index}` }));
    const wide = layoutTuiKeysCard(rows, 120);
    expect(wide.lines.map((line) => line.map((row) => row.chord))).toEqual([
        ["Ctrl+0", "Ctrl+3", "Ctrl+6"],
        ["Ctrl+1", "Ctrl+4"],
        ["Ctrl+2", "Ctrl+5"],
    ]);
    expect(layoutTuiKeysCard(rows, 20).lines).toHaveLength(7);
});

test("one long label is cut instead of narrowing the card to one column", () => {
    const rows = [
        { chord: "Ctrl+A", label: "anchor" },
        { chord: "Ctrl+B", label: "a label far longer than any cell should ever hold" },
    ];
    expect(layoutTuiKeysCard(rows, 80).lines).toHaveLength(1);
});

test("cells are sized over every turn, so they hold still as the rows change", () => {
    const sizing = TUI_KEYS_CARD_TURNS.flatMap((turn) => tuiKeysCardRows(turn));
    const layouts = TUI_KEYS_CARD_TURNS.map((turn) => layoutTuiKeysCard(tuiKeysCardRows(turn), 100, { sizing }));
    for (const layout of layouts) {
        expect(layout.chordColumns).toBe(layouts[0]!.chordColumns);
        expect(layout.cellColumns).toBe(layouts[0]!.cellColumns);
        expect(layout.lines.map((line) => line.length)).toEqual(layouts[0]!.lines.map((line) => line.length));
    }
});

test("a line cap keeps the card short and leaves off the rows past it", () => {
    const rows = Array.from({ length: 7 }, (_unused, index) => ({ chord: `Ctrl+${index}`, label: `crow ${index}` }));
    const capped = layoutTuiKeysCard(rows, 20, { maxLines: 3 });
    expect(capped.lines.map((line) => line.map((row) => row.chord))).toEqual([["Ctrl+0"], ["Ctrl+1"], ["Ctrl+2"]]);
    const wide = layoutTuiKeysCard(rows, 120, { maxLines: 2 });
    expect(wide.lines.map((line) => line.map((row) => row.chord))).toEqual([
        ["Ctrl+0", "Ctrl+2", "Ctrl+4"],
        ["Ctrl+1", "Ctrl+3", "Ctrl+5"],
    ]);
    expect(layoutTuiKeysCard(rows, 20, { maxLines: -4 }).lines).toHaveLength(1);
});
