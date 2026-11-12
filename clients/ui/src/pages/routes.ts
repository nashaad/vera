export type PageKind = "home" | "search" | "work" | "customize" | "settings";

export interface PageRoute {
    readonly kind: PageKind;
}

export type Route = PageRoute;

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
};

export function sameRoute(left: Route, right: Route): boolean {
    return left.kind === right.kind;
}

export function currentRoute(state: RouterState): Route {
    return state.history[state.cursor] ?? INITIAL_ROUTER.history[0] as Route;
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
    return PAGE_TITLES[route.kind];
}
