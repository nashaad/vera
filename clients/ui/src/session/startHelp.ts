import { showToast } from "../overlays/toasts.ts";
import type { Route } from "../pages/routes.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { setPendingAgent } from "./pendingAgent.ts";

export const HELP_AGENT = "help";
export const HELP_TITLE = "Help";
const CREATE_FAILED = "Vera could not start a Help chat.";

// Every press opens a new chat on the Help agent, so one chat never carries another's questions.
export async function startHelpChat(bridge: DesktopBridge, navigate: (route: Route) => void): Promise<void> {
    let result: Awaited<ReturnType<DesktopBridge["createSession"]>>;
    try {
        result = await bridge.createSession(undefined);
    } catch {
        showToast(CREATE_FAILED, "danger");
        return;
    }
    if (!result.ok) {
        showToast(result.reason, "danger");
        return;
    }
    setPendingAgent(result.agentId, HELP_AGENT);
    navigate({ kind: "session", agentId: result.agentId, title: HELP_TITLE, workspace: result.workspace, chat: true });
}
