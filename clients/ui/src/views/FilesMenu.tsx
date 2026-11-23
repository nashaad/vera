import { useState } from "react";
import type { FileTreeSearchMode } from "@pierre/trees";
import { MoreIcon } from "../components/Icons.tsx";
import { ContextMenu } from "../workbench/ContextMenu.tsx";
import type { MenuEntry } from "../commands/menus.ts";
import type { FileMenuSettings, FileTabSize, FileTreePosition } from "./file-tabs.ts";

interface FilesMenuProps {
    readonly treeShown: boolean;
    readonly settings: FileMenuSettings;
    readonly hasTabs: boolean;
    readonly onToggleTree: () => void;
    readonly onSettingsChange: (patch: Partial<FileMenuSettings>) => void;
    readonly onCloseAll: () => void;
    readonly searchMode: FileTreeSearchMode;
    readonly onSearchMode: (mode: FileTreeSearchMode) => void;
    readonly onCollapseAll: () => void;
}

type MenuPage = "main" | "tree-position" | "tab-size";

interface OpenMenu {
    readonly x: number;
    readonly y: number;
    readonly page: MenuPage;
}

export function FilesMenu({ treeShown, settings, hasTabs, onToggleTree, onSettingsChange, onCloseAll, searchMode, onSearchMode, onCollapseAll }: FilesMenuProps) {
    const [menu, setMenu] = useState<OpenMenu | undefined>();
    const entries: MenuEntry[] = menu?.page === "tree-position" ? [
        { kind: "item", command: "left", label: "Left", checked: settings.treePosition === "left" },
        { kind: "item", command: "right", label: "Right", checked: settings.treePosition === "right" },
    ] : menu?.page === "tab-size" ? [
        ...([2, 4, 8] as const).map((size) => ({ kind: "item" as const, command: `size-${size}`, label: String(size), checked: settings.tabSize === size })),
    ] : [
        { kind: "item", command: "tree", label: treeShown ? "Hide file tree" : "Show file tree" },
        { kind: "item", command: "tree-position", label: "File tree position…" },
        { kind: "item", command: "collapse-all", label: "Collapse all folders" },
        { kind: "separator" },
        { kind: "item", command: "filter-hide", label: "Filter: hide non-matches", checked: searchMode === "hide-non-matches" },
        { kind: "item", command: "filter-expand", label: "Filter: expand matches", checked: searchMode === "expand-matches" },
        { kind: "item", command: "filter-collapse", label: "Filter: collapse non-matches", checked: searchMode === "collapse-non-matches" },
        { kind: "separator" },
        { kind: "item", command: "preview", label: "Preview tabs", checked: settings.previewTabs },
        { kind: "item", command: "wrap", label: "Word wrap", checked: settings.wordWrap },
        { kind: "item", command: "scroll-past", label: "Scroll past end", checked: settings.scrollPastEnd },
        { kind: "item", command: "tab-size", label: "Tab size…" },
        { kind: "separator" },
        { kind: "item", command: "close-all", label: "Close all tabs", disabled: !hasTabs },
    ];
    const run = (command: string) => {
        if (command === "tree") onToggleTree();
        else if (command === "collapse-all") onCollapseAll();
        else if (command === "filter-hide") onSearchMode("hide-non-matches");
        else if (command === "filter-expand") onSearchMode("expand-matches");
        else if (command === "filter-collapse") onSearchMode("collapse-non-matches");
        else if (command === "preview") onSettingsChange({ previewTabs: !settings.previewTabs });
        else if (command === "wrap") onSettingsChange({ wordWrap: !settings.wordWrap });
        else if (command === "scroll-past") onSettingsChange({ scrollPastEnd: !settings.scrollPastEnd });
        else if (command === "left" || command === "right") onSettingsChange({ treePosition: command as FileTreePosition });
        else if (command.startsWith("size-")) onSettingsChange({ tabSize: Number(command.slice(5)) as FileTabSize });
        else if (command === "close-all") onCloseAll();
        else if ((command === "tree-position" || command === "tab-size") && menu) setMenu({ ...menu, page: command });
    };
    return <>
        <button
            type="button"
            className="icon-button"
            title="Files options"
            aria-label="Files options"
            aria-haspopup="menu"
            aria-expanded={menu !== undefined}
            onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ x: rect.right, y: rect.bottom, page: "main" });
            }}
        ><MoreIcon /></button>
        {menu ? <ContextMenu key={menu.page} x={menu.x} y={menu.y} entries={entries} onRun={run} onClose={() => setMenu(undefined)} /> : null}
    </>;
}
