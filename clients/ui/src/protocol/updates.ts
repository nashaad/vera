// What the desktop shell tells the page about updates. Plain data: it crosses the IPC bridge.
export type UpdateModeChoice = "ask" | "automatic" | "off";

export const UPDATE_MODE_CHOICES: readonly UpdateModeChoice[] = ["ask", "automatic", "off"];

export interface UpdateWaitingSession {
    readonly id: string;
    readonly title: string;
}

export type UpdateRunView =
    | { readonly kind: "idle" }
    | { readonly kind: "checking" }
    | { readonly kind: "downloading"; readonly bytes: number; readonly total?: number }
    | {
        readonly kind: "waiting";
        readonly sessions: readonly UpdateWaitingSession[];
        readonly waitedMs: number;
        readonly limitMs: number;
    }
    | { readonly kind: "switching" }
    | {
        readonly kind: "ended";
        readonly result: "done" | "up_to_date" | "held" | "failed" | "cancelled";
        readonly version?: string;
        readonly message?: string;
    };

// A newer release the last check found. "downloaded" means the next update only switches.
export interface UpdateOffer {
    readonly status: "available" | "downloaded";
    readonly latestVersion?: string;
}

export interface UpdateState {
    readonly mode: UpdateModeChoice;
    // False when this window has no installed launcher to run an update with, as in a window started from source.
    readonly capable: boolean;
    readonly checking: boolean;
    readonly currentVersion?: string;
    // Kept across a check that could not run, so the chip stays until a check answers.
    readonly offer?: UpdateOffer;
    // Why the last answered check says the update is held.
    readonly held?: string;
    // Why the last check could not run.
    readonly problem?: string;
    // Why the last change of mode was not saved.
    readonly modeProblem?: string;
    // Automatic mode is downloading in the background; the chip waits for it.
    readonly background: boolean;
    readonly run: UpdateRunView;
}

export const INITIAL_UPDATE_STATE: UpdateState = {
    mode: "ask",
    capable: false,
    checking: false,
    background: false,
    run: { kind: "idle" },
};

export type UpdateAction =
    | { readonly kind: "check" }
    | { readonly kind: "run" }
    | { readonly kind: "cancel" }
    | { readonly kind: "dismiss" }
    | { readonly kind: "mode"; readonly mode: UpdateModeChoice };

export function parseUpdateAction(value: unknown): UpdateAction | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const fields = value as Record<string, unknown>;
    switch (fields.kind) {
        case "check":
        case "run":
        case "cancel":
        case "dismiss":
            return { kind: fields.kind };
        case "mode":
            return UPDATE_MODE_CHOICES.find((mode) => mode === fields.mode) === undefined
                ? undefined
                : { kind: "mode", mode: fields.mode as UpdateModeChoice };
        default:
            return undefined;
    }
}
