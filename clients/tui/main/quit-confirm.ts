import {
    quitBackgroundCommandSummary,
    shouldConfirmQuit,
} from "../background-command-count.ts";
import { startTuiQuitConfirmPicker } from "../settings-picker-starters.ts";
import { focusedAgentClient } from "./agents-dials.ts";
import type { TuiRuntime } from "./runtime.ts";
import { renderState } from "../main.ts";

export async function beginQuitConfirmation(rt: TuiRuntime): Promise<void> {
    if (rt.shuttingDown || rt.sessionCloseConfirm?.quitConfirm === true) return;

    const current = focusedAgentClient(rt);
    const sidebar = rt.hostedSidebar.pane?.client;
    const other = current === rt.client ? sidebar : rt.client;
    const summary = await quitBackgroundCommandSummary(
        rt.dependencies.listSessionPage,
        current.agentId,
        other?.agentId,
    );

    if (rt.shuttingDown || rt.sessionCloseConfirm !== undefined
        || focusedAgentClient(rt) !== current
        || rt.hostedSidebar.pane?.client !== sidebar) return;
    if (!shouldConfirmQuit(summary.total)) {
        rt.renderer.destroy();
        return;
    }
    rt.sessionCloseConfirm = startTuiQuitConfirmPicker(summary.message);
    renderState(rt);
}
