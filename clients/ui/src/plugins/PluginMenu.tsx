import { ContextMenu } from "../workbench/ContextMenu.tsx";
import { dirname } from "../customize/catalog.ts";
import type { DesktopBridge } from "../protocol/bridge.ts";
import type { MenuEntry } from "../commands/menus.ts";
import { pluginEditorPath, type PluginItem } from "./items.ts";

export interface PluginMenuProps {
    readonly item: PluginItem;
    readonly x: number;
    readonly y: number;
    readonly onClose: () => void;
}

const OPEN_EDITOR = "plugins.openEditor";
const REVEAL = "plugins.reveal";
const COPY_MARKDOWN = "plugins.copyMarkdown";
const COPY_PATH = "plugins.copyPath";

function desktopBridge(): DesktopBridge | undefined {
    return typeof window === "undefined" ? undefined : window.veraDesktop;
}

export function PluginMenu({ item, x, y, onClose }: PluginMenuProps) {
    const bridge = desktopBridge();
    const path = item.source?.path;
    const editorPath = pluginEditorPath(item);
    const content = item.source?.content ?? "";
    const entries: readonly MenuEntry[] = [
        { kind: "item", label: "Open in editor", command: OPEN_EDITOR, disabled: bridge === undefined || editorPath === undefined },
        {
            kind: "item",
            label: bridge?.platform === "darwin" ? "Show in Finder" : "Open folder",
            command: REVEAL,
            disabled: bridge === undefined || path === undefined,
        },
        { kind: "item", label: "Copy Markdown", command: COPY_MARKDOWN, disabled: content.length === 0 },
        { kind: "separator" },
        { kind: "item", label: "Copy path", command: COPY_PATH, disabled: path === undefined },
    ];
    const run = (command: string): void => {
        if (command === OPEN_EDITOR && editorPath !== undefined) {
            void bridge?.openFile(editorPath);
        } else if (command === REVEAL && path !== undefined) {
            void bridge?.revealFolder(dirname(path));
        } else if (command === COPY_MARKDOWN) {
            void navigator.clipboard.writeText(content);
        } else if (command === COPY_PATH && path !== undefined) {
            void navigator.clipboard.writeText(path);
        }
    };
    return <ContextMenu entries={entries} x={x} y={y} onRun={run} onClose={onClose} />;
}
