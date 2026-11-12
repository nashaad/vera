import { afterEach, describe, expect, test } from "bun:test";

import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { registerSessionWindowCommands } from "../../clients/ui/src/commands/session-window-commands.ts";
import { SESSION_COMMANDS } from "../../clients/ui/src/commands/session-commands.ts";
import { currentToasts } from "../../clients/ui/src/overlays/toasts.ts";
import type { DesktopBridge } from "../../clients/ui/src/protocol/bridge.ts";
import { clearActiveSession, publishActiveSession } from "../../clients/ui/src/session/activeSession.ts";
import { closeSessionSheet, openedSessionSheet } from "../../clients/ui/src/session/sessionSheets.ts";
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
        registerSessionWindowCommands(registry, { navigate: (route) => routes.push(route), parentRoute: () => undefined });
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
});
