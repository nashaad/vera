import { expect, test } from "bun:test";

import {
    chordCollidesWithNamedKey,
    chordNeedsExtendedKeyboard,
    legacyChordDelivery,
    parseTuiChord,
    resolveTuiKeymap,
} from "../../clients/tui/keybindings.ts";
import {
    TUI_KEYMAP,
    isTuiComposerClearKey,
    tuiBindingId,
    type TuiBinding,
} from "../../clients/tui/keymap.ts";

function chordsOf(
    bindings: readonly TuiBinding[],
    id: string,
): readonly string[] {
    return bindings.find((binding) => binding.id === id)?.keys ?? [];
}

const BASE: readonly TuiBinding[] = [
    {
        id: "dials.open",
        keys: ["shift+tab"],
        scope: "global",
        description: "Open the dial strip",
        hint: "shift+tab dials",
        remappable: true,
    },
    {
        id: "permissions.open",
        keys: ["ctrl+y"],
        scope: "global",
        description: "Open the permissions picker",
        remappable: true,
    },
    {
        id: "interrupt",
        keys: ["ctrl+c"],
        scope: "global",
        description: "Stop",
    },
];

test("Ctrl+G belongs to scope switching only while Switch model is open", () => {
    expect(tuiBindingId("switch_model_picker", { name: "g", ctrl: true })).toBe("journey_scope");
    expect(tuiBindingId("global", { name: "g", ctrl: true })).toBe("switch_pane");
    expect(TUI_KEYMAP.find((binding) => binding.id === "journey_scope")?.remappable).toBe(true);
});

test("a chord is canonicalized, whatever order it was written in", () => {
    expect(parseTuiChord("Shift+Ctrl+Tab")).toEqual({ chord: "ctrl+shift+tab" });
    expect(parseTuiChord(" CTRL+D ")).toEqual({ chord: "ctrl+d" });
    expect(parseTuiChord("escape")).toEqual({ chord: "esc" });
    expect(parseTuiChord("ctrl++")).toEqual({ chord: "ctrl++" });
});

test("ctrl+d and ctrl+u move the conversation by half a page", () => {
    expect(tuiBindingId("conversation", { name: "d", ctrl: true }))
        .toBe("scroll_half_page_down");
    expect(tuiBindingId("conversation", { name: "u", ctrl: true }))
        .toBe("scroll_half_page_up");
});

test("shift-tab opens dials for both terminal encodings", () => {
    expect(tuiBindingId("global", { name: "tab", shift: true }))
        .toBe("dials.open");
    expect(tuiBindingId("global", { name: "backtab" }))
        .toBe("dials.open");
});

test("ctrl+shift+h toggles the focused session header", () => {
    expect(tuiBindingId("global", {
        name: "h",
        ctrl: true,
        shift: true,
    })).toBe("toggle_session_header");
});

test("Option-delete is not mistaken for Command-delete", () => {
    expect(isTuiComposerClearKey({
        name: "backspace",
        meta: true,
        option: true,
    })).toBe(false);
});

test("alt, meta and option are refused rather than accepted and never fired", () => {
    for (const modifier of ["alt", "meta", "option"]) {
        const parsed = parseTuiChord(`${modifier}+x`);
        expect("error" in parsed).toBe(true);
        expect((parsed as { error: string }).error).toContain(modifier);
    }
    expect("error" in parseTuiChord("hyper+x")).toBe(true);
    expect("error" in parseTuiChord("ctrl+nope")).toBe(true);
    expect("error" in parseTuiChord(42)).toBe(true);
});

test("a ctrl+shift+letter chord is accepted with the terminal caveat named", () => {
    expect(chordNeedsExtendedKeyboard("ctrl+shift+m")).toBe(true);
    expect(chordNeedsExtendedKeyboard("ctrl+shift+up")).toBe(false);
    expect(chordNeedsExtendedKeyboard("shift+tab")).toBe(false);

    const { bindings, notices } = resolveTuiKeymap({
        base: BASE,
        overlay: { "dials.open": ["ctrl+shift+k"] },
    });
    expect(chordsOf(bindings, "dials.open")).toEqual(["ctrl+shift+k"]);
    expect(notices.some((line) => line.includes("kitty"))).toBe(true);
});

test("the overlay moves a remappable binding and the hint moves with it", () => {
    const { bindings, notices } = resolveTuiKeymap({
        base: BASE,
        overlay: {
            "permissions.open": ["shift+tab"],
            "dials.open": ["ctrl+d"],
        },
    });
    expect(chordsOf(bindings, "permissions.open")).toEqual(["shift+tab"]);
    expect(chordsOf(bindings, "dials.open")).toEqual(["ctrl+d"]);
    expect(notices).toEqual([]);
});

test("an empty list unbinds", () => {
    const { bindings } = resolveTuiKeymap({
        base: BASE,
        overlay: { "dials.open": [] },
    });
    expect(chordsOf(bindings, "dials.open")).toEqual([]);
});

test("an unknown id warns and is ignored, so a newer file does not brick", () => {
    const { bindings, notices } = resolveTuiKeymap({
        base: BASE,
        overlay: { "not.a.binding": ["ctrl+j"] },
    });
    expect(bindings).toHaveLength(BASE.length);
    expect(notices).toEqual([
        "keybinding ignored: not.a.binding: unknown binding id",
    ]);
});

test("a binding that is not remappable refuses to move", () => {
    const { bindings, notices } = resolveTuiKeymap({
        base: BASE,
        overlay: { interrupt: ["ctrl+q"] },
    });
    expect(chordsOf(bindings, "interrupt")).toEqual(["ctrl+c"]);
    expect(notices).toEqual([
        "keybinding ignored: interrupt: this binding cannot be moved",
    ]);
});

test("landing on a chord a structural binding owns is ignored, not silently won", () => {
    const { bindings, notices } = resolveTuiKeymap({
        base: BASE,
        overlay: { "dials.open": ["ctrl+c"] },
    });
    expect(chordsOf(bindings, "dials.open")).toEqual(["shift+tab"]);
    expect(chordsOf(bindings, "interrupt")).toEqual(["ctrl+c"]);
    expect(notices.some((line) => line.includes("dials.open"))).toBe(true);
});

test("two overlay entries on one chord both stand down, symmetrically", () => {
    const { bindings, notices } = resolveTuiKeymap({
        base: BASE,
        overlay: {
            "dials.open": ["ctrl+j"],
            "permissions.open": ["ctrl+j"],
        },
    });
    // No priority guessing: both revert, and both are named.
    expect(chordsOf(bindings, "dials.open")).toEqual(["shift+tab"]);
    expect(chordsOf(bindings, "permissions.open")).toEqual(["ctrl+y"]);
    const banner = notices.join("\n");
    expect(banner).toContain("dials.open");
    expect(banner).toContain("permissions.open");
});

test("a malformed chord drops its entry whole rather than half of it", () => {
    const { bindings, notices } = resolveTuiKeymap({
        base: BASE,
        overlay: { "dials.open": ["ctrl+d", "alt+x"] },
    });
    expect(chordsOf(bindings, "dials.open")).toEqual(["shift+tab"]);
    expect(notices.some((line) => line.includes("alt"))).toBe(true);
});

test("an extension row of the same id contributes its handler, not its metadata", () => {
    const { bindings, notices } = resolveTuiKeymap({
        base: BASE,
        extensions: [{
            id: "dials.open",
            keys: ["ctrl+z"],
            scope: "composer",
            remappable: false,
            hint: "^z dials",
        }],
    });
    const row = bindings.find((binding) => binding.id === "dials.open")!;
    expect(row.keys).toEqual(["shift+tab"]);
    expect(row.scope).toBe("global");
    expect(row.hint).toBe("shift+tab dials");
    expect(notices.length).toBeGreaterThan(0);
});

test("an extension row with a new id joins the table and can be moved", () => {
    const { bindings } = resolveTuiKeymap({
        base: BASE,
        extensions: [{
            id: "plan.open",
            keys: ["ctrl+l"],
            description: "Open the plan picker",
            remappable: true,
        }],
        overlay: { "plan.open": ["ctrl+k"] },
    });
    expect(chordsOf(bindings, "plan.open")).toEqual(["ctrl+k"]);
});

test("the shipped table survives its own merge with nothing to say", () => {
    const { bindings, notices } = resolveTuiKeymap({});
    expect(bindings).toEqual(TUI_KEYMAP as readonly TuiBinding[]);
    expect(notices).toEqual([]);
});

test("a chord names the key a legacy terminal delivers in its place", () => {
    expect(legacyChordDelivery("ctrl+shift+[")).toBe("esc");
    expect(legacyChordDelivery("ctrl+shift+m")).toBe("enter");
    expect(legacyChordDelivery("ctrl+shift+h")).toBe("backspace");
    expect(legacyChordDelivery("ctrl+tab")).toBe("tab");
    expect(legacyChordDelivery("ctrl+shift+tab")).toBe("backtab");
    expect(legacyChordDelivery("ctrl+shift+f")).toBe("ctrl+f");
    expect(legacyChordDelivery("ctrl+shift+left")).toBeUndefined();
    expect(legacyChordDelivery("ctrl+pageup")).toBeUndefined();
    expect(legacyChordDelivery("shift+tab")).toBeUndefined();
});

test("cycling sessions leads with a chord every terminal reports", () => {
    const shipped = TUI_KEYMAP as readonly TuiBinding[];
    const prev = chordsOf(shipped, "cycle_live_session_prev");
    const next = chordsOf(shipped, "cycle_live_session_next");
    expect(prev[0]).toBe("ctrl+shift+left");
    expect(next[0]).toBe("ctrl+shift+right");
    expect(chordNeedsExtendedKeyboard(prev[0]!)).toBe(false);
    expect(chordNeedsExtendedKeyboard(next[0]!)).toBe(false);
});

// Bindings whose every chord arrives as a key the TUI already acts on, so
// pressing one outside the kitty keyboard protocol fires that other action
// instead: ctrl+shift+m sends the message rather than opening the picker.
// The list may shrink as chords are given reachable primaries. It may not grow.
const KNOWN_NAMED_KEY_COLLISIONS: readonly string[] = [
    "jump.open",
    "open_model_picker",
    "toggle_session_header",
];

test("no shipped binding newly degrades into another key's action", () => {
    const offenders = (TUI_KEYMAP as readonly TuiBinding[])
        .filter((binding) => binding.keys.every(chordCollidesWithNamedKey))
        .map((binding) => binding.id)
        .sort();
    expect(offenders).toEqual([...KNOWN_NAMED_KEY_COLLISIONS]);
});
