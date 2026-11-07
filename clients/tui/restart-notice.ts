import type { TuiDraft } from "./main.ts";
import { RELAUNCH_EXIT_CODE, type RelaunchRecord } from "../../src/release/relaunch.ts";
import type { TuiRuntime } from "./main/runtime.ts";
import { currentDraft } from "./main/session-ops.ts";
import { renderStatus } from "./main/render-status.ts";

export const RESTARTING_NOTICE_TEXT = "Restarting to match";

// Time for the notice to reach the terminal before the TUI exits.
const RELAUNCH_PAINT_MS = 120;

export interface TuiRelaunchRequest {
    readonly sessionId?: string;
    readonly draft?: TuiDraft;
}

export interface LauncherRelaunchEffects {
    readonly writeRecord: (launcherKey: string, record: RelaunchRecord) => void;
    readonly markTerminalRestored: () => void;
    readonly exit: (code: number) => void;
}

// Undefined without a launcher, so the TUI keeps its reconnect path there.
export function launcherRelaunch(
    launcherKey: string | undefined,
    effects: LauncherRelaunchEffects,
): ((request: TuiRelaunchRequest) => Promise<void>) | undefined {
    if (launcherKey === undefined) return undefined;
    return async (request) => {
        // Best effort: without the record the next TUI opens the home screen.
        try {
            effects.writeRecord(launcherKey, { ...request, writtenAt: new Date().toISOString() });
        } catch {
        }
        // Keeps the alternate screen so the next TUI draws over this one.
        effects.markTerminalRestored();
        effects.exit(RELAUNCH_EXIT_CODE);
    };
}

// Shows the notice, then asks the launcher for a relaunch. Without a launcher
// (relaunch is undefined) the TUI keeps its reconnect path and shows only the notice.
export function handleHostRestarting(
    rt: TuiRuntime,
    relaunch: ((request: TuiRelaunchRequest) => Promise<void>) | undefined,
    paint: (rt: TuiRuntime) => void = renderStatus,
): void {
    rt.stopWait = undefined;
    rt.stopWaitCard = undefined;
    rt.relaunching = true;
    paint(rt);
    if (relaunch === undefined) return;
    void relaunchAfterPaint(rt, relaunch, paint).catch(() => undefined);
}

async function relaunchAfterPaint(
    rt: TuiRuntime,
    relaunch: (request: TuiRelaunchRequest) => Promise<void>,
    paint: (rt: TuiRuntime) => void,
): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, RELAUNCH_PAINT_MS));
    paint(rt);
    const draft = currentDraft(rt);
    await relaunch({
        ...(rt.client.agentId === undefined ? {} : { sessionId: rt.client.agentId }),
        ...(draft === undefined ? {} : { draft }),
    });
}
