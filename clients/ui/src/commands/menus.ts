import { LOCATION_TITLES, LOCATIONS, type LocationId } from "../layout/model.ts";
import { findContainer, findView, type ResolvedLayout } from "../layout/resolve.ts";
import { GENERIC_PAGE_KIND } from "../pagepane/kinds.ts";
import { LAYOUT_COMMANDS } from "./layout-commands.ts";

export type MenuEntry =
    | { readonly kind: "separator" }
    | {
        readonly kind: "item";
        readonly label: string;
        readonly command: string;
        readonly args?: unknown;
        readonly checked?: boolean;
        readonly disabled?: boolean;
    };

const SEPARATOR: MenuEntry = { kind: "separator" };

function item(label: string, command: string, args?: unknown, extra: { checked?: boolean; disabled?: boolean } = {}): MenuEntry {
    return { kind: "item", label, command, args, ...extra };
}

// The menu on a view header.
export function viewMenu(layout: ResolvedLayout, viewId: string): readonly MenuEntry[] {
    const view = findView(layout, viewId);
    const container = view === undefined ? undefined : findContainer(layout, view.container);
    if (view === undefined || container === undefined || viewId === GENERIC_PAGE_KIND) return [];
    const entries: MenuEntry[] = [];
    if (container.views.length > 1) {
        for (const sibling of container.views) {
            entries.push(item(
                sibling.title,
                sibling.hidden ? LAYOUT_COMMANDS.viewShow : LAYOUT_COMMANDS.viewHide,
                { view: sibling.id },
                { checked: !sibling.hidden },
            ));
        }
        entries.push(SEPARATOR);
    }
    entries.push(item(`Hide ${view.title}`, LAYOUT_COMMANDS.viewHide, { view: view.id }), SEPARATOR);
    for (const location of LOCATIONS) {
        const alone = container.generated && container.views.length === 1 && container.location === location;
        entries.push(item(
            `Move to ${LOCATION_TITLES[location]}`,
            LAYOUT_COMMANDS.viewMoveTo,
            { view: view.id, location },
            { disabled: alone },
        ));
    }
    if (container.views.length > 1) {
        entries.push(item("Move to New Container", LAYOUT_COMMANDS.viewMoveTo, { view: view.id, location: container.location }));
    }
    const targets = layout.containers.filter((other) => other.shown && other.id !== container.id && other.id !== GENERIC_PAGE_KIND);
    if (targets.length > 0) entries.push(SEPARATOR);
    for (const target of targets) {
        entries.push(item(
            `Move to ${target.title} (${LOCATION_TITLES[target.location]})`,
            LAYOUT_COMMANDS.viewMoveTo,
            { view: view.id, container: target.id },
        ));
    }
    entries.push(SEPARATOR, item("Reset Location", LAYOUT_COMMANDS.viewReset, { view: view.id }));
    return entries;
}

// The menu on a container's icon or tab.
export function containerMenu(layout: ResolvedLayout, containerId: string): readonly MenuEntry[] {
    const container = findContainer(layout, containerId);
    if (container === undefined) return [];
    const entries: MenuEntry[] = [
        item(`Hide ${container.title}`, LAYOUT_COMMANDS.containerHide, { container: container.id }),
        SEPARATOR,
    ];
    for (const location of LOCATIONS) {
        entries.push(item(
            `Move to ${LOCATION_TITLES[location]}`,
            LAYOUT_COMMANDS.containerMoveTo,
            { container: container.id, location },
            { disabled: location === container.location },
        ));
    }
    entries.push(SEPARATOR, item("Reset Location", LAYOUT_COMMANDS.containerReset, { container: container.id }));
    return entries;
}

// The menu on a right-pane tab: close it, then the menu of its container. Hiding or moving the
// container closes all of that kind's tabs.
export function tabMenu(layout: ResolvedLayout, tabId: string, title?: string): readonly MenuEntry[] {
    const tab = layout.locations.rightPane.tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined) return [];
    if (tab.container.id === GENERIC_PAGE_KIND) return [item(`Close ${title ?? tab.container.title}`, LAYOUT_COMMANDS.tabClose, { tab: tab.id })];
    return [
        item(`Close ${title ?? tab.container.title}`, LAYOUT_COMMANDS.tabClose, { tab: tab.id }),
        SEPARATOR,
        ...containerMenu(layout, tab.container.id),
    ];
}

// The menu on a switcher's empty area: every container placed there. A check means the container is shown.
export function switcherMenu(layout: ResolvedLayout, location: LocationId): readonly MenuEntry[] {
    return layout.locations[location].all.filter((container) => container.id !== GENERIC_PAGE_KIND).map((container) => item(
        container.title,
        container.shown ? LAYOUT_COMMANDS.containerHide : LAYOUT_COMMANDS.containerShow,
        { container: container.id },
        { checked: container.shown },
    ));
}
