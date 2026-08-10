import { tuiChord, type TuiChordKey } from "./keymap.ts";
import type {
    VeraExperimentalTuiKey,
    VeraExperimentalTuiKeybinding,
} from "../../src/sdk/experimental-tui.ts";

export function tuiExperimentalKeyEvent(
    key: TuiChordKey,
): VeraExperimentalTuiKey {
    return {
        chord: tuiChord(key) ?? key.name,
        name: key.name,
        ctrl: key.ctrl === true,
        shift: key.shift === true,
        meta: key.meta === true,
    };
}

export function findTuiExperimentalKeybinding(
    key: TuiChordKey,
    keybindings: readonly VeraExperimentalTuiKeybinding[] | undefined,
): VeraExperimentalTuiKeybinding | undefined {
    const chord = tuiChord(key);
    if (chord === undefined) return undefined;
    return keybindings?.find((candidate) => candidate.keys.includes(chord));
}
