import { expect, test } from "bun:test";

import { takeAddressRequest } from "../../clients/ui/src/browser/address-request.ts";
import { browserSlots } from "../../clients/ui/src/browser/slots.ts";
import { browserTab, canOpenBrowser, openBrowser, OPEN_BROWSER_COMMAND, registerOpenBrowser } from "../../clients/ui/src/commands/open-browser.ts";
import { CommandRegistry } from "../../clients/ui/src/commands/registry.ts";
import { defaultLayout, MAX_TABS, type LayoutState } from "../../clients/ui/src/layout/model.ts";
import { reduceLayout, type LayoutAction } from "../../clients/ui/src/layout/reducer.ts";
import { resolveLayout, type ResolvedLayout } from "../../clients/ui/src/layout/resolve.ts";
import { buildCommandItems, rankItems } from "../../clients/ui/src/overlays/palette.ts";
import type { PageHost } from "../../clients/ui/src/pagepane/open.ts";
import { ContributionRegistry } from "../../clients/ui/src/registry/contributions.ts";
import { CORE_CONTAINERS, registerCoreContributions } from "../../clients/ui/src/registry/core.ts";

function harness() {
    const registry = new ContributionRegistry();
    registerCoreContributions(registry);
    const snapshot = registry.snapshot();
    let state: LayoutState = defaultLayout();
    const host: PageHost & { layout: ResolvedLayout } = {
        layout: resolveLayout(state, snapshot),
        dispatch(action: LayoutAction) {
            state = reduceLayout(state, action, snapshot);
            host.layout = resolveLayout(state, snapshot);
        },
    };
    return host;
}

test("the browser command is listed, searchable and runs the open path", () => {
    const host = harness();
    const commands = new CommandRegistry();
    registerOpenBrowser(commands, canOpenBrowser(host.layout), () => openBrowser(host));
    const items = buildCommandItems(commands.list(), "darwin");
    expect(rankItems(items, "").map(({ item }) => item.label)).toContain("Open a web page");
    for (const query of ["browser", "web", "url", "site", "internet", "open a web page"]) {
        expect(rankItems(items, query).some(({ item }) => item.id === OPEN_BROWSER_COMMAND)).toBe(true);
    }
    expect(canOpenBrowser(host.layout)).toBe(true);
    commands.execute(OPEN_BROWSER_COMMAND);
    const first = browserTab(host.layout)!;
    expect(first).toBeDefined();
    expect(host.layout.locations.rightPane.visible).toBe(true);
    expect(takeAddressRequest(first)).toBe(true);
    host.dispatch({ type: "openTab", container: CORE_CONTAINERS.plan });
    host.dispatch({ type: "setLocationVisible", location: "rightPane", visible: false });
    commands.execute(OPEN_BROWSER_COMMAND);
    expect(host.layout.locations.rightPane.activeTab?.id).toBe(first);
    expect(host.layout.locations.rightPane.visible).toBe(true);
    expect(takeAddressRequest(first)).toBe(true);
    expect(host.layout.locations.rightPane.tabs.filter((tab) => tab.container.id === CORE_CONTAINERS.browser)).toHaveLength(1);
    browserSlots.reset();
});

test("the command is unavailable without a Browser container or room for a tab", () => {
    const host = harness();
    for (let index = 0; index < MAX_TABS; index++) host.dispatch({ type: "openTab", container: CORE_CONTAINERS.plan });
    expect(canOpenBrowser(host.layout)).toBe(false);
    const commands = new CommandRegistry();
    registerOpenBrowser(commands, canOpenBrowser(host.layout), () => openBrowser(host));
    expect(commands.list().some((command) => command.id === OPEN_BROWSER_COMMAND)).toBe(false);
    const hidden = harness();
    hidden.dispatch({ type: "setContainerHidden", container: CORE_CONTAINERS.browser, hidden: true });
    expect(canOpenBrowser(hidden.layout)).toBe(false);
    const contributions = new ContributionRegistry();
    const absent = resolveLayout(defaultLayout(), contributions.snapshot());
    expect(canOpenBrowser(absent)).toBe(false);
    registerOpenBrowser(commands, canOpenBrowser(absent), () => openBrowser(host));
    expect(commands.list()).toEqual([]);
});

test("an existing Browser tab remains usable at the Browser limit", () => {
    const host = harness();
    for (let index = 0; index < 12; index++) host.dispatch({ type: "openTab", container: CORE_CONTAINERS.browser });
    expect(canOpenBrowser(host.layout)).toBe(true);
    const latest = browserTab(host.layout)!;
    openBrowser(host);
    expect(takeAddressRequest(latest)).toBe(true);
    expect(host.layout.locations.rightPane.tabs).toHaveLength(12);
});
