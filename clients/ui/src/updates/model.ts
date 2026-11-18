import type { UpdateRunView, UpdateState } from "../protocol/updates.ts";
import { byteSize } from "../views/files.ts";

export interface UpdateChipView {
    readonly label: string;
    readonly title: string;
    // The update is under way; the chip shows no new offer.
    readonly busy: boolean;
}

export const UPDATE_NOTE = "Running work finishes first. Then the window restarts on the new version with this conversation.";
export const UPDATING_LABEL = "Updating";

function versionText(version: string | undefined): string {
    return version === undefined ? "Vera" : `Vera ${version}`;
}

function active(run: UpdateRunView): boolean {
    return run.kind === "checking" || run.kind === "downloading" || run.kind === "waiting" || run.kind === "switching";
}

// The chip under the connection state. Off, a window with no way to update, and a background download show nothing.
export function chipOf(state: UpdateState): UpdateChipView | undefined {
    if (state.mode === "off" || !state.capable) return undefined;
    if (active(state.run)) return { label: UPDATING_LABEL, title: `${versionText(state.offer?.latestVersion)} is being installed`, busy: true };
    if (state.background || state.offer === undefined) return undefined;
    const name = versionText(state.offer.latestVersion);
    return state.offer.status === "downloaded"
        ? { label: "Update ready", title: `${name} is downloaded and ready`, busy: false }
        : { label: "Update available", title: `${name} is available`, busy: false };
}

export function waitDuration(ms: number): string {
    return ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`;
}

export type UpdateSheetView =
    | { readonly kind: "offer"; readonly lines: readonly string[]; readonly note: string }
    | {
        readonly kind: "working";
        readonly heading: string;
        readonly detail?: string;
        // 0 to 1 when the download size is known.
        readonly fraction?: number;
        readonly sessions: readonly string[];
        readonly cancellable: boolean;
    }
    | {
        readonly kind: "ended";
        readonly result: "done" | "up_to_date" | "held" | "failed" | "cancelled";
        readonly heading: string;
        readonly detail?: string;
        readonly retry: boolean;
    }
    | { readonly kind: "none"; readonly text: string };

function offerLines(state: UpdateState): readonly string[] {
    const latest = state.offer?.latestVersion;
    const lines: string[] = [];
    if (state.currentVersion !== undefined) lines.push(`You have Vera ${state.currentVersion}.`);
    const name = latest === undefined ? "A new version of Vera" : `Vera ${latest}`;
    lines.push(state.offer?.status === "downloaded" ? `${name} is downloaded and ready.` : `${name} is available.`);
    return lines;
}

function working(run: UpdateRunView, latest: string | undefined): UpdateSheetView {
    switch (run.kind) {
        case "downloading": {
            const size = run.total === undefined ? byteSize(run.bytes) : `${byteSize(run.bytes)} of ${byteSize(run.total)}`;
            const fraction = run.total === undefined || run.total <= 0 ? undefined : Math.min(1, run.bytes / run.total);
            return { kind: "working", heading: `Downloading ${versionText(latest)}`, detail: size, ...(fraction === undefined ? {} : { fraction }), sessions: [], cancellable: true };
        }
        case "waiting":
            return {
                kind: "working",
                heading: "Waiting for running work to finish",
                detail: `Waited ${waitDuration(run.waitedMs)} of ${waitDuration(run.limitMs)}.`,
                sessions: run.sessions.map((session) => session.title.length > 0 ? session.title : session.id),
                cancellable: true,
            };
        case "switching":
            return { kind: "working", heading: "Switching to the new version", detail: "Vera restarts when it finishes.", sessions: [], cancellable: false };
        default:
            return { kind: "working", heading: "Checking for the update", sessions: [], cancellable: true };
    }
}

function ended(run: Extract<UpdateRunView, { readonly kind: "ended" }>): UpdateSheetView {
    const detail = run.message === undefined || run.message.length === 0 ? {} : { detail: run.message };
    switch (run.result) {
        case "done":
            return { kind: "ended", result: "done", heading: run.version === undefined ? "Updated." : `Updated to Vera ${run.version}.`, retry: false };
        case "up_to_date":
            return { kind: "ended", result: "up_to_date", heading: "Vera is up to date.", retry: false };
        case "held":
            return { kind: "ended", result: "held", heading: "Update held", ...detail, retry: false };
        case "cancelled":
            return { kind: "ended", result: "cancelled", heading: "Update cancelled. Nothing was changed.", retry: true };
        default:
            return { kind: "ended", result: "failed", heading: "The update did not finish. Nothing was changed.", ...detail, retry: true };
    }
}

// What the sheet shows for the state: the offer, the run's progress, or how the run ended.
export function sheetOf(state: UpdateState): UpdateSheetView {
    const { run } = state;
    if (run.kind === "ended") return ended(run);
    if (active(run)) return working(run, state.offer?.latestVersion);
    if (state.offer !== undefined) return { kind: "offer", lines: offerLines(state), note: UPDATE_NOTE };
    return { kind: "none", text: state.held ?? "Vera is up to date." };
}

// One line under Check now in Settings.
export function updateStatusLine(state: UpdateState): string {
    if (!state.capable) return "Updates are not available in this window.";
    if (state.mode === "off") return "Updates are off.";
    if (active(state.run)) return "Updating.";
    if (state.checking) return "Checking for updates.";
    if (state.background) return `Downloading ${versionText(state.offer?.latestVersion)} in the background.`;
    if (state.offer !== undefined) {
        const name = versionText(state.offer.latestVersion);
        return state.offer.status === "downloaded" ? `${name} is downloaded and ready.` : `${name} is available.`;
    }
    if (state.held !== undefined) return state.held;
    if (state.problem !== undefined) return `Could not check: ${state.problem}`;
    if (state.currentVersion !== undefined) return `Vera ${state.currentVersion} is up to date.`;
    return "Not checked yet.";
}

// Check now needs a window that can update, a mode that checks, and no check or update under way.
export function canCheckNow(state: UpdateState): boolean {
    return state.capable && state.mode !== "off" && !state.checking && !state.background && !active(state.run);
}
