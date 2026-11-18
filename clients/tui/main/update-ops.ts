import type { UpdateOutcome } from "../../shared/updates.ts";
import { handleHostRestarting } from "../restart-notice.ts";
import { appendTuiError, appendTuiNotice } from "../state.ts";
import {
    SOURCE_CHECKOUT_UPDATE_TEXT,
    UPDATE_RUNNING_TEXT,
    availableFromCheck,
    newUpdateRuntime,
    updateCancellable,
    updateOutcomeAction,
    type TuiUpdateDependencies,
    type TuiUpdateRun,
    type TuiUpdateRuntime,
} from "../update-state.ts";
import { refuseInstalledBuildChange } from "./focus-switch.ts";
import { showStatusNotice } from "./notices.ts";
import { renderState } from "./render-state.ts";
import { renderStatus } from "./render-status.ts";
import type { TuiRuntime } from "./runtime.ts";

// One tick a minute is enough to notice a mode change and a due check; a check itself runs on shouldCheckNow.
const DEFAULT_TICK_MS = 60_000;

export function startUpdateChecks(rt: TuiRuntime): void {
    const updates = rt.dependencies.updates;
    if (updates === undefined) return;
    const state = newUpdateRuntime(updates.mode());
    rt.update = state;
    state.timer = setInterval(() => tickUpdateChecks(rt), updates.tickMs ?? DEFAULT_TICK_MS);
    state.timer.unref?.();
    tickUpdateChecks(rt);
}

// A run before its switch is cancelled with the TUI; once switching it finishes on its own.
export function stopUpdateChecks(rt: TuiRuntime): void {
    const state = rt.update;
    if (state === undefined) return;
    if (state.timer !== undefined) clearInterval(state.timer);
    state.timer = undefined;
    state.run?.handle?.cancel();
}

export function tickUpdateChecks(rt: TuiRuntime): void {
    const updates = rt.dependencies.updates;
    const state = rt.update;
    if (updates === undefined || state === undefined || rt.shuttingDown) return;
    const mode = updates.mode();
    if (mode !== state.mode) {
        state.mode = mode;
        if (mode === "off") state.available = undefined;
        paint(rt);
    }
    if (mode === "off" || state.checking || rt.relaunching === true) return;
    const now = (updates.now ?? Date.now)();
    if (!updates.shouldCheckNow(state.lastCheckedAt, now)) return;
    state.lastCheckedAt = now;
    state.checking = true;
    void updates.check().then((check) => {
        state.checking = false;
        if (rt.shuttingDown || state.mode === "off") return;
        // A run in flight already knows more than this check does.
        if (state.run === undefined) state.available = availableFromCheck(check);
        paint(rt);
        if (state.mode === "automatic" && check.status === "available" && state.run === undefined) {
            startRun(rt, updates, state, true);
        }
    }, () => {
        state.checking = false;
    });
}

export function runUpdateCommand(rt: TuiRuntime): void {
    const updates = rt.dependencies.updates;
    const state = rt.update;
    if (updates === undefined || state === undefined) {
        rt.state = appendTuiNotice(rt.state, SOURCE_CHECKOUT_UPDATE_TEXT);
        renderState(rt);
        return;
    }
    if (rt.relaunching === true) return;
    const active = state.run;
    if (active === undefined) {
        startRun(rt, updates, state, false);
        return;
    }
    if (active.background && !active.switchAfter) {
        active.switchAfter = true;
        paint(rt);
        return;
    }
    showStatusNotice(rt, UPDATE_RUNNING_TEXT);
}

// Esc before the switch cancels the update. While switching or cancelling it is
// still taken, so it does not clear the draft the relaunch keeps. Returns true when the key was used.
export function cancelUpdateFromKey(rt: TuiRuntime): boolean {
    const state = rt.update;
    const run = state?.run;
    if (run === undefined || (run.background && !run.switchAfter)) return false;
    if (!updateCancellable(state)) return true;
    if (run.handle?.cancel() !== true) return false;
    run.cancelling = true;
    paint(rt);
    return true;
}

function startRun(
    rt: TuiRuntime,
    updates: TuiUpdateDependencies,
    state: TuiUpdateRuntime,
    downloadOnly: boolean,
): void {
    const run: TuiUpdateRun = {
        background: downloadOnly,
        handle: undefined,
        progress: undefined,
        cancelling: false,
        switchAfter: false,
    };
    state.run = run;
    const handle = updates.run(downloadOnly, (progress) => {
        if (state.run !== run || rt.shuttingDown) return;
        run.progress = progress;
        paint(rt);
    });
    run.handle = handle;
    void handle.done.then(
        (outcome) => finishRun(rt, updates, state, run, outcome),
        (error: unknown) => finishRun(rt, updates, state, run, {
            result: "failed",
            message: error instanceof Error ? error.message : String(error),
            changed: false,
        }),
    );
    paint(rt);
}

function finishRun(
    rt: TuiRuntime,
    updates: TuiUpdateDependencies,
    state: TuiUpdateRuntime,
    run: TuiUpdateRun,
    outcome: UpdateOutcome,
): void {
    if (rt.shuttingDown || state.run !== run) return;
    state.run = undefined;
    if (outcome.result === "up_to_date" || outcome.result === "done") state.available = undefined;
    if (outcome.result === "downloaded") {
        state.available = { version: outcome.version ?? state.available?.version, downloaded: true };
    }
    if (run.background && !run.switchAfter) {
        paint(rt);
        return;
    }
    if (run.background && outcome.result === "downloaded") {
        startRun(rt, updates, state, false);
        return;
    }
    const action = updateOutcomeAction(outcome);
    if (action.kind === "relaunch") {
        beginRelaunch(rt, outcome);
        return;
    }
    rt.state = action.error
        ? appendTuiError(rt.state, action.text)
        : appendTuiNotice(rt.state, action.text);
    paint(rt);
    renderState(rt);
}

// The host restart notice may already have started the relaunch; it is not started twice.
function beginRelaunch(rt: TuiRuntime, outcome: UpdateOutcome): void {
    if (rt.relaunching === true) return;
    const relaunch = rt.dependencies.relaunchTui;
    if (relaunch !== undefined) {
        handleHostRestarting(rt, relaunch);
        return;
    }
    const clientBuildId = rt.dependencies.clientBuildId;
    const installedBuildId = outcome.build ?? rt.dependencies.installedBuildId?.();
    if (clientBuildId !== undefined && installedBuildId !== undefined) {
        refuseInstalledBuildChange(rt, clientBuildId, installedBuildId);
        return;
    }
    rt.state = appendTuiNotice(rt.state, "Vera is updated. Quit and reopen Vera to continue.");
    paint(rt);
    renderState(rt);
}

function paint(rt: TuiRuntime): void {
    if (rt.shuttingDown || !rt.clientSurfaceReady) return;
    renderStatus(rt);
}
