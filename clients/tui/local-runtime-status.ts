/** The status section at the foot of the provider screen. A local runtime is a process on this machine, so the screen says what that process is doing rather than leaving the provider row to imply it. */

import { downloadSize, remaining } from "../../src/providers/outrider.ts";
import type {
    TuiLocalRuntimeProgress,
    TuiLocalRuntimeStatus,
} from "./settings-picker-types.ts";

export const LOCAL_RUNTIME_HEADING = "Local runtime";

function gigabytes(bytes: number): string {
    return `${(bytes / 1e9).toFixed(1)} GB`;
}

/** What a download has got through, when it reports bytes. Percent needs a total, and a fetch that has not said how big it is yet has none. */
function downloadProgress(progress: TuiLocalRuntimeProgress | undefined): string {
    if (progress === undefined || progress.total === undefined || progress.total === 0) {
        return "";
    }
    const fraction = Math.min(1, Math.max(0, progress.downloaded / progress.total));
    const parts = [
        `${Math.round(fraction * 100)}%`,
        `${downloadSize(progress.downloaded)} / ${downloadSize(progress.total)}`,
        ...(progress.etaSeconds === undefined || progress.etaSeconds <= 0
            ? []
            : [remaining(progress.etaSeconds)]),
    ];
    return ` ${parts.join(" · ")}`;
}

/** What the runtime is doing, as one line. A command in flight is the whole line, because the facts underneath it are the ones from before it started. */
function activityLine(status: TuiLocalRuntimeStatus): string {
    const fetching = downloadProgress(status.progress);
    if (status.busy === "starting") return `starting…${fetching}`;
    if (status.busy === "stopping") return "stopping…";
    if (status.busy === "switching") return `switching model…${fetching}`;
    if (status.state === "unknown") return "reading…";
    if (status.state === "absent") return "not installed";
    if (status.state === "stopped") {
        return status.gateway === "up"
            ? "gateway up, no model loaded"
            : "stopped, nothing loaded";
    }
    const parts = [
        status.profile === undefined
            ? "running"
            : `serving ${status.profile}`,
        ...(status.healthy === false ? ["not answering"] : []),
        ...(status.endpoint === undefined ? [] : [status.endpoint]),
        ...(status.residentBytes === undefined
            ? []
            : [`${gigabytes(status.residentBytes)} resident`]),
    ];
    return parts.join(" · ");
}

/** The runtime and what it is doing, as the one line both the section and a notice show. */
export function localRuntimeActivity(status: TuiLocalRuntimeStatus): string {
    return `${status.label} · ${activityLine(status)}`;
}

/** The section as plain lines, heading first. Nothing here is coloured, so the same reading survives a terminal with no colour at all. */
export function localRuntimeStatusLines(
    status: TuiLocalRuntimeStatus,
): readonly string[] {
    return [
        LOCAL_RUNTIME_HEADING,
        localRuntimeActivity(status),
        ...(status.failure === undefined ? [] : [`! ${status.failure}`]),
    ];
}

/** The actions this runtime can be asked for right now. A command in flight leaves none, so a second press cannot stack one on another. */
export function localRuntimeActions(
    status: TuiLocalRuntimeStatus | undefined,
): readonly { readonly value: string; readonly label: string; readonly description: string }[] {
    if (status === undefined || status.busy !== undefined) return [];
    if (status.state === "running") {
        return [
            { value: "runtime_switch", label: "Switch model", description: "Point the running gateway at another profile" },
            { value: "runtime_restart", label: "Restart", description: "Stop the gateway and bring it back up" },
            { value: "runtime_stop", label: "Stop", description: "Take the gateway down and free its memory" },
            { value: "runtime_logs", label: "Logs", description: "The tail of what the runtime is writing" },
        ];
    }
    if (status.state === "stopped") {
        return [
            { value: "runtime_start", label: "Start", description: "Bring the gateway back up on its last profile" },
            { value: "runtime_switch", label: "Switch model", description: "Start it on another profile" },
            { value: "runtime_logs", label: "Logs", description: "The tail of what the runtime is writing" },
        ];
    }
    return [];
}
