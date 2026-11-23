import type { MenuEntry } from "../commands/menus.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import { copyText } from "./copyText.ts";

export const TREE_COPY_PATH = "tree.copy-path";
export const TREE_COPY_RELATIVE_PATH = "tree.copy-relative-path";
export const TREE_OPEN_DEFAULT = "tree.open-default";

export function treeRowPath(event: Event): string | undefined {
    return event.composedPath().find((node): node is HTMLElement =>
        node instanceof HTMLElement && node.dataset["itemPath"] !== undefined,
    )?.dataset["itemPath"];
}

export function treeActionEntries(absolute: string, relative: string): MenuEntry[] {
    return [
        { kind: "item", label: "Copy path", command: TREE_COPY_PATH, args: { absolute } },
        { kind: "item", label: "Copy relative path", command: TREE_COPY_RELATIVE_PATH, args: { relative } },
        { kind: "item", label: "Open in default app", command: TREE_OPEN_DEFAULT, args: { absolute } },
    ];
}

export function runTreeAction(command: string, absolute: string, relative: string, bridge: DesktopBridge): boolean {
    if (command === TREE_COPY_PATH) {
        void copyText(absolute);
        return true;
    }
    if (command === TREE_COPY_RELATIVE_PATH) {
        void copyText(relative);
        return true;
    }
    if (command === TREE_OPEN_DEFAULT) {
        void bridge.revealFolder(absolute);
        return true;
    }
    return false;
}
