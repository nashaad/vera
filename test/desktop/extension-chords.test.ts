import { expect, test } from "bun:test";

import { chordMatches, parseChord } from "../../clients/ui/src/extensions/chords.ts";

function press(key: string, held: Partial<Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>> = {}) {
    return { key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...held };
}

test("a chord names modifiers and one key, in any case and spacing", () => {
    expect(parseChord("Ctrl + Shift + K")).toEqual({ ctrl: true, alt: false, shift: true, meta: false, key: "k" });
    expect(parseChord("cmd+alt+up")).toEqual({ ctrl: false, alt: true, shift: false, meta: true, key: "arrowup" });
    expect(parseChord("f5")).toEqual({ ctrl: false, alt: false, shift: false, meta: false, key: "f5" });
    expect(parseChord("ctrl+space")).toMatchObject({ key: " " });
});

test("a chord that is not one is refused with a reason", () => {
    expect(parseChord("ctrl+k ctrl+d")).toBe("Key sequences are not supported.");
    expect(parseChord("ctrl+")).toContain("not a key");
    expect(parseChord("ctrl+shift")).toContain("names no key");
    expect(parseChord("ctrl+k+j")).toContain("not a key");
    expect(parseChord("ctrl+hello")).toContain("not a key name");
    expect(parseChord("k")).toBe("A key needs ctrl, alt or cmd, or must be a function key.");
    expect(parseChord("shift+k")).toBe("A key needs ctrl, alt or cmd, or must be a function key.");
});

test("a chord matches only the exact modifiers", () => {
    const chord = parseChord("ctrl+shift+k");
    if (typeof chord === "string") throw new Error(chord);
    expect(chordMatches(chord, press("K", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(chordMatches(chord, press("k", { ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(chordMatches(chord, press("k", { ctrlKey: true }))).toBe(false);
    expect(chordMatches(chord, press("k", { ctrlKey: true, shiftKey: true, altKey: true }))).toBe(false);
    expect(chordMatches(chord, press("j", { ctrlKey: true, shiftKey: true }))).toBe(false);
});
