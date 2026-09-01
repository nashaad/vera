/** One merge pipeline for every key the TUI can dispatch. The static table, the chords extensions register at runtime, and the user's `keybindings` block in `tui.json` used to be. */

import {
    TUI_KEYMAP,
    type TuiBinding,
    type TuiKeyScope,
    tuiKeymapConflictPairs,
} from "./keymap.ts";

export interface TuiExtensionBindingRow {
    readonly id: string;
    readonly keys: readonly string[];
    readonly description?: string;
    readonly scope?: TuiKeyScope;
    readonly remappable?: boolean;
    readonly hint?: string;
}

export interface TuiKeymapResolution {
    readonly bindings: readonly TuiBinding[];
    readonly notices: readonly string[];
}

export type TuiKeybindingOverlay = Readonly<
    Record<string, readonly string[]>
>;

const NAMED_KEYS: readonly string[] = [
    "tab",
    "backtab",
    "enter",
    "esc",
    "escape",
    "space",
    "up",
    "down",
    "left",
    "right",
    "home",
    "end",
    "pageup",
    "pagedown",
    "delete",
    "backspace",
    "insert",
    ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
];

const MODIFIERS: readonly string[] = ["ctrl", "shift"];

export function parseTuiChord(
    text: unknown,
): { readonly chord: string } | { readonly error: string } {
    if (typeof text !== "string" || text.trim().length === 0) {
        return { error: "not a chord" };
    }
    const parts = text.trim().toLowerCase().split("+");
    const normalized = parts.length > 1 && parts.at(-1) === ""
        ? [...parts.slice(0, -2), "+"]
        : parts;
    const key = normalized.at(-1) ?? "";
    const modifiers = normalized.slice(0, -1);
    for (const modifier of modifiers) {
        if (modifier === "alt" || modifier === "meta" || modifier === "option") {
            return {
                error:
                    `${modifier} chords are not reported by every terminal, so Vera does not bind them`,
            };
        }
        if (!MODIFIERS.includes(modifier)) {
            return { error: `unknown modifier ${modifier || "(empty)"}` };
        }
    }
    if (new Set(modifiers).size !== modifiers.length) {
        return { error: "a modifier is repeated" };
    }
    if (!NAMED_KEYS.includes(key) && [...key].length !== 1) {
        return { error: `unknown key ${key || "(empty)"}` };
    }
    const canonicalKey = key === "escape" ? "esc" : key;
    return {
        chord: [
            ...(modifiers.includes("ctrl") ? ["ctrl"] : []),
            ...(modifiers.includes("shift") ? ["shift"] : []),
            canonicalKey,
        ].join("+"),
    };
}

/** Whether a chord only arrives under the kitty keyboard protocol. A terminal outside it drops the shift on a ctrl+letter chord, so the binding is simply never reached there. */
export function chordNeedsExtendedKeyboard(chord: string): boolean {
    const parts = chord.split("+");
    const key = parts.at(-1) ?? "";
    return parts.includes("ctrl")
        && parts.includes("shift")
        && [...key].length === 1;
}

export function resolveTuiKeymap(options: {
    readonly base?: readonly TuiBinding[];
    readonly extensions?: readonly TuiExtensionBindingRow[];
    readonly overlay?: TuiKeybindingOverlay;
}): TuiKeymapResolution {
    const notices: string[] = [];
    const merged = coalesce(
        options.base ?? TUI_KEYMAP,
        options.extensions ?? [],
        notices,
    );
    const overlaid = applyOverlay(merged, options.overlay ?? {}, notices);
    return { bindings: settleConflicts(overlaid, merged, notices), notices };
}

interface Candidate {
    readonly binding: TuiBinding;
    readonly overridden: boolean;
}

function coalesce(
    base: readonly TuiBinding[],
    extensions: readonly TuiExtensionBindingRow[],
    notices: string[],
): TuiBinding[] {
    const rows = [...base];
    for (const row of extensions) {
        const existing = rows.find((binding) =>
            binding.id === row.id || binding.extensionId === row.id
        );
        if (existing !== undefined) {
            for (
                const [what, mine, theirs] of [
                    ["scope", existing.scope, row.scope],
                    ["remappable", existing.remappable ?? false, row.remappable],
                    ["hint", existing.hint, row.hint],
                ] as const
            ) {
                if (theirs !== undefined && theirs !== mine) {
                    notices.push(
                        `keybinding ${row.id}: extension ${what} ${
                            String(theirs)
                        } ignored, the built-in table says ${String(mine)}`,
                    );
                }
            }
            const sameChords = row.keys.length === existing.keys.length
                && row.keys.every((key) => existing.keys.includes(key));
            if (!sameChords) {
                notices.push(
                    `keybinding ${row.id}: extension chords ${
                        row.keys.join(", ")
                    } ignored, the built-in table says ${
                        existing.keys.join(", ")
                    }`,
                );
            }
            continue;
        }
        rows.push({
            id: row.id,
            keys: row.keys,
            scope: row.scope ?? "global",
            description: row.description ?? row.id,
            ...(row.hint === undefined ? {} : { hint: row.hint }),
            remappable: row.remappable ?? false,
        });
    }
    return rows;
}

function applyOverlay(
    rows: readonly TuiBinding[],
    overlay: TuiKeybindingOverlay,
    notices: string[],
): Candidate[] {
    const candidates: Candidate[] = rows.map((binding) => ({
        binding,
        overridden: false,
    }));
    for (const [id, requested] of Object.entries(overlay)) {
        const index = candidates.findIndex(
            (candidate) => candidate.binding.id === id,
        );
        if (index < 0) {
            // Forward compatibility: a block written for a newer Vera names ids this one has never heard of, and that must not brick the older.
            notices.push(`keybinding ignored: ${id}: unknown binding id`);
            continue;
        }
        const binding = candidates[index]!.binding;
        if (binding.remappable !== true) {
            notices.push(
                `keybinding ignored: ${id}: this binding cannot be moved`,
            );
            continue;
        }
        if (!Array.isArray(requested)) {
            notices.push(
                `keybinding ignored: ${id}: expected a list of chords`,
            );
            continue;
        }
        const chords: string[] = [];
        let refused = false;
        for (const text of requested) {
            const parsed = parseTuiChord(text);
            if ("error" in parsed) {
                notices.push(
                    `keybinding ignored: ${id}: ${String(text)}: ${parsed.error}`,
                );
                refused = true;
                break;
            }
            if (chordNeedsExtendedKeyboard(parsed.chord)) {
                notices.push(
                    `keybinding ${id}: ${parsed.chord} only arrives in terminals that speak the kitty keyboard protocol`,
                );
            }
            chords.push(parsed.chord);
        }
        if (refused) continue;
        candidates[index] = {
            binding: { ...binding, keys: chords },
            overridden: true,
        };
    }
    return candidates;
}

function settleConflicts(
    candidates: readonly Candidate[],
    defaults: readonly TuiBinding[],
    notices: string[],
): readonly TuiBinding[] {
    let current = [...candidates];
    for (let round = 0; round <= candidates.length; round += 1) {
        const conflicts = tuiKeymapConflictPairs(
            current.map((candidate) => candidate.binding),
        );
        const guilty = new Set<string>();
        for (const conflict of conflicts) {
            const sides = [conflict.left, conflict.right].filter((id) =>
                current.some((candidate) =>
                    candidate.binding.id === id && candidate.overridden
                )
            );
            if (sides.length === 0) {
                notices.push(
                    `keybinding conflict: ${conflict.chord} is claimed by both ${conflict.left} and ${conflict.right}`,
                );
                continue;
            }
            for (const id of sides) guilty.add(id);
            notices.push(
                `keybinding ignored: ${sides.join(", ")}: ${conflict.chord} is already claimed by ${
                    sides.includes(conflict.left) ? conflict.right : conflict.left
                }`,
            );
        }
        if (guilty.size === 0) {
            return current.map((candidate) => candidate.binding);
        }
        current = current.map((candidate) =>
            guilty.has(candidate.binding.id)
                ? {
                    binding: defaultFor(candidate.binding, defaults),
                    overridden: false,
                }
                : candidate
        );
    }
    return current.map((candidate) => candidate.binding);
}

function defaultFor(
    binding: TuiBinding,
    defaults: readonly TuiBinding[],
): TuiBinding {
    return defaults.find((row) => row.id === binding.id) ?? binding;
}
