import { sessionPlace, type Route, type SessionRoute } from "../pages/routes.ts";
import { showToast } from "../overlays/toasts.ts";
import { activeSession } from "../session/activeSession.ts";
import { renameSession } from "../session/rename.ts";
import { openSessionSheet } from "../session/sessionSheets.ts";
import type { CommandRegistry } from "./registry.ts";
import { SESSION_COMMANDS } from "./session-commands.ts";

export interface SessionWindowDeps {
    readonly navigate: (route: Route) => void;
    // The route of the session that started the given one, if the session list knows it.
    readonly parentRoute: (agentId: string) => SessionRoute | undefined;
}

// Rename, clone, close and parent for the open session. They do nothing while no session page is open.
export function registerSessionWindowCommands(registry: CommandRegistry, deps: SessionWindowDeps): () => void {
    const disposers = [
        registry.register({
            id: SESSION_COMMANDS.rename,
            title: "Rename Session…",
            run: (args) => {
                const session = activeSession();
                if (session === undefined) return;
                const name = typeof args === "string" ? args.trim() : "";
                if (name.length === 0) {
                    openSessionSheet("rename");
                    return;
                }
                void renameSession(session, name).then((result) => {
                    if (result.ok) showToast(`Renamed to ${result.name ?? name}`, "success");
                    else showToast(result.message, "danger");
                });
            },
        }),
        registry.register({
            id: SESSION_COMMANDS.clone,
            title: "Clone Session",
            run: () => {
                const session = activeSession();
                if (session === undefined) return;
                void session.bridge.cloneSession(session.agentId).then((result) => {
                    if (!result.ok) {
                        showToast(result.reason, "danger");
                        return;
                    }
                    deps.navigate({
                        kind: "session",
                        agentId: result.agentId,
                        title: `Clone of ${session.title}`,
                        ...sessionPlace(result.workspace, session.chat),
                    });
                    showToast("Cloned the session", "success");
                });
            },
        }),
        registry.register({
            id: SESSION_COMMANDS.close,
            title: "Close Session",
            run: () => {
                const session = activeSession();
                if (session === undefined) return;
                void session.bridge.closeSession(session.agentId).then((result) => {
                    if (!result.ok) {
                        showToast(result.reason, "danger");
                        return;
                    }
                    deps.navigate({ kind: "home" });
                    showToast("Session closed", "success");
                });
            },
        }),
        registry.register({
            id: SESSION_COMMANDS.parent,
            title: "Go to Parent Session",
            run: () => {
                const session = activeSession();
                if (session === undefined) return;
                const parent = deps.parentRoute(session.agentId);
                if (parent === undefined) showToast("This session has no parent", "info");
                else deps.navigate(parent);
            },
        }),
    ];
    return () => {
        for (const dispose of disposers) dispose();
    };
}
