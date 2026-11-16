import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { CHAT_TAB_LIMIT } from "../../clients/ui/src/chat/limits.ts";
import { HELP_AGENT, HELP_TITLE, startHelpChat } from "../../clients/ui/src/chat/help.ts";
import { CHAT_TABS_FULL, openChatTab, type ChatTabHost } from "../../clients/ui/src/chat/open.ts";
import { chatTabs, type ChatSeed } from "../../clients/ui/src/chat/store.ts";
import { registerChatCommands, CHAT_COMMANDS } from "../../clients/ui/src/commands/chat-commands.ts";
import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { defaultLayout, type LayoutState } from "../../clients/ui/src/layout/model.ts";
import { reduceLayout, type LayoutAction } from "../../clients/ui/src/layout/reducer.ts";
import { canOpenTab, resolveLayout, type ResolvedLayout } from "../../clients/ui/src/layout/resolve.ts";
import { currentToasts, dismissToast } from "../../clients/ui/src/overlays/toasts.ts";
import type { DesktopBridge } from "../../clients/ui/src/protocol/bridge.ts";
import { CHAT_PANE_LIMIT, chatPane, isSessionPane } from "../../clients/ui/src/protocol/panes.ts";
import { ContributionRegistry } from "../../clients/ui/src/registry/contributions.ts";
import { CORE_CONTAINERS, CORE_VIEWS, paneEntry, PANE_KINDS, registerCoreContributions } from "../../clients/ui/src/registry/core.ts";
import { takePendingAgent } from "../../clients/ui/src/session/pendingAgent.ts";

const contributions = new ContributionRegistry();
registerCoreContributions(contributions);
const snapshot = contributions.snapshot();

// A host over a real layout, so opening a tab runs the reducer the window runs.
function fakeHost(): { readonly host: ChatTabHost; readonly state: () => LayoutState; readonly actions: LayoutAction[] } {
    let state = defaultLayout();
    const actions: LayoutAction[] = [];
    const host: ChatTabHost = {
        get layout(): ResolvedLayout {
            return resolveLayout(state, snapshot);
        },
        dispatch: (action) => {
            actions.push(action);
            state = reduceLayout(state, action, snapshot);
        },
    };
    return { host, state: () => state, actions };
}

const seed = (agentId: string, extra: Partial<ChatSeed> = {}): ChatSeed => ({
    kind: "help",
    agentId,
    title: "Help",
    folder: undefined,
    chat: true,
    ...extra,
});

beforeEach(() => chatTabs.reset());
afterEach(() => {
    chatTabs.reset();
    for (const toast of currentToasts()) dismissToast(toast.id);
});

describe("session panes", () => {
    test("@core the shell serves the fixed panes and chat slots below the limit, and nothing else", () => {
        for (const pane of ["main", "companion", "probe", "chat:0", `chat:${CHAT_PANE_LIMIT - 1}`]) expect(isSessionPane(pane)).toBe(true);
        for (const pane of [`chat:${CHAT_PANE_LIMIT}`, "chat:01", "chat:-1", "chat:", "chat:1e1", "chat:0 ", "chat", "side", "", 3, undefined, null]) {
            expect(isSessionPane(pane)).toBe(false);
        }
    });

    test("@core Chat tabs never outnumber the chat panes", () => {
        expect(CHAT_TAB_LIMIT).toBeLessThanOrEqual(CHAT_PANE_LIMIT);
    });
});

describe("the Chat tab store", () => {
    test("@core each tab takes the lowest free pane, and closing a tab frees its pane", () => {
        expect(chatTabs.add("tab.a", seed("crow-1"))?.pane).toBe(chatPane(0));
        expect(chatTabs.add("tab.b", seed("crow-2"))?.pane).toBe(chatPane(1));
        chatTabs.drop(["tab.a"]);
        expect(chatTabs.get("tab.a")).toBeUndefined();
        expect(chatTabs.add("tab.c", seed("crow-3"))?.pane).toBe(chatPane(0));
    });

    test("@core no pane is handed out twice, and none is left over to hand out", () => {
        for (let slot = 0; slot < CHAT_PANE_LIMIT; slot += 1) expect(chatTabs.add(`tab.${slot}`, seed(`crow-${slot}`))).toBeDefined();
        expect(chatTabs.add("tab.extra", seed("crow-extra"))).toBeUndefined();
        expect(new Set([...chatTabs.snapshot().values()].map((entry) => entry.pane)).size).toBe(CHAT_PANE_LIMIT);
    });

    test("@core a retargeted tab keeps its pane and shows the other session", () => {
        const before = chatTabs.add("tab.a", seed("crow-1", { kind: "sidekick", primary: "crow-0" }));
        chatTabs.retarget("tab.a", "crow-9");
        expect(before).toBeDefined();
        expect(chatTabs.get("tab.a")).toEqual({ ...before!, agentId: "crow-9" });
        chatTabs.retarget("tab.gone", "crow-9");
        expect(chatTabs.get("tab.gone")).toBeUndefined();
    });

    test("@core a session's sidekick is found by the session it was branched from", () => {
        chatTabs.add("tab.help", seed("crow-1"));
        chatTabs.add("tab.side", seed("crow-2", { kind: "sidekick", primary: "crow-0" }));
        expect(chatTabs.sidekickOf("crow-0")?.tab).toBe("tab.side");
        expect(chatTabs.sidekickOf("crow-1")).toBeUndefined();
    });

    test("subscribers hear each change and stop hearing after they leave", () => {
        let heard = 0;
        const leave = chatTabs.subscribe(() => { heard += 1; });
        chatTabs.add("tab.a", seed("crow-1"));
        chatTabs.drop(["tab.a"]);
        chatTabs.drop(["tab.a"]);
        leave();
        chatTabs.add("tab.b", seed("crow-2"));
        expect(heard).toBe(2);
    });
});

describe("the Chat kind", () => {
    test("@core Chat is a right pane kind with a tab limit, unsaved, whose entry starts Help", () => {
        const chat = PANE_KINDS.find((kind) => kind.id === CORE_CONTAINERS.chat);
        expect(chat?.maxTabs).toBe(CHAT_TAB_LIMIT);
        expect(chat?.transientTabs).toBe(true);
        expect(contributions.keepsTabsOut(CORE_CONTAINERS.chat)).toBe(true);
        expect(snapshot.views.find((view) => view.id === CORE_VIEWS.chat)?.container).toBe(CORE_CONTAINERS.chat);
        expect(snapshot.containers.find((container) => container.id === CORE_CONTAINERS.chat)?.location).toBe("rightPane");
    });

    test("@core tiles and the launcher show the Help entry for Chat and the kind's own title for the rest", () => {
        const fallback = { title: "Chat", icon: "chat" };
        expect(paneEntry(CORE_CONTAINERS.chat, fallback)).toEqual({ title: "Help", icon: "help", command: CHAT_COMMANDS.help });
        expect(paneEntry(CORE_CONTAINERS.plan, { title: "Plan", icon: "plan" })).toEqual({ title: "Plan", icon: "plan", command: undefined });
        expect(paneEntry("ext.unknown", { title: "Mine", icon: "view" }).command).toBeUndefined();
    });

    test("@core a Chat tab opens past no more than the kind's limit, and the others stay open below it", () => {
        let layout = defaultLayout();
        for (let index = 0; index < CHAT_TAB_LIMIT; index += 1) {
            layout = reduceLayout(layout, { type: "openTab", container: CORE_CONTAINERS.chat }, snapshot);
        }
        const resolved = resolveLayout(layout, snapshot);
        expect(canOpenTab(resolved, CORE_CONTAINERS.chat)).toBe(false);
        expect(canOpenTab(resolved, CORE_CONTAINERS.plan)).toBe(true);
        expect(reduceLayout(layout, { type: "openTab", container: CORE_CONTAINERS.chat }, snapshot)).toBe(layout);
    });

    test("@core opening a Chat tab shows the right pane on it, with the session already in the store", () => {
        const { host, state } = fakeHost();
        const tab = openChatTab(host, seed("crow-1"));
        expect(tab).toBeDefined();
        expect(chatTabs.get(tab ?? "")?.agentId).toBe("crow-1");
        expect(state().locations.rightPane.visible).toBe(true);
        expect(state().tabs.map((candidate) => candidate.id)).toEqual([tab ?? ""]);
    });

    test("@core a Chat tab that does not fit opens nothing and leaves nothing in the store", () => {
        const { host } = fakeHost();
        for (let index = 0; index < CHAT_TAB_LIMIT; index += 1) expect(openChatTab(host, seed(`crow-${index}`))).toBeDefined();
        expect(openChatTab(host, seed("crow-over"))).toBeUndefined();
        expect(chatTabs.snapshot().size).toBe(CHAT_TAB_LIMIT);
    });
});

describe("Help", () => {
    function bridgeWith(createSession: unknown): DesktopBridge {
        return { createSession } as unknown as DesktopBridge;
    }

    test("@core a Help press opens the right pane on a new Chat tab holding a new Help chat", async () => {
        const { host, state } = fakeHost();
        let created = 0;
        const bridge = bridgeWith(async () => {
            created += 1;
            return { ok: true, agentId: `crow-${created}`, workspace: "/nest" };
        });
        await startHelpChat(bridge, () => host);
        await startHelpChat(bridge, () => host);

        const entries = [...chatTabs.snapshot().values()];
        expect(entries.map((entry) => entry.agentId)).toEqual(["crow-1", "crow-2"]);
        expect(entries.every((entry) => entry.kind === "help" && entry.title === HELP_TITLE && entry.chat)).toBe(true);
        expect(new Set(entries.map((entry) => entry.pane)).size).toBe(2);
        expect(state().tabs).toHaveLength(2);
        expect(state().locations.rightPane.visible).toBe(true);
        expect(takePendingAgent("crow-1")).toBe(HELP_AGENT);
        expect(takePendingAgent("crow-1")).toBeUndefined();
        expect(takePendingAgent("crow-2")).toBe(HELP_AGENT);
    });

    test("@core the switch to the Help agent is queued before the tab can attach", async () => {
        const { host } = fakeHost();
        const bridge = bridgeWith(async () => ({ ok: true, agentId: "crow-1", workspace: "" }));
        let queuedWhenOpened: string | undefined;
        const unsubscribe = chatTabs.subscribe(() => {
            queuedWhenOpened = takePendingAgent("crow-1");
        });
        await startHelpChat(bridge, () => host);
        unsubscribe();
        expect(queuedWhenOpened).toBe(HELP_AGENT);
    });

    test("@core a Help press with no room for a tab creates no chat and says so", async () => {
        const { host } = fakeHost();
        for (let index = 0; index < CHAT_TAB_LIMIT; index += 1) openChatTab(host, seed(`crow-${index}`));
        let created = 0;
        await startHelpChat(bridgeWith(async () => { created += 1; return { ok: true, agentId: "crow-x", workspace: "" }; }), () => host);
        expect(created).toBe(0);
        expect(currentToasts().map((toast) => toast.text)).toContain(CHAT_TABS_FULL);
    });

    test("@core a Help press that cannot create a chat opens nothing and says why", async () => {
        const { host } = fakeHost();
        await startHelpChat(bridgeWith(async () => ({ ok: false, reason: "The host is busy." })), () => host);
        await startHelpChat(bridgeWith(async () => { throw new Error("socket closed"); }), () => host);
        expect(chatTabs.snapshot().size).toBe(0);
        const texts = currentToasts().map((toast) => toast.text);
        expect(texts).toContain("The host is busy.");
        expect(texts).toContain("Vera could not start a Help chat.");
    });

    test("the Help command runs what the window gives it", () => {
        const registry = new CommandRegistry();
        let started = 0;
        const dispose = registerChatCommands(registry, { help: () => { started += 1; } });
        expect(registry.execute(CHAT_COMMANDS.help)).toBe(true);
        expect(started).toBe(1);
        dispose();
        expect(registry.has(CHAT_COMMANDS.help)).toBe(false);
    });
});
