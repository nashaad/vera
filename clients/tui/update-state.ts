import type {
    UpdateCheck,
    UpdateMode,
    UpdateOutcome,
    UpdateProgress,
    UpdateRun,
} from "../shared/updates.ts";

export interface TuiUpdateDependencies {
    readonly mode: () => UpdateMode;
    readonly check: () => Promise<UpdateCheck>;
    readonly run: (downloadOnly: boolean, onProgress: (progress: UpdateProgress) => void) => UpdateRun;
    readonly shouldCheckNow: (lastCheckedAt: number | undefined, now: number) => boolean;
    readonly now?: () => number;
    // How often the schedule looks at the clock and the mode; a check still waits for shouldCheckNow.
    readonly tickMs?: number;
}

export interface TuiUpdateAvailable {
    readonly version: string | undefined;
    readonly downloaded: boolean;
}

export interface TuiUpdateRun {
    readonly background: boolean;
    handle: UpdateRun | undefined;
    progress: UpdateProgress | undefined;
    cancelling: boolean;
    // /update was entered while the background download ran; the switch starts when it ends.
    switchAfter: boolean;
}

export interface TuiUpdateRuntime {
    mode: UpdateMode;
    lastCheckedAt: number | undefined;
    checking: boolean;
    available: TuiUpdateAvailable | undefined;
    run: TuiUpdateRun | undefined;
    timer: ReturnType<typeof setInterval> | undefined;
}

export const SOURCE_CHECKOUT_UPDATE_TEXT = "This Vera runs from a source checkout, so there is nothing to update here.";
export const UPDATE_RUNNING_TEXT = "Vera is already updating";

const WAIT_NAME_MAX = 24;

export function newUpdateRuntime(mode: UpdateMode): TuiUpdateRuntime {
    return {
        mode,
        lastCheckedAt: undefined,
        checking: false,
        available: undefined,
        run: undefined,
        timer: undefined,
    };
}

// Off hides the notice. A check that finds nothing newer, or only a held release, clears it.
export function availableFromCheck(check: UpdateCheck): TuiUpdateAvailable | undefined {
    if (check.status !== "available" && check.status !== "downloaded") return undefined;
    return { version: check.latestVersion, downloaded: check.status === "downloaded" };
}

// Longest form first; the footer fits the first one that has room.
export function updateNoticeForms(update: TuiUpdateRuntime | undefined): string[] {
    if (update === undefined || update.mode === "off" || update.available === undefined) return [];
    if (update.run !== undefined && !update.run.background) return [];
    const version = update.available.version;
    return version === undefined
        ? ["update available · /update", "/update"]
        : [`update available: Vera ${version} · /update`, "update available · /update", "/update"];
}

// Esc cancels until the switch starts; after that the update runs to the end.
export function updateCancellable(update: TuiUpdateRuntime | undefined): boolean {
    const run = update?.run;
    if (run === undefined || run.cancelling) return false;
    if (run.background && !run.switchAfter) return false;
    return run.progress?.phase !== "switching";
}

// The row above the composer for an update the user started. Background downloads show nothing.
export function updateProgressText(run: TuiUpdateRun | undefined, width: number): string | undefined {
    if (run === undefined || (run.background && !run.switchAfter)) return undefined;
    const cancel = "Esc cancels";
    let forms: string[];
    if (run.cancelling) {
        forms = ["Updating · cancelling"];
    } else if (run.progress?.phase === "switching") {
        forms = ["Updating · switching"];
    } else if (run.progress?.phase === "waiting") {
        forms = waitingForms(run.progress.sessions, run.progress.waitedMs, run.progress.limitMs, cancel);
    } else if (run.progress?.phase === "downloading") {
        const amount = downloadAmount(run.progress.bytes, run.progress.total);
        forms = [`Updating · downloading ${amount} · ${cancel}`, `Updating · downloading · ${cancel}`];
    } else {
        forms = [`Updating · checking · ${cancel}`];
    }
    forms.push(cancelFallback(run, cancel));
    const fitting = forms.find((form) => form.length <= width) ?? forms[forms.length - 1] as string;
    return fitting.length <= width ? fitting : fitting.slice(0, Math.max(0, width));
}

function cancelFallback(run: TuiUpdateRun, cancel: string): string {
    return run.cancelling || run.progress?.phase === "switching" ? "Updating" : `Updating · ${cancel}`;
}

function waitingForms(
    sessions: readonly { readonly id: string; readonly title: string }[],
    waitedMs: number,
    limitMs: number,
    cancel: string,
): string[] {
    const first = sessions[0];
    if (first === undefined) return [`Updating · waiting · ${cancel}`];
    const name = clipName(first.title.length > 0 ? first.title : first.id);
    const more = sessions.length - 1;
    const waiting = more === 0 ? `waiting for ${name}` : `waiting for ${name} and ${more} more`;
    const span = `${formatSpan(waitedMs)} of ${formatSpan(limitMs)}`;
    return [
        `Updating · ${waiting} · ${span} · ${cancel}`,
        `Updating · ${waiting} · ${cancel}`,
        `Updating · waiting · ${cancel}`,
    ];
}

function clipName(name: string): string {
    return name.length <= WAIT_NAME_MAX ? name : `${name.slice(0, WAIT_NAME_MAX - 1)}…`;
}

export function formatSpan(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
}

function downloadAmount(bytes: number, total: number | undefined): string {
    if (total !== undefined && total > 0) {
        return `${Math.max(0, Math.min(100, Math.floor((bytes / total) * 100)))}%`;
    }
    return `${(Math.max(0, bytes) / (1024 * 1024)).toFixed(1)} MB`;
}

export type TuiUpdateOutcomeAction =
    | { readonly kind: "relaunch" }
    | { readonly kind: "notice"; readonly text: string; readonly error: boolean };

export function updateOutcomeAction(outcome: UpdateOutcome): TuiUpdateOutcomeAction {
    switch (outcome.result) {
        case "done":
            return { kind: "relaunch" };
        case "up_to_date":
            return { kind: "notice", text: "Vera is up to date", error: false };
        case "held":
            return {
                kind: "notice",
                text: outcome.message ?? "This update is held. Vera was not changed.",
                error: false,
            };
        case "downloaded":
            return {
                kind: "notice",
                text: outcome.message
                    ?? `Vera ${outcome.version ?? "update"} is downloaded. Run /update to switch to it.`,
                error: false,
            };
        case "cancelled":
            return { kind: "notice", text: "Update cancelled. Vera was not changed.", error: false };
        case "failed": {
            const reason = (outcome.message ?? "no reason was given").replace(/\.+$/, "");
            return {
                kind: "notice",
                text: outcome.changed ? `Update failed: ${reason}.` : `Update failed: ${reason}. Vera was not changed.`,
                error: true,
            };
        }
    }
}
