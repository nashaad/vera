import { afterEach, describe, expect, test } from "bun:test";

import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { sessionRowMenu } from "../../clients/ui/src/commands/session-row-menu.ts";
import {
    registerSessionWindowCommands,
    SESSION_ROW_COMMANDS,
    sessionTarget,
} from "../../clients/ui/src/commands/session-window-commands.ts";
import { LAYOUT_COMMANDS } from "../../clients/ui/src/commands/layout-commands.ts";
import { SESSION_COMMANDS } from "../../clients/ui/src/commands/session-commands.ts";
import { currentToasts } from "../../clients/ui/src/overlays/toasts.ts";
import type { DesktopBridge } from "../../clients/ui/src/protocol/bridge.ts";
import { clearActiveSession, publishActiveSession } from "../../clients/ui/src/session/activeSession.ts";
import { closeSessionSheet, openedSessionSheet } from "../../clients/ui/src/session/sessionSheets.ts";
import { isPinned, toggleSessionPin } from "../../clients/ui/src/state/usePins.ts";
import type { SessionRow } from "../../clients/ui/src/protocol/sessions.ts";
import { initialWatch } from "../../clients/ui/src/session/transcript.ts";

describe("window session commands", () => {
    afterEach(() => {
        closeSessionSheet();
        clearActiveSession("crow-1");
    });

    function wired(bridge: Partial<DesktopBridge>, parent?: { kind: "session"; agentId: string; title: string }) {
        const registry = new CommandRegistry();
        const routes: unknown[] = [];
        registerSessionWindowCommands(registry, {
            navigate: (route) => routes.push(route),
            parentRoute: () => parent,
            bridge: () => bridge as DesktopBridge,
        });
        publishActiveSession({
            bridge: bridge as DesktopBridge,
            agentId: "crow-1",
            title: "Crow's nest",
            chat: false,
            watch: initialWatch("crow-1"),
            send: () => undefined,
        });
        return { registry, routes };
    }

    function lastToast(): string | undefined {
        return currentToasts().at(-1)?.text;
    }

    test("@core they do nothing while no session page is open", () => {
        const registry = new CommandRegistry();
        const routes: unknown[] = [];
        registerSessionWindowCommands(registry, { navigate: (route) => routes.push(route), parentRoute: () => undefined, bridge: () => undefined });
        const before = currentToasts().length;
        for (const id of [SESSION_COMMANDS.rename, SESSION_COMMANDS.clone, SESSION_COMMANDS.close, SESSION_COMMANDS.parent]) {
            expect(registry.execute(id)).toBe(true);
        }
        expect(routes).toEqual([]);
        expect(openedSessionSheet()).toBeUndefined();
        expect(currentToasts()).toHaveLength(before);
    });

    test("rename with no name opens the sheet", () => {
        const { registry } = wired({});
        registry.execute(SESSION_COMMANDS.rename);
        expect(openedSessionSheet()).toBe("rename");
        closeSessionSheet();
        registry.execute(SESSION_COMMANDS.rename, "   ");
        expect(openedSessionSheet()).toBe("rename");
    });

    test("@core clone opens the copy and close returns home", async () => {
        const closed: string[] = [];
        const { registry, routes } = wired({
            cloneSession: async () => ({ ok: true, agentId: "crow-2", workspace: "/nests/north", prompt: "" }),
            closeSession: async (agentId) => {
                closed.push(agentId);
                return { ok: true, retained: true };
            },
        });
        registry.execute(SESSION_COMMANDS.clone);
        await Bun.sleep(0);
        expect(routes).toEqual([{ kind: "session", agentId: "crow-2", title: "Clone of Crow's nest", workspace: "/nests/north" }]);
        expect(lastToast()).toBe("Cloned the session");
        registry.execute(SESSION_COMMANDS.close);
        await Bun.sleep(0);
        expect(closed).toEqual(["crow-1"]);
        expect(routes.at(-1)).toEqual({ kind: "home" });
        expect(lastToast()).toBe("Session closed");
    });

    test("a refused clone or close stays on the page and says why", async () => {
        const { registry, routes } = wired({
            cloneSession: async () => ({ ok: false, reason: "The host could not copy the session" }),
            closeSession: async () => ({ ok: false, reason: "The host could not close the session" }),
        });
        registry.execute(SESSION_COMMANDS.clone);
        await Bun.sleep(0);
        expect(lastToast()).toBe("The host could not copy the session");
        registry.execute(SESSION_COMMANDS.close);
        await Bun.sleep(0);
        expect(lastToast()).toBe("The host could not close the session");
        expect(routes).toEqual([]);
    });

    test("@core parent goes to the session that started this one, or says there is none", () => {
        const none = wired({});
        none.registry.execute(SESSION_COMMANDS.parent);
        expect(none.routes).toEqual([]);
        expect(lastToast()).toBe("This session has no parent");
        clearActiveSession("crow-1");

        const parent = { kind: "session" as const, agentId: "crow-0", title: "Crow's roost" };
        const found = wired({}, parent);
        found.registry.execute(SESSION_COMMANDS.parent);
        expect(found.routes).toEqual([parent]);
    });

    const other = { agentId: "crow-9", title: "Gull rock", workspace: "/nests/south", chat: false };

    test("@core a row's rename opens that session, then its rename sheet once its page is up", () => {
        const { registry, routes } = wired({});
        registry.execute(SESSION_ROW_COMMANDS.rename, other);
        expect(routes).toEqual([{ kind: "session", agentId: "crow-9", title: "Gull rock", workspace: "/nests/south" }]);
        expect(openedSessionSheet()).toBeUndefined();
        publishActiveSession({
            bridge: {} as DesktopBridge,
            agentId: "crow-9",
            title: "Gull rock",
            chat: false,
            watch: initialWatch("crow-9"),
            send: () => undefined,
        });
        expect(openedSessionSheet()).toBe("rename");
        clearActiveSession("crow-9");
    });

    test("a row's rename on the open session opens the sheet in place", () => {
        const { registry, routes } = wired({});
        registry.execute(SESSION_ROW_COMMANDS.rename, { ...other, agentId: "crow-1" });
        expect(routes).toEqual([]);
        expect(openedSessionSheet()).toBe("rename");
    });

    test("@core a row's Open Files Pane opens the session and shows the Files view", () => {
        const { registry, routes } = wired({});
        const activated: unknown[] = [];
        registry.register({ id: LAYOUT_COMMANDS.containerActivate, title: "Activate", needsArgs: true, run: (args) => activated.push(args) });
        registry.execute(SESSION_ROW_COMMANDS.openFiles, other);
        expect(routes).toHaveLength(1);
        expect(activated).toEqual([{ container: "core.files" }]);
    });

    test("@core a row's close stays on the open page, and a row's clone opens the copy", async () => {
        const closed: string[] = [];
        const { registry, routes } = wired({
            cloneSession: async () => ({ ok: true, agentId: "crow-10", workspace: "/nests/south", prompt: "" }),
            closeSession: async (agentId) => {
                closed.push(agentId);
                return { ok: true, retained: true };
            },
        });
        registry.execute(SESSION_ROW_COMMANDS.close, other);
        await Bun.sleep(0);
        expect(closed).toEqual(["crow-9"]);
        expect(routes).toEqual([]);
        expect(lastToast()).toBe("Session closed");
        registry.execute(SESSION_ROW_COMMANDS.clone, other);
        await Bun.sleep(0);
        expect(routes).toEqual([{ kind: "session", agentId: "crow-10", title: "Clone of Gull rock", workspace: "/nests/south" }]);
    });

    test("a row's pin toggles", () => {
        const { registry } = wired({});
        expect(isPinned("crow-9")).toBe(false);
        registry.execute(SESSION_ROW_COMMANDS.togglePin, other);
        expect(isPinned("crow-9")).toBe(true);
        toggleSessionPin("crow-9");
        expect(isPinned("crow-9")).toBe(false);
    });

    test("row commands ignore a missing session", () => {
        expect(sessionTarget(undefined)).toBeUndefined();
        expect(sessionTarget({ agentId: "" })).toBeUndefined();
        expect(sessionTarget({ agentId: "crow-9" })).toEqual({ agentId: "crow-9", title: "crow-9", workspace: "", chat: false });
    });
});

describe("session row menu", () => {
    const row: SessionRow = { id: "crow-9", name: "Gull rock", workspace: "/nests/south", status: "idle", live: true, chat: false };
    const labels = (entries: ReturnType<typeof sessionRowMenu>) => entries.map((entry) => (entry.kind === "item" ? entry.label : "-"));

    test("@core offers rename, pin, files, clone and close for a live session", () => {
        expect(labels(sessionRowMenu(row, false))).toEqual(["Rename…", "Pin Session", "Open Files Pane", "-", "Clone Session", "Close Session"]);
        expect(labels(sessionRowMenu(row, true))[1]).toBe("Unpin Session");
    });

    test("a stopped session has nothing to close", () => {
        expect(labels(sessionRowMenu({ ...row, live: false }, false))).not.toContain("Close Session");
    });
});
