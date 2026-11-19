import { requestAddress } from "../browser/address-request.ts";
import { BROWSER_CONTAINER, openBrowserTab } from "../browser/open.ts";
import { canOpenTab, findContainer, type ResolvedLayout } from "../layout/resolve.ts";
import type { PageHost } from "../pagepane/open.ts";
import type { CommandRegistry } from "./registry.ts";

export const OPEN_BROWSER_COMMAND = "page.openBrowser";

export function browserTab(layout: ResolvedLayout): string | undefined {
    const container = findContainer(layout, BROWSER_CONTAINER);
    if (container === undefined || !container.shown || container.location !== "rightPane") return undefined;
    const tabs = layout.locations.rightPane.tabs.filter((tab) => tab.container.id === BROWSER_CONTAINER);
    return layout.recentTabs.find((id) => tabs.some((tab) => tab.id === id)) ?? tabs[0]?.id;
}

export function canOpenBrowser(layout: ResolvedLayout): boolean {
    return browserTab(layout) !== undefined || canOpenTab(layout, BROWSER_CONTAINER);
}

export function openBrowser(host: PageHost): void {
    const existing = browserTab(host.layout);
    if (existing !== undefined) {
        host.dispatch({ type: "activateTab", tab: existing });
        requestAddress(existing);
    } else if (canOpenTab(host.layout, BROWSER_CONTAINER)) {
        requestAddress(openBrowserTab(host.dispatch, {}));
    }
}

export function registerOpenBrowser(registry: CommandRegistry, available: boolean, open: () => void): () => void {
    if (!available) return () => {};
    return registry.register({
        id: OPEN_BROWSER_COMMAND,
        title: "Open a web page",
        paletteSearchText: "Open a web page browser web url site internet",
        run: open,
    });
}
