import { expect, test } from "bun:test";

import { layoutTuiKeysCard, tuiKeysCardRows } from "../../clients/tui/keys-card.ts";
import { activeTuiKeymap, installTuiKeymap } from "../../clients/tui/keymap.ts";

test("idle lists the keys without the stop keys", () => {
    const rows = tuiKeysCardRows(false);
    expect(rows).toContainEqual({ chord: "Ctrl+P", label: "commands" });
    expect(rows.map((row) => row.label)).not.toContain("stop");
    expect(rows.map((row) => row.chord)).not.toContain("Ctrl+X");
    expect(rows.slice(-2)).toEqual([
        { chord: "Ctrl+X m", label: "models" },
        { chord: "Ctrl+X h", label: "this card" },
    ]);
});

test("a running turn leads with the stop keys", () => {
    const rows = tuiKeysCardRows(true);
    expect(rows[0]).toEqual({ chord: "esc", label: "stop" });
    expect(rows).toContainEqual({ chord: "Ctrl+C", label: "stop" });
});

test("a bare-chord hint gets a short label, not its description", () => {
    expect(tuiKeysCardRows(false)).toContainEqual({ chord: "Ctrl+End", label: "follow bottom" });
});

test("a remapped key shows its new chord", () => {
    const original = activeTuiKeymap();
    try {
        installTuiKeymap(original.map((binding) =>
            binding.id === "open_palette" ? { ...binding, keys: ["ctrl+k"] } : binding
        ));
        expect(tuiKeysCardRows(false)).toContainEqual({ chord: "Ctrl+K", label: "commands" });
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
