export interface Chord {
    readonly ctrl: boolean;
    readonly alt: boolean;
    readonly shift: boolean;
    readonly meta: boolean;
    // KeyboardEvent.key, lower-cased.
    readonly key: string;
}

export interface ChordEvent {
    readonly key: string;
    readonly ctrlKey: boolean;
    readonly altKey: boolean;
    readonly shiftKey: boolean;
    readonly metaKey: boolean;
}

const MODIFIERS: Readonly<Record<string, "ctrl" | "alt" | "shift" | "meta">> = {
    ctrl: "ctrl",
    control: "ctrl",
    alt: "alt",
    option: "alt",
    shift: "shift",
    cmd: "meta",
    command: "meta",
    meta: "meta",
    win: "meta",
    super: "meta",
};

const NAMED: Readonly<Record<string, string>> = {
    enter: "enter",
    return: "enter",
    esc: "escape",
    escape: "escape",
    space: " ",
    tab: "tab",
    backspace: "backspace",
    delete: "delete",
    del: "delete",
    up: "arrowup",
    down: "arrowdown",
    left: "arrowleft",
    right: "arrowright",
    home: "home",
    end: "end",
    pageup: "pageup",
    pagedown: "pagedown",
};

// "ctrl+shift+k" style, one chord. Returns a reason when the text is not one.
export function parseChord(text: string): Chord | string {
    const normal = text.trim().toLowerCase().replace(/\s*\+\s*/g, "+");
    if (/\s/.test(normal)) return "Key sequences are not supported.";
    const parts = normal.split("+");
    const mods = { ctrl: false, alt: false, shift: false, meta: false };
    let key: string | undefined;
    for (const part of parts) {
        const modifier = MODIFIERS[part];
        if (modifier !== undefined) {
            mods[modifier] = true;
            continue;
        }
        if (key !== undefined || part.length === 0) return `"${text}" is not a key.`;
        const named = NAMED[part];
        if (named !== undefined) key = named;
        else if (/^f([1-9]|1[0-2])$/.test(part) || [...part].length === 1) key = part;
        else return `"${part}" is not a key name.`;
    }
    if (key === undefined) return `"${text}" names no key.`;
    // Without a modifier the key would also type into fields.
    if (!mods.ctrl && !mods.alt && !mods.meta && !/^f([1-9]|1[0-2])$/.test(key)) {
        return "A key needs ctrl, alt or cmd, or must be a function key.";
    }
    return { ...mods, key };
}

export function chordMatches(chord: Chord, event: ChordEvent): boolean {
    return event.key.toLowerCase() === chord.key
        && event.ctrlKey === chord.ctrl
        && event.altKey === chord.alt
        && event.shiftKey === chord.shift
        && event.metaKey === chord.meta;
}

export function sameChord(first: Chord, second: Chord): boolean {
    return first.key === second.key
        && first.ctrl === second.ctrl
        && first.alt === second.alt
        && first.shift === second.shift
        && first.meta === second.meta;
}
