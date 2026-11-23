import { FileTree, useFileTree } from "@pierre/trees/react";
import type { FileTreeSearchMode } from "@pierre/trees";
import { useEffect, useRef, useState, type MouseEvent } from "react";

import type { GitChangedFile } from "../../../shared/git-wire.ts";
import { FolderIcon } from "../components/Icons.tsx";
import { CHANGED_FILES_ROOT, treeStatus } from "./gitChanges.ts";
import { treeRowPath } from "./tree-actions.ts";
import { TREE_STYLE } from "./tree-style.ts";

export type ChangesTreeModel = ReturnType<typeof useFileTree>["model"];

interface ChangesTreeProps {
    readonly files: readonly GitChangedFile[];
    readonly selected: string | null;
    readonly searchMode: FileTreeSearchMode;
    readonly onSelect: (path: string) => void;
    readonly onModel: (model: ChangesTreeModel | undefined) => void;
    readonly onContextMenu: (path: string, x: number, y: number) => void;
}

// Every folder above a file, so a reset opens the whole changed-file tree.
function expandedFolders(paths: readonly string[]): string[] {
    const folders = new Set<string>();
    for (const path of paths) {
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index += 1) folders.add(parts.slice(0, index).join("/"));
    }
    return [...folders];
}

// Compact tree rows sit a little below Vera's own row height, as Files lists do.
function useTreeRowHeight(): number {
    const read = (): number => {
        const raw = getComputedStyle(document.documentElement).getPropertyValue("--vera-row-height");
        const pixels = Number.parseFloat(raw);
        return Math.max(20, Math.round((Number.isFinite(pixels) && pixels > 0 ? pixels : 31) * 0.8));
    };
    const [height, setHeight] = useState(read);
    useEffect(() => {
        const observer = new MutationObserver(() => setHeight(read()));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-density"] });
        return () => observer.disconnect();
    }, []);
    return height;
}

// The root is the tree's own header row, so folder flattening never merges it
// with a real folder. Rows carry type, status, and counts only when whole.

export function ChangesTree({ files, selected, searchMode, onSelect, onModel, onContextMenu }: ChangesTreeProps) {
    const filesRef = useRef(files);
    filesRef.current = files;
    const onModelRef = useRef(onModel);
    onModelRef.current = onModel;
    const onSelectRef = useRef(onSelect);
    onSelectRef.current = onSelect;
    const onContextMenuRef = useRef(onContextMenu);
    onContextMenuRef.current = onContextMenu;
    const bodyRef = useRef<HTMLDivElement>(null);
    const hiddenCounts = useRef(new Set<string>());
    const countsWidths = useRef(new Map<string, number>());
    const rowHeight = useTreeRowHeight();
    const { model } = useFileTree({
        paths: files.map((file) => file.path),
        initialExpansion: "open",
        flattenEmptyDirectories: true,
        unsafeCSS: TREE_STYLE,
        density: "compact",
        itemHeight: rowHeight,
        search: true,
        fileTreeSearchMode: searchMode,
        icons: { set: "complete", colored: false },
        labels: { searchPlaceholder: "Filter files..." },
        gitStatus: files.map((file) => ({ path: file.path, status: treeStatus(file) })),
        renderRowDecoration: ({ item }) => {
            if (item.kind !== "file") return null;
            const path = item.path;
            const file = filesRef.current.find((entry) => entry.path === path);
            if (file === undefined || hiddenCounts.current.has(path)) return null;
            if (file.binary) {
                return {
                    text: "Binary",
                    parts: [{ text: "Binary", color: "var(--vera-text-dim)" }],
                    title: "Binary file, not shown.",
                };
            }
            const counts: { readonly text: string; readonly color?: string }[] = [];
            if (file.added !== null && file.added > 0) counts.push({ text: `+${file.added}`, color: "var(--vera-diff-added)" });
            if (file.removed !== null && file.removed > 0) counts.push({ text: `−${file.removed}`, color: "var(--vera-diff-removed)" });
            if (counts.length === 0) return null;
            // A plain space collapses to zero width as a flex item, so the gap uses a no-break space.
            const parts = counts.length === 1 ? counts : [counts[0]!, { text: "\u00a0" }, counts[1]!];
            const text = counts.map((part) => part.text).join(" ");
            return { text, parts, title: text };
        },
        onSelectionChange: (paths) => {
            const path = paths[0];
            if (path !== undefined) onSelectRef.current(path);
        },
    });

    useEffect(() => {
        onModelRef.current(model);
        return () => onModelRef.current(undefined);
    }, [model]);

    // The decoration lane is a flex remainder, so counts too wide for it are cut
    // mid-text. Measure the drawn text and show the counts only where the whole
    // text fits; a wider tree retries the rows whose counts are hidden.
    useEffect(() => {
        const body = bodyRef.current;
        const host = body?.querySelector<HTMLElement>(".vera-file-tree");
        const shadow = host?.shadowRoot;
        if (body == null || host == null || shadow == null) return undefined;
        const treeHost = host;
        const treeShadow = shadow;
        const rawSpace = getComputedStyle(treeHost).getPropertyValue("--vera-space");
        const space = Number.parseFloat(rawSpace) > 0 ? Number.parseFloat(rawSpace) : 4;
        let frame: number | undefined;
        let retry: number | undefined;
        let passes = 0;
        // Flex children may shrink their boxes while the text overflows them, so a
        // plain scrollWidth can equal clientWidth; the range gives the drawn width.
        function drawnWidth(element: HTMLElement): number {
            const range = document.createRange();
            range.selectNodeContents(element);
            return Math.max(element.scrollWidth, range.getBoundingClientRect().width);
        }
        function measure(): void {
            frame = undefined;
            let changed = false;
            for (const row of treeShadow.querySelectorAll<HTMLElement>('[data-type="item"]')) {
                const path = row.dataset["itemPath"];
                if (path === undefined) continue;
                const decoration = row.querySelector<HTMLElement>('[data-item-section="decoration"]');
                if (decoration === null) continue;
                const text = decoration.firstElementChild;
                const hidden = hiddenCounts.current.has(path);
                if (text instanceof HTMLElement) {
                    const width = drawnWidth(text);
                    if (width > 0) countsWidths.current.set(path, width);
                    // Keep one spacing token between the name and the counts.
                    if (width + space > decoration.clientWidth + 1 && !hidden) {
                        hiddenCounts.current.add(path);
                        changed = true;
                    }
                } else if (hidden) {
                    const width = countsWidths.current.get(path);
                    if (width !== undefined && decoration.clientWidth >= width + space) {
                        hiddenCounts.current.delete(path);
                        changed = true;
                    }
                }
            }
            if (!changed) {
                passes = 0;
                return;
            }
            if (passes >= 2) return;
            passes += 1;
            model.setIcons({ set: "complete", colored: false });
            schedule();
            // A tree built during a scope switch can measure a lane before layout.
            window.clearTimeout(retry);
            retry = window.setTimeout(() => {
                passes = 0;
                schedule();
            }, 120);
        }
        function schedule(): void {
            if (frame !== undefined) return;
            frame = window.requestAnimationFrame(measure);
        }
        const observer = new MutationObserver(schedule);
        observer.observe(treeShadow, { childList: true, subtree: true, characterData: true });
        const resize = new ResizeObserver(schedule);
        resize.observe(treeHost);
        schedule();
        return () => {
            observer.disconnect();
            resize.disconnect();
            window.clearTimeout(retry);
            if (frame !== undefined) cancelAnimationFrame(frame);
        };
    }, [model, searchMode]);

    useEffect(() => {
        hiddenCounts.current.clear();
        countsWidths.current.clear();
        const paths = files.map((file) => file.path);
        model.resetPaths(paths, { initialExpandedPaths: expandedFolders(paths) });
        model.setGitStatus(files.map((file) => ({ path: file.path, status: treeStatus(file) })));
    }, [model, files]);

    useEffect(() => {
        if (selected === null) return;
        const target = selected;
        // select() adds to the selection; clear the last file first so one row stays picked.
        for (const path of model.getSelectedPaths()) {
            if (path !== target) model.getItem(path)?.deselect();
        }
        const handle = model.getItem(target);
        if (handle !== null && !handle.isSelected()) handle.select();
        model.scrollToPath(target, { offset: "nearest" });
    }, [model, selected]);

    const contextMenu = (event: MouseEvent<HTMLDivElement>): void => {
        const path = treeRowPath(event.nativeEvent);
        if (path === undefined) return;
        event.preventDefault();
        onContextMenuRef.current(path, event.clientX, event.clientY);
    };

    return (
        <div className="changes-tree-body" ref={bodyRef} aria-label="Changed files" onContextMenu={contextMenu}>
            <FileTree
                model={model}
                className="vera-file-tree"
                header={(
                    <div className="changes-tree-root" aria-hidden="true">
                        <FolderIcon className="changes-tree-root-icon" />
                        <span className="changes-tree-root-name">{CHANGED_FILES_ROOT}</span>
                    </div>
                )}
            />
        </div>
    );
}
