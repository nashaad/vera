import type { PageKind, Route, RouterAction } from "../pages/routes.ts";
import { sessionSearchFocus, settingsSearchFocus } from "../pages/focusSearch.ts";
import { FIND_CLOSE_COMMAND } from "./keys.ts";
import type { CommandRegistry } from "./registry.ts";

export const NAVIGATION_COMMANDS = {
    newChat: "go.newChat",
    search: "go.search",
    work: "go.work",
    customize: "go.customize",
    settings: "go.settings",
    devices: "go.devices",
    tour: "go.tour",
    coverage: "go.coverage",
    back: "go.back",
    forward: "go.forward",
} as const;

const PAGES: ReadonlyArray<readonly [string, string, PageKind]> = [
    [NAVIGATION_COMMANDS.newChat, "New Chat", "home"],
    [NAVIGATION_COMMANDS.search, "Search", "search"],
    [NAVIGATION_COMMANDS.work, "Work", "work"],
    [NAVIGATION_COMMANDS.customize, "Plugins", "customize"],
    [NAVIGATION_COMMANDS.settings, "Settings", "settings"],
    [NAVIGATION_COMMANDS.devices, "Devices", "devices"],
    [NAVIGATION_COMMANDS.tour, "Tour", "tour"],
    [NAVIGATION_COMMANDS.coverage, "Coverage", "coverage"],
];

export function closeFindOnSearchEntry(registry: CommandRegistry, previous: Route["kind"], current: Route["kind"]): void {
    if (previous !== "search" && current === "search") registry.execute(FIND_CLOSE_COMMAND);
}

export function registerNavigationCommands(
    registry: CommandRegistry,
    dispatch: (action: RouterAction) => void,
): () => void {
    const disposers = [
        ...PAGES.map(([id, title, kind]) => registry.register({
            id,
            title,
            run: () => {
                if (id === NAVIGATION_COMMANDS.settings) settingsSearchFocus.request();
                if (id === NAVIGATION_COMMANDS.search) {
                    registry.execute(FIND_CLOSE_COMMAND);
                    sessionSearchFocus.request();
                }
                dispatch({ type: "navigate", route: { kind } });
            },
        })),
        registry.register({ id: NAVIGATION_COMMANDS.back, title: "Back", run: () => dispatch({ type: "back" }) }),
        registry.register({ id: NAVIGATION_COMMANDS.forward, title: "Forward", run: () => dispatch({ type: "forward" }) }),
    ];
    return () => {
        for (const dispose of disposers) dispose();
    };
}
