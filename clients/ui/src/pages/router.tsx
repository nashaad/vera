import { createContext, useContext, useEffect, useMemo, useReducer, type ReactNode } from "react";

import { registerNavigationCommands } from "../commands/navigation-commands.ts";
import type { CommandRegistry } from "../commands/registry.ts";
import {
    canGoBack,
    canGoForward,
    currentRoute,
    INITIAL_ROUTER,
    reduceRouter,
    type Route,
} from "./routes.ts";

export interface Router {
    readonly route: Route;
    readonly canBack: boolean;
    readonly canForward: boolean;
    readonly navigate: (route: Route) => void;
}

const RouterContext = createContext<Router | undefined>(undefined);

export function useRouter(): Router {
    const router = useContext(RouterContext);
    if (router === undefined) throw new Error("A page needs a RouterProvider.");
    return router;
}

export interface RouterProviderProps {
    readonly commands: CommandRegistry;
    readonly children: ReactNode;
}

// Back, forward and the page commands all go through the same reducer.
export function RouterProvider({ commands, children }: RouterProviderProps) {
    const [state, dispatch] = useReducer(reduceRouter, INITIAL_ROUTER);
    useEffect(() => registerNavigationCommands(commands, dispatch), [commands]);
    const router = useMemo<Router>(() => ({
        route: currentRoute(state),
        canBack: canGoBack(state),
        canForward: canGoForward(state),
        navigate: (route) => dispatch({ type: "navigate", route }),
    }), [state]);
    return <RouterContext.Provider value={router}>{children}</RouterContext.Provider>;
}
