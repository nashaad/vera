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

export function parseRawInputEvent(
    key: TuiInterruptKey,
): TuiRawInterruptEvent | undefined {
    return key.name === "c" && key.ctrl
        ? { type: "interrupt" }
        : undefined;
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
