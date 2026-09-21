import type { TuiAnimationLevel } from "../activity-bar.ts";
import { SHIMMER_FRAME_INTERVAL_MS } from "../main.ts";
import { saveTuiAnimationLevelPreference } from "../theme-preference.ts";
import { refreshTimedSurfaces } from "./render-state.ts";
import { renderStatus } from "./render-status.ts";
import type { TuiRuntime } from "./runtime.ts";

const STATUS_REFRESH_INTERVAL_MS = 100;

// With nothing animating the status line only needs the clock, so it ticks slower.
export function startStatusTimer(rt: TuiRuntime): void {
    clearInterval(rt.statusTimer);
    let lastTimedSurfaceRefresh = 0;
    rt.statusTimer = setInterval(() => {
        renderStatus(rt);
        if (Date.now() - lastTimedSurfaceRefresh >= STATUS_REFRESH_INTERVAL_MS) {
            refreshTimedSurfaces(rt);
            lastTimedSurfaceRefresh = Date.now();
        }
    }, rt.animationLevel === 0 && rt.activityAnimation === "off" ? STATUS_REFRESH_INTERVAL_MS : SHIMMER_FRAME_INTERVAL_MS);
}

export function applyAnimationLevel(rt: TuiRuntime, level: TuiAnimationLevel): void {
    saveTuiAnimationLevelPreference(level);
    rt.animationLevel = level;
    startStatusTimer(rt);
}
