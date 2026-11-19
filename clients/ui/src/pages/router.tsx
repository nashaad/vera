import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from "react";

import { registerNavigationCommands } from "../commands/navigation-commands.ts";
import type { CommandRegistry } from "../commands/registry.ts";
import {
    canGoBack,
    canGoForward,
    currentRoute,
    INITIAL_ROUTER,
    initialRouterState,
    lastSession,
    parseSessionRoute,
    reduceRouter,
    serializeSessionRoute,
    SESSION_ROUTE_STORAGE_KEY,
    type Route,
    type SessionRoute,
} from "./routes.ts";

export interface Router {
    readonly route: Route;
    readonly canBack: boolean;
    readonly canForward: boolean;
    readonly lastSession: SessionRoute | undefined;
    readonly navigate: (route: Route) => void;
    readonly missingRestoredSession: (agentId: string) => void;
}

const RouterContext = createContext<Router | undefined>(undefined);

export function useRouter(): Router {
    const router = useContext(RouterContext);
    if (router === undefined) throw new Error("A page needs a RouterProvider.");
    return router;
}

function readStoredSessionRoute(): SessionRoute | undefined {
    if (typeof window === "undefined") return undefined;
    try {
        return parseSessionRoute(window.sessionStorage.getItem(SESSION_ROUTE_STORAGE_KEY));
    } catch {
        return undefined;
    }
}

function writeStoredSessionRoute(route: Route): void {
    if (typeof window === "undefined") return;
    try {
        const value = serializeSessionRoute(route);
        if (value === undefined) window.sessionStorage.removeItem(SESSION_ROUTE_STORAGE_KEY);
        else window.sessionStorage.setItem(SESSION_ROUTE_STORAGE_KEY, value);
    } catch {}
}

export interface RouterProviderProps {
    readonly commands: CommandRegistry;
    readonly children: ReactNode;
}

// Back, forward and the page commands all go through the same reducer.
export function RouterProvider({ commands, children }: RouterProviderProps) {
    const restoredSessionId = useRef<string | undefined>(undefined);
    const [state, dispatch] = useReducer(reduceRouter, INITIAL_ROUTER, () => {
        const route = readStoredSessionRoute();
        restoredSessionId.current = route?.agentId;
        return initialRouterState(route);
    });
    useEffect(() => registerNavigationCommands(commands, dispatch), [commands]);
    useEffect(() => {
        const route = currentRoute(state);
        writeStoredSessionRoute(route);
        if (restoredSessionId.current !== undefined
            && (route.kind !== "session" || route.agentId !== restoredSessionId.current)) {
            restoredSessionId.current = undefined;
        }
    }, [state]);
    const missingRestoredSession = useCallback((agentId: string) => {
        if (restoredSessionId.current !== agentId) return;
        restoredSessionId.current = undefined;
        dispatch({ type: "reset" });
    }, []);
    const router = useMemo<Router>(() => ({
        route: currentRoute(state),
        canBack: canGoBack(state),
        canForward: canGoForward(state),
        lastSession: lastSession(state),
        navigate: (route) => {
            restoredSessionId.current = undefined;
            dispatch({ type: "navigate", route });
        },
        missingRestoredSession,
    }), [state, missingRestoredSession]);
    return <RouterContext.Provider value={router}>{children}</RouterContext.Provider>;
}
