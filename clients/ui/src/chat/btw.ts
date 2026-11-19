import { SIDEKICK_BUSY_NOTICE } from "../../../../src/sidekick/branch.ts";
import { sendPrompt } from "../composer/requests.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { setPendingPrompt } from "../session/pendingPrompt.ts";
import { CHAT_TABS_FULL } from "./open.ts";
import { chatTabs, type ChatSeed } from "./store.ts";

export const SIDEKICK_TITLE = "BTW";
export const BTW_OFF = "/btw is turned off";
export const BTW_WORKING = "/btw is still opening";

// What /btw does to the right pane; the workbench provides it.
export interface BtwTabs {
    readonly room: () => boolean;
    readonly open: (seed: ChatSeed) => string | undefined;
    readonly show: (tab: string) => void;
    readonly close: (tab: string) => void;
}

export interface BtwContext {
    readonly bridge: DesktopBridge;
    // The session whose composer ran the command.
    readonly primary: string;
    readonly folder: string | undefined;
    readonly chat: boolean;
    readonly tabs: BtwTabs;
    readonly offered: () => Promise<boolean>;
    readonly notify: (text: string) => void;
    // Puts the typed line back after a failure, so the question is not lost.
    readonly restore: () => void;
}

const working = new Set<string>();

// `/btw` opens or shows this session's sidekick, `/btw close` closes its tab, and `/btw <question>` also asks it.
// Nothing is written to the primary conversation.
export async function runBtw(args: string, context: BtwContext): Promise<void> {
    const text = args.trim();
    const existing = chatTabs.sidekickOf(context.primary);
    if (text.toLowerCase() === "close") {
        if (existing !== undefined) context.tabs.close(existing.tab);
        return;
    }
    if (!(await context.offered())) {
        context.notify(BTW_OFF);
        context.restore();
        return;
    }
    if (working.has(context.primary)) {
        context.notify(BTW_WORKING);
        context.restore();
        return;
    }
    working.add(context.primary);
    try {
        await open(text, existing, context);
    } finally {
        working.delete(context.primary);
    }
}

async function open(text: string, existing: ReturnType<typeof chatTabs.sidekickOf>, context: BtwContext): Promise<void> {
    if (existing === undefined) {
        const agentId = await branch(context);
        if (agentId === undefined) return;
        const tab = context.tabs.open(seedFor(agentId, context));
        if (tab === undefined) {
            context.notify(CHAT_TABS_FULL);
            context.restore();
            return;
        }
        // The new tab's composer sends it once the sidekick's watch attaches.
        if (text.length > 0) setPendingPrompt(agentId, { text, images: [] });
        return;
    }
    context.tabs.show(existing.tab);
    if (text.length === 0) return;
    const synced = await context.bridge.syncSidekick(existing.entry.agentId);
    if (!synced.ok) {
        context.notify(synced.reason);
        context.restore();
        return;
    }
    if (synced.decision === "busy") {
        context.notify(SIDEKICK_BUSY_NOTICE);
        return;
    }
    if (synced.decision === "stale") {
        // The conversation was rewound past what the sidekick holds; it is replaced in the same tab.
        const agentId = await branch(context);
        if (agentId === undefined) return;
        setPendingPrompt(agentId, { text, images: [] });
        chatTabs.retarget(existing.tab, agentId);
        return;
    }
    sendPrompt((line) => context.bridge.sendSession(existing.entry.pane, line), text);
}

async function branch(context: BtwContext): Promise<string | undefined> {
    if (!context.tabs.room()) {
        context.notify(CHAT_TABS_FULL);
        context.restore();
        return undefined;
    }
    const opened = await context.bridge.openSidekick(context.primary);
    if (!opened.ok) {
        context.notify(opened.reason);
        context.restore();
        return undefined;
    }
    return opened.agentId;
}

function seedFor(agentId: string, context: BtwContext): ChatSeed {
    return {
        kind: "sidekick",
        agentId,
        title: SIDEKICK_TITLE,
        folder: context.folder,
        chat: context.chat,
        primary: context.primary,
    };
}
