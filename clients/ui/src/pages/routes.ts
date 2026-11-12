import { folderName } from "../protocol/sessionGroups.ts";

export type PageKind = "home" | "search" | "work" | "customize" | "settings" | "devices" | "tour" | "coverage";

export interface PageRoute {
    readonly kind: Exclude<PageKind, "home">;
}

export interface HomeRoute {
    readonly kind: "home";
    // New Chat starts in this folder when set, as "New chat here" asks.
    readonly folder?: string;
}

export interface WorkspaceRoute {
    readonly kind: "workspace";
    readonly folder: string;
}

export interface SessionRoute {
    readonly kind: "session";
    readonly agentId: string;
    // The name the session had when it was opened; the header shows it.
    readonly title: string;
    // The folder a session made on New Chat was created in, shown until the session list carries it.
    readonly workspace?: string;
    // Set for a chat, until the session list carries it.
    readonly chat?: boolean;
}

// Where a session runs, for a route that opens it before the session list carries its row.
export function sessionPlace(workspace: string, chat: boolean): Pick<SessionRoute, "workspace" | "chat"> {
    if (chat) return { chat: true };
    return workspace.length > 0 ? { workspace } : {};
}

export type Route = HomeRoute | PageRoute | SessionRoute | WorkspaceRoute;

export interface RouterState {
    readonly history: readonly Route[];
    readonly cursor: number;
}

export type RouterAction =
    | { readonly type: "navigate"; readonly route: Route }
    | { readonly type: "back" }
    | { readonly type: "forward" };

// Back and forward remember this many pages; older ones fall off the start.
export const HISTORY_LIMIT = 50;

export const INITIAL_ROUTER: RouterState = { history: [{ kind: "home" }], cursor: 0 };

export const PAGE_TITLES: Readonly<Record<PageKind, string>> = {
    home: "New Chat",
    search: "Search",
    work: "Work",
    customize: "Customize",
    settings: "Settings",
    devices: "Devices",
    tour: "Tour",
    coverage: "Coverage",
};

export function sameRoute(left: Route, right: Route): boolean {
    if (left.kind === "session") return right.kind === "session" && left.agentId === right.agentId;
    if (left.kind === "workspace") return right.kind === "workspace" && left.folder === right.folder;
    if (left.kind === "home") return right.kind === "home" && left.folder === right.folder;
    return left.kind === right.kind;
}

export function currentRoute(state: RouterState): Route {
    return state.history[state.cursor] ?? INITIAL_ROUTER.history[0] as Route;
}

// The newest session at or before the page shown, so Search can offer "This conversation".
export function lastSession(state: RouterState): SessionRoute | undefined {
    for (let index = state.cursor; index >= 0; index -= 1) {
        const route = state.history[index];
        if (route?.kind === "session") return route;
    }
    return undefined;
}

export function canGoBack(state: RouterState): boolean {
    return state.cursor > 0;
}

export function canGoForward(state: RouterState): boolean {
    return state.cursor < state.history.length - 1;
}

export function reduceRouter(state: RouterState, action: RouterAction): RouterState {
    switch (action.type) {
        case "back":
            return canGoBack(state) ? { ...state, cursor: state.cursor - 1 } : state;
        case "forward":
            return canGoForward(state) ? { ...state, cursor: state.cursor + 1 } : state;
        case "navigate": {
            if (sameRoute(currentRoute(state), action.route)) return state;
            // Going somewhere new drops the forward entries, as a browser does.
            const kept = [...state.history.slice(0, state.cursor + 1), action.route];
            const history = kept.slice(Math.max(0, kept.length - HISTORY_LIMIT));
            return { history, cursor: history.length - 1 };
        }
    }
}

export function routeTitle(route: Route): string {
    if (route.kind === "session") return route.title;
    if (route.kind === "workspace") return folderName(route.folder);
    return PAGE_TITLES[route.kind];
}
