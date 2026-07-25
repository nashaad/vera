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
 * The global chords, recognized in one place so no overlay has to match raw key
 * names itself. Every key handler consults this before its own bindings, which
 * is what keeps ctrl+c interruptible from inside a dialog.
 */
export function parseRawInputEvent(
    key: TuiInterruptKey,
): TuiRawInputEvent | undefined {
    if (!key.ctrl) {
        return undefined;
    }
    if (key.name === "c") {
        return { type: "interrupt" };
    }
    return key.name === "p" ? { type: "open_palette" } : undefined;
}

export function tuiInterruptAction(
    key: TuiInterruptKey,
    working: boolean,
    abortRequested: boolean,
): TuiInterruptAction {
    const ctrlC = parseRawInputEvent(key)?.type === "interrupt";
    const plainEscape = key.name === "escape" &&
        !key.ctrl &&
        !key.shift &&
        !key.meta;

    if (!ctrlC && !plainEscape) {
        return "pass";
    }
    if (!working) {
        return ctrlC ? "quit" : "pass";
    }
    return abortRequested ? "consume" : "abort";
}
