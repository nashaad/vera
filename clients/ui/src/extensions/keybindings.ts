import type { NativeShortcut } from "../commands/keys.ts";
import { parseChord, sameChord, type Chord } from "./chords.ts";
import { whensOverlap } from "./when-analysis.ts";
import type { WhenExpression } from "./when.ts";

export type KeyPlatform = "mac" | "other";

export interface ContributedKeybinding {
    readonly extensionId: string;
    readonly command: string;
    readonly key: string;
    readonly mac?: string;
    readonly when?: WhenExpression;
}

// Both bindings stay registered; the earlier one is listed first.
export interface KeybindingConflict {
    readonly first: ContributedKeybinding;
    readonly second: ContributedKeybinding;
    readonly platforms: readonly KeyPlatform[];
}

// An extension binding on a key the desktop's own shortcuts use. The shell takes that key before the page
// sees it, so the desktop command keeps it and the binding never runs.
export interface CoreKeyConflict {
    readonly binding: ContributedKeybinding;
    readonly command: string;
    readonly platforms: readonly KeyPlatform[];
}

const PLATFORMS: readonly KeyPlatform[] = ["mac", "other"];

const CODE_KEYS: Readonly<Record<string, string>> = {
    BracketLeft: "[",
    BracketRight: "]",
    Comma: ",",
    Period: ".",
    Slash: "/",
    Backslash: "\\",
    Semicolon: ";",
    Quote: "'",
    Backquote: "`",
    Minus: "-",
    Equal: "=",
};

// The chord a native shortcut answers on the platform: Cmd on macOS, Ctrl elsewhere. Undefined when its key has no name here.
export function nativeChord(shortcut: NativeShortcut, platform: KeyPlatform): Chord | undefined {
    const named = /^(?:Key([A-Z])|Digit([0-9]))$/.exec(shortcut.code);
    const key = named === null ? CODE_KEYS[shortcut.code] : (named[1] ?? named[2])!.toLowerCase();
    if (key === undefined) return undefined;
    const mac = platform === "mac";
    return { ctrl: !mac, alt: shortcut.alt, shift: shortcut.shift, meta: mac, key };
}

export function findCoreKeyConflicts(
    bindings: readonly ContributedKeybinding[],
    shortcuts: readonly NativeShortcut[],
): readonly CoreKeyConflict[] {
    const found: { binding: ContributedKeybinding; command: string; platforms: KeyPlatform[] }[] = [];
    for (const platform of PLATFORMS) {
        const taken = shortcuts.flatMap((shortcut) => {
            const chord = nativeChord(shortcut, platform);
            return chord === undefined ? [] : [{ command: shortcut.command, chord }];
        });
        for (const binding of bindings) {
            const chord = parseChord(platform === "mac" ? binding.mac ?? binding.key : binding.key);
            if (typeof chord === "string") continue;
            const core = taken.find((entry) => sameChord(entry.chord, chord));
            if (core === undefined) continue;
            const existing = found.find((conflict) => conflict.binding === binding && conflict.command === core.command);
            if (existing === undefined) found.push({ binding, command: core.command, platforms: [platform] });
            else existing.platforms.push(platform);
        }
    }
    return found;
}

// Keys compare without case or spacing; the stored string is never changed.
function effectiveKey(binding: ContributedKeybinding, platform: KeyPlatform): string {
    const key = platform === "mac" ? binding.mac ?? binding.key : binding.key;
    return key.trim().toLowerCase().split(/\s+/).join(" ");
}

function overlaps(first: ContributedKeybinding, second: ContributedKeybinding): boolean {
    return first.when === undefined || second.when === undefined || whensOverlap(first.when, second.when);
}

export function findKeybindingConflicts(bindings: readonly ContributedKeybinding[]): readonly KeybindingConflict[] {
    const found: { first: ContributedKeybinding; second: ContributedKeybinding; platforms: KeyPlatform[] }[] = [];
    for (const platform of PLATFORMS) {
        const byKey = new Map<string, ContributedKeybinding[]>();
        for (const binding of bindings) {
            const key = effectiveKey(binding, platform);
            byKey.set(key, [...(byKey.get(key) ?? []), binding]);
        }
        for (const sameKey of byKey.values()) {
            sameKey.forEach((second, later) => {
                for (const first of sameKey.slice(0, later)) {
                    if (!overlaps(first, second)) continue;
                    const existing = found.find((conflict) => conflict.first === first && conflict.second === second);
                    if (existing === undefined) found.push({ first, second, platforms: [platform] });
                    else existing.platforms.push(platform);
                }
            });
        }
    }
    return found;
}
