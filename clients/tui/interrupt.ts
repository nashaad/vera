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
    if (abortRequested) {
        return ctrlC ? "quit" : "consume";
    }
    return "abort";
}
