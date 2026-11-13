import { sessionPlace, type Route, type SessionRoute } from "../pages/routes.ts";
import { showToast } from "../overlays/toasts.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { CORE_CONTAINERS } from "../registry/core.ts";
import { activeSession, whenSessionActive } from "../session/activeSession.ts";
import { renameSession } from "../session/rename.ts";
import { openSessionSheet } from "../session/sessionSheets.ts";
import { toggleSessionPin } from "../state/usePins.ts";
import { LAYOUT_COMMANDS } from "./layout-commands.ts";
import type { CommandRegistry } from "./registry.ts";
import { SESSION_COMMANDS } from "./session-commands.ts";

export interface SessionWindowDeps {
    readonly navigate: (route: Route) => void;
    // The route of the session that started the given one, if the session list knows it.
    readonly parentRoute: (agentId: string) => SessionRoute | undefined;
    readonly bridge: () => DesktopBridge | undefined;
}

// A session named by a sidebar row, which need not be the open one.
export interface SessionTarget {
    readonly agentId: string;
    readonly title: string;
    readonly workspace: string;
    readonly chat: boolean;
}

// Commands on a sidebar row's session. They take the row as their argument, so the palette does not list them.
export const SESSION_ROW_COMMANDS = {
    rename: "sessions.rename",
    togglePin: "sessions.togglePin",
    openFiles: "sessions.openFiles",
    clone: "sessions.clone",
    close: "sessions.close",
} as const;

export function sessionTarget(args: unknown): SessionTarget | undefined {
    if (typeof args !== "object" || args === null) return undefined;
    const fields = args as Record<string, unknown>;
    if (typeof fields.agentId !== "string" || fields.agentId.length === 0) return undefined;
    return {
        agentId: fields.agentId,
        title: typeof fields.title === "string" ? fields.title : fields.agentId,
        workspace: typeof fields.workspace === "string" ? fields.workspace : "",
        chat: fields.chat === true,
    };
}

function routeTo(target: SessionTarget): SessionRoute {
    return { kind: "session", agentId: target.agentId, title: target.title, ...sessionPlace(target.workspace, target.chat) };
}

// Rename, clone, close and parent for the open session, and the same for a sidebar row's session.
export function registerSessionWindowCommands(registry: CommandRegistry, deps: SessionWindowDeps): () => void {
    const open = (target: SessionTarget): void => {
        if (activeSession()?.agentId !== target.agentId) deps.navigate(routeTo(target));
    };
    const clone = (bridge: DesktopBridge, source: SessionTarget): void => {
        void bridge.cloneSession(source.agentId).then((result) => {
            if (!result.ok) {
                showToast(result.reason, "danger");
                return;
            }
            deps.navigate({
                kind: "session",
                agentId: result.agentId,
                title: `Clone of ${source.title}`,
                ...sessionPlace(result.workspace, source.chat),
            });
            showToast("Cloned the session", "success");
        });
    };
    // Only closing the session on the page leaves the page.
    const close = (bridge: DesktopBridge, agentId: string): void => {
        const leave = activeSession()?.agentId === agentId;
        void bridge.closeSession(agentId).then((result) => {
            if (!result.ok) {
                showToast(result.reason, "danger");
                return;
            }
            if (leave) deps.navigate({ kind: "home" });
            showToast("Session closed", "success");
        });
    };
    const onActive = (run: (bridge: DesktopBridge, session: SessionTarget) => void) => () => {
        const session = activeSession();
        if (session === undefined) return;
        run(session.bridge, { agentId: session.agentId, title: session.title, workspace: session.folder ?? "", chat: session.chat });
    };
    const onRow = (run: (target: SessionTarget) => void) => (args: unknown) => {
        const target = sessionTarget(args);
        if (target !== undefined) run(target);
    };
    const withBridge = (run: (bridge: DesktopBridge, target: SessionTarget) => void) => onRow((target) => {
        const bridge = deps.bridge();
        if (bridge !== undefined) run(bridge, target);
    });

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
        registry.register({ id: SESSION_COMMANDS.clone, title: "Clone Session", run: onActive(clone) }),
        registry.register({
            id: SESSION_COMMANDS.close,
            title: "Close Session",
            run: onActive((bridge, session) => close(bridge, session.agentId)),
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
        registry.register({
            id: SESSION_ROW_COMMANDS.rename,
            title: "Rename Session…",
            needsArgs: true,
            run: onRow((target) => {
                open(target);
                whenSessionActive(target.agentId, () => openSessionSheet("rename"));
            }),
        }),
        registry.register({
            id: SESSION_ROW_COMMANDS.togglePin,
            title: "Pin Session",
            needsArgs: true,
            run: onRow((target) => toggleSessionPin(target.agentId)),
        }),
        registry.register({
            id: SESSION_ROW_COMMANDS.openFiles,
            title: "Open Files Pane",
            needsArgs: true,
            run: onRow((target) => {
                open(target);
                registry.execute(LAYOUT_COMMANDS.containerActivate, { container: CORE_CONTAINERS.files });
            }),
        }),
        registry.register({ id: SESSION_ROW_COMMANDS.clone, title: "Clone Session", needsArgs: true, run: withBridge(clone) }),
        registry.register({
            id: SESSION_ROW_COMMANDS.close,
            title: "Close Session",
            needsArgs: true,
            run: withBridge((bridge, target) => close(bridge, target.agentId)),
        }),
    ];
    return () => {
        for (const dispose of disposers) dispose();
    };
}
