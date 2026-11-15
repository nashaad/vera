import { SHOW_TARGETS, findShowTarget } from "../../../src/help/show-targets.ts";
import type { TuiAgentClient } from "../agent-client.ts";
import { openSettingsDestination } from "./provider-forms.ts";
import { openExtensionsList } from "./extensions-ops.ts";
import { openConfigurePicker, openStandingNudges, openThemePicker } from "./model-pickers.ts";
import { anyOverlayOpen, renderState } from "./render-state.ts";
import type { TuiRuntime } from "./runtime.ts";
import { openCommandPalette, openHelp, openResumePicker, openSearchOverlay, openWorkTab } from "./workspace-ops.ts";
import { appendTuiNotice } from "../state.ts";

export type TerminalShowRunner = (rt: TuiRuntime) => void;

// One entry for each show target the terminal has a screen for. The host marks the same set `terminal: true`.
export const TERMINAL_SHOW_RUNNERS: Readonly<Record<string, TerminalShowRunner>> = {
    "dialog.palette": openCommandPalette,
    "dialog.sessions": openResumePicker,
    "dialog.shortcuts": (rt) => openHelp(rt, "keys"),
    "dialog.agent": (rt) => void openSettingsDestination(rt, { kind: "agent" }),
    "dialog.themes": (rt) => openThemePicker(rt),
    "dialog.extensions": openExtensionsList,
    "dialog.configure": openConfigurePicker,
    "dialog.nudges": openStandingNudges,
    "settings.appearance": (rt) => openThemePicker(rt),
    "settings.agents": (rt) => void openSettingsDestination(rt, { kind: "agent" }),
    "settings.approvals": (rt) => void openSettingsDestination(rt, { kind: "permission_mode" }),
    "settings.providers": (rt) => void openSettingsDestination(rt, { kind: "provider" }),
    "settings.keyboard": (rt) => openHelp(rt, "keys"),
    "page.work": openWorkTab,
    "page.search": (rt) => openSearchOverlay(rt, "workspace"),
    "page.settings": (rt) => void openSettingsDestination(rt, { kind: "settings" }),
};

export function terminalShowTargetIds(): readonly string[] {
    return SHOW_TARGETS.filter((target) => target.terminal).map((target) => target.id);
}

// Opening over an open dialog could hide a question waiting for an answer, so a request that
// arrives then is declined with a notice.
export function showTerminalTarget(
    rt: TuiRuntime,
    id: string,
    runners: Readonly<Record<string, TerminalShowRunner>> = TERMINAL_SHOW_RUNNERS,
): void {
    const target = findShowTarget(id);
    const run = target === undefined ? undefined : runners[target.id];
    if (target === undefined || run === undefined) return;
    if (anyOverlayOpen(rt)) {
        rt.state = appendTuiNotice(rt.state, `Help tried to open ${target.label}. Close this dialog and ask again.`);
        renderState(rt);
        return;
    }
    run(rt);
}

export function watchSessionShow(
    rt: TuiRuntime,
    next: TuiAgentClient,
    runners: Readonly<Record<string, TerminalShowRunner>> = TERMINAL_SHOW_RUNNERS,
): void {
    rt.stopWatchingSessionShow?.();
    rt.stopWatchingSessionShow = next.onSessionShow?.((id) => {
        if (rt.client !== next || rt.shuttingDown) return;
        showTerminalTarget(rt, id, runners);
    });
}
