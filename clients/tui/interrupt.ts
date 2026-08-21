import { tuiBindingId } from "./keymap.ts";

export type TuiInterruptAction = "pass" | "abort" | "consume" | "quit";

export interface TuiInterruptKey {
    readonly name: string;
    readonly ctrl: boolean;
    readonly shift?: boolean;
    readonly meta?: boolean;
}

export interface TuiRawInterruptEvent {
    readonly type: "interrupt";
}

export interface TuiRawPaletteEvent {
    readonly type: "open_palette";
}

export type TuiRawInputEvent = TuiRawInterruptEvent | TuiRawPaletteEvent;

/**
 * The global chords, read from the keymap ahead of any overlay's own bindings,
 * which is what keeps ctrl+c interruptible from inside a dialog.
 *
 * A separate entry point rather than a plain `tuiBindingId("global", key)` call
 * because these two fire before focus is consulted at all: an overlay never
 * gets to decide whether ctrl+c reached it.
 */
export function parseRawInputEvent(
    key: TuiInterruptKey,
): TuiRawInputEvent | undefined {
    const binding = tuiBindingId("global", key);
    if (binding === "interrupt") {
        return { type: "interrupt" };
    }
    return binding === "open_palette" ? { type: "open_palette" } : undefined;
}

export function tuiInterruptAction(
    key: TuiInterruptKey,
    working: boolean,
    abortRequested: boolean,
    compacting = false,
): TuiInterruptAction {
    const ctrlC = parseRawInputEvent(key)?.type === "interrupt";
    const plainEscape = key.name === "escape" &&
        !key.ctrl &&
        !key.shift &&
        !key.meta;

    if (!ctrlC && !plainEscape) {
        return "pass";
    }
    if (!working && !compacting) {
        return ctrlC ? "quit" : "pass";
    }
    return abortRequested ? "consume" : "abort";
}
