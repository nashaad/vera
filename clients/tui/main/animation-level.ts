import type { TuiAnimationLevel } from "../activity-bar.ts";
import { SHIMMER_FRAME_INTERVAL_MS } from "../main.ts";
import { saveTuiAnimationLevelPreference } from "../theme-preference.ts";
import { refreshTimedSurfaces } from "./render-state.ts";
import { renderStatus } from "./render-status.ts";
import type { TuiRuntime } from "./runtime.ts";

const STATUS_REFRESH_INTERVAL_MS = 100;
const STATUS_IDLE_INTERVAL_MS = 1000;

// The status line only needs frame-rate ticks while something on it moves.
export function statusTimerInterval(rt: TuiRuntime): number {
    if (!statusAnimates(rt)) return STATUS_IDLE_INTERVAL_MS;
    // Live thinking and tool spinners still step at 100 ms with effects off.
    return rt.animationLevel === 0 && rt.activityAnimation === "off"
        ? STATUS_REFRESH_INTERVAL_MS
        : SHIMMER_FRAME_INTERVAL_MS;
}

function statusAnimates(rt: TuiRuntime): boolean {
    if (rt.state.working || rt.state.compactingSince !== undefined) return true;
    const hosted = rt.hostedSidebar.pane?.state.state;
    if (hosted?.working === true || hosted?.compactingSince !== undefined) {
        return true;
    }
    // Header spokes follow the activity setting; sidebar markers do not.
    if (rt.activityAnimation !== "off" && rt.runningBackgroundAgentNames.length > 0) {
        return true;
    }
    if (rt.workspaceSidebar?.sessions.some((session) => session.status === "working")) {
        return true;
    }
    if (rt.resumeOverlay.surface.visible || rt.animationsPreviewOpen) return true;
    const picker = rt.settingsPicker;
    if (
        picker?.kind === "session"
        && rt.activityAnimation !== "off"
        && (rt.workIndex?.working ?? 0) > 0
    ) {
        return true;
    }
    return picker?.kind === "model"
        && rt.activityAnimation !== "off"
        && picker.browseFeedback?.status === "working";
}

export function startStatusTimer(rt: TuiRuntime): void {
    clearInterval(rt.statusTimer);
    const interval = statusTimerInterval(rt);
    rt.statusTimerInterval = interval;
    let lastTimedSurfaceRefresh = 0;
    rt.statusTimer = setInterval(() => {
        renderStatus(rt);
        const now = Date.now();
        if (now - lastTimedSurfaceRefresh >= STATUS_REFRESH_INTERVAL_MS) {
            refreshTimedSurfaces(rt);
            lastTimedSurfaceRefresh = now;
        }
        syncStatusTimer(rt);
    }, interval);
}

// Called from renderStatus, so an animation that starts or stops retimes the
// timer on the same update instead of waiting for a tick at the wrong rate.
export function syncStatusTimer(rt: TuiRuntime): void {
    if (rt.statusTimerInterval === statusTimerInterval(rt)) return;
    startStatusTimer(rt);
}

export function applyAnimationLevel(rt: TuiRuntime, level: TuiAnimationLevel): void {
    saveTuiAnimationLevelPreference(level);
    rt.animationLevel = level;
    startStatusTimer(rt);
}
