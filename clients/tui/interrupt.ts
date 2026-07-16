export type TuiInterruptAction = "pass" | "abort" | "consume" | "quit";

export interface TuiInterruptKey {
    readonly name: string;
    readonly ctrl: boolean;
}

export function tuiInterruptAction(
    key: TuiInterruptKey,
    working: boolean,
    abortRequested: boolean,
): TuiInterruptAction {
    if (key.name !== "c" || !key.ctrl) {
        return "pass";
    }
    if (!working) {
        return "quit";
    }
    return abortRequested ? "consume" : "abort";
}
