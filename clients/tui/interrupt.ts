export type TuiInterruptAction = "pass" | "abort" | "consume" | "quit";

export interface TuiInterruptKey {
    readonly name: string;
    readonly ctrl: boolean;
    readonly shift?: boolean;
    readonly meta?: boolean;
}

export function tuiInterruptAction(
    key: TuiInterruptKey,
    working: boolean,
    abortRequested: boolean,
): TuiInterruptAction {
    const ctrlC = key.name === "c" && key.ctrl;
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
