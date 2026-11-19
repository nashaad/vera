import { showToast } from "../overlays/toasts.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { setPendingAgent } from "../session/pendingAgent.ts";
import { CHAT_TABS_FULL, hasRoomForChatTab, openChatTab, type ChatTabHost } from "./open.ts";

export const HELP_AGENT = "help";
export const HELP_TITLE = "Help";
const CREATE_FAILED = "Vera could not start a Help chat.";

// Every press opens a new chat on the Help agent in a new Chat tab, so one chat never carries another's questions.
// `host` is read again once the chat exists, because the layout can change while the host answers.
export async function startHelpChat(bridge: DesktopBridge, host: () => ChatTabHost): Promise<void> {
    if (!hasRoomForChatTab(host())) {
        showToast(CHAT_TABS_FULL, "danger");
        return;
    }
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
    const tab = openChatTab(host(), {
        kind: "help",
        agentId: result.agentId,
        title: HELP_TITLE,
        folder: result.workspace,
        chat: true,
    });
    if (tab === undefined) showToast(CHAT_TABS_FULL, "danger");
}
