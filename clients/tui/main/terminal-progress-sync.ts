import { stepTerminalProgress, TERMINAL_PROGRESS_CLEAR, terminalSupportsProgress } from "../terminal-progress.ts";
import { setPendingTerminalRestore } from "../terminal-restore.ts";
import { saveTuiTerminalProgressPreference } from "../theme-preference.ts";
import type { TuiRuntime } from "./runtime.ts";
import { writeTerminal } from "./watchers.ts";

export function syncTerminalProgress(rt: TuiRuntime, now = Date.now()): void {
    const busy = rt.terminalProgressEnabled && !rt.shuttingDown && tuiBusy(rt);
    const step = stepTerminalProgress(rt.terminalProgress, busy, now);
    rt.terminalProgress = step.state;
    if (step.sequence === undefined) return;
    writeTerminal(rt, step.sequence);
    setPendingTerminalRestore(step.state.busy ? TERMINAL_PROGRESS_CLEAR : "");
}

export function applyTerminalProgressPreference(rt: TuiRuntime, enabled: boolean): void {
    saveTuiTerminalProgressPreference(enabled);
    rt.terminalProgressEnabled = enabled
        && terminalSupportsProgress(process.env, process.stdout.isTTY === true);
    syncTerminalProgress(rt);
}

// Background agents count, so the bar stays up while children finish work.
function tuiBusy(rt: TuiRuntime): boolean {
    return rt.state.working
        || rt.hostedSidebar.pane?.state.state.working === true
        || rt.runningBackgroundAgents > 0;
}
