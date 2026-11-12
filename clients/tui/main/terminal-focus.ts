import { startStatusTimer } from "./animation-level.ts";
import { renderState } from "./render-state.ts";
import type { TuiRuntime } from "./runtime.ts";
import { STREAM_BLURRED_RENDER_INTERVAL_MS, STREAM_RENDER_INTERVAL_MS } from "../frame-budget.ts";

// Terminals that never report focus leave terminalFocused at true.
export function setTerminalFocused(rt: TuiRuntime, focused: boolean): void {
    if (rt.terminalFocused === focused) return;
    rt.terminalFocused = focused;
    startStatusTimer(rt);
    // renderState paints everything a pending coalesced repaint would paint.
    rt.renderCoalescer.stop();
    renderState(rt);
}

export function streamRenderIntervalMs(rt: TuiRuntime): number {
    return rt.terminalFocused === false ? STREAM_BLURRED_RENDER_INTERVAL_MS : STREAM_RENDER_INTERVAL_MS;
}
