import { FileTree } from "@pierre/trees/react";
import { FileTree as PierreFileTree, type FileTreeDirectoryHandle, type FileTreeSearchMode } from "@pierre/trees";
import { SearchIcon } from "../components/Icons.tsx";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";

import type { GitPathEntry, GitSearchResult } from "../../../shared/git-wire.ts";
import { type DesktopBridge } from "../protocol/bridge.ts";
import { childPath, pathUnder } from "../views/files.ts";
import { useTurnsEnded } from "../views/useTurnsEnded.ts";
import { treeRowPath } from "./tree-actions.ts";
import { TREE_STYLE } from "./tree-style.ts";

export type FilesTreeModel = PierreFileTree;

interface FilesTreeProps {
    readonly bridge: DesktopBridge;
    readonly root: string;
    readonly visible: boolean;
    readonly running: boolean;
    readonly selected: string | undefined;
    readonly onOpenFile: (path: string, keep: boolean, line?: number) => void;
    readonly onContextMenu: (path: string, x: number, y: number) => void;
    readonly searchMode: FileTreeSearchMode;
    readonly onModel: (model: FilesTreeModel | undefined) => void;
    readonly collapseVersion: number;
}

interface TreeState {
    readonly entries: readonly GitPathEntry[];
    readonly results: ReadonlyMap<string, GitSearchResult>;
    readonly fallback: boolean;
    readonly gitAvailable: boolean;
    readonly notice: string;
}

function rowHeight(): number {
    const pixels = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--vera-row-height"));
    return Math.max(20, Math.round((Number.isFinite(pixels) && pixels > 0 ? pixels : 31) * 0.8));
}

function toRelative(base: string, absolute: string): string {
    return pathUnder(base, absolute).replaceAll("\\", "/").replace(/^\//, "");
}

function toAbsolute(base: string, relative: string): string {
    if (relative.startsWith("/") || /^[A-Za-z]:[\\/]/.test(relative)) return relative;
    return childPath(base, relative.replaceAll("/", base.includes("\\") ? "\\" : "/"));
}

export function FilesTree({ bridge, root, visible, running, selected, onOpenFile, onContextMenu, searchMode, onModel, collapseVersion }: FilesTreeProps) {
    const [tree, setTree] = useState<TreeState>({ entries: [], results: new Map(), fallback: false, gitAvailable: false, notice: "" });
    const [query, setQuery] = useState("");
    const [completedSearch, setCompletedSearch] = useState<string>();
    const [height, setHeight] = useState(rowHeight);
    const turnEnded = useTurnsEnded(running);
    const openFolders = useRef(new Set<string>());
    const sequence = useRef(0);
    const searchSequence = useRef(0);
    const searchPending = useRef<{ readonly query: string; readonly request: number } | undefined>(undefined);
    const searchActive = useRef(false);
    const callback = useRef(onOpenFile);
    const reportModel = useRef(onModel);
    const searchResults = useRef(tree.results);
    const contentSearch = useRef(false);
    callback.current = onOpenFile;
    reportModel.current = onModel;
    searchResults.current = tree.results;
    contentSearch.current = query.startsWith("?");

    const searchText = query.startsWith("?") ? query.slice(1) : "";
    const contentFilterReady = query.startsWith("?") && searchText.length > 0 && completedSearch === searchText;
    const entries = useMemo(
        () => contentFilterReady ? tree.entries.filter((entry) => tree.results.has(entry.path)) : tree.entries,
        [contentFilterReady, tree.entries, tree.results],
    );
    const model = useMemo(() => new PierreFileTree({
        paths: entries.map((entry) => entry.path),
        initialExpansion: "closed",
        flattenEmptyDirectories: true,
        unsafeCSS: TREE_STYLE,
        density: "compact",
        itemHeight: height,
        search: false,
        fileTreeSearchMode: searchMode,
        icons: { set: "complete", colored: false },
        labels: { searchPlaceholder: "Filter, or ? to search in files" },
        gitStatus: entries.flatMap((entry) => entry.status === null ? [] : [{ path: entry.path, status: entry.status }]),
        renderRowDecoration: ({ item }) => {
            if (item.kind !== "file") return null;
            const result = searchResults.current.get(item.path);
            if (result === undefined || !contentSearch.current) return null;
            const text = result.matches >= 1000 ? "999+" : String(result.matches);
            return { text, title: `${text} matches`, parts: [{ text, color: "var(--vera-accent)" }] };
        },
    }), [height, searchMode]);

    useEffect(() => () => model.cleanUp(), [model]);

    const readFolders = useCallback(async (folders: readonly string[], ignored: boolean) => {
        const listings = await Promise.all(folders.map(async (path) => [path, await bridge.listFolder(path)] as const));
        setTree((current) => {
            const entries = new Map(current.entries.map((entry) => [entry.path, entry]));
            for (const [parent, listing] of listings) {
                if (!listing.ok) continue;
                for (const item of listing.entries) {
                    const absolute = childPath(parent, item.name);
                    const path = toRelative(root, absolute).replace(/[\\/]$/, "") + (item.folder ? "/" : "");
                    if (path === "") continue;
                    entries.set(path, { path, ignored, status: ignored ? "ignored" : null });
                }
            }
            return { ...current, entries: [...entries.values()] };
        });
    }, [bridge, root]);

    const refresh = useCallback(async () => {
        const id = ++sequence.current;
        const reply = await bridge.gitRead({ kind: "paths", folder: root });
        if (sequence.current !== id) return;
        if (reply.kind === "paths" && reply.ok) {
            if (!reply.truncated) {
                setTree({ entries: reply.paths, results: new Map(), fallback: false, gitAvailable: true, notice: "" });
                const ignoredRoots = reply.paths.filter((entry) => entry.ignored && entry.path.endsWith("/")).map((entry) => entry.path);
                const expandedIgnored = [...openFolders.current].filter((path) => ignoredRoots.some((ignored) => path.startsWith(ignored)));
                if (expandedIgnored.length > 0) await readFolders(expandedIgnored.map((path) => toAbsolute(root, path)), true);
                return;
            }
            setTree({ entries: [], results: new Map(), fallback: true, gitAvailable: true, notice: "" });
            await readFolders([root, ...[...openFolders.current].map((path) => toAbsolute(root, path))], false);
            return;
        }
        setTree({ entries: [], results: new Map(), fallback: true, gitAvailable: false, notice: "" });
        await readFolders([root, ...[...openFolders.current].map((path) => toAbsolute(root, path))], false);
    }, [bridge, readFolders, root]);

    useEffect(() => {
        const observer = new MutationObserver(() => setHeight(rowHeight()));
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "data-density"] });
        return () => observer.disconnect();
    }, []);

    useEffect(() => {
        if (!visible) return;
        void refresh();
        return () => { sequence.current += 1; };
    }, [visible, root, turnEnded, refresh]);

    useEffect(() => {
        openFolders.current.clear();
    }, [collapseVersion]);

    useEffect(() => {
        const id = ++searchSequence.current;
        searchPending.current = undefined;
        if (!visible) return;
        if (!query.startsWith("?") || searchText === "") {
            setCompletedSearch(undefined);
            setTree((current) => current.results.size === 0 && current.notice === "" ? current : { ...current, results: new Map(), notice: "" });
            return;
        }
        if (!tree.gitAvailable) {
            setTree((current) => ({ ...current, notice: "Search in files needs a Git repository." }));
            return;
        }
        const runNext = (): void => {
            if (searchActive.current || searchPending.current === undefined) return;
            const pending = searchPending.current;
            searchPending.current = undefined;
            searchActive.current = true;
            void bridge.gitRead({ kind: "search", folder: root, query: pending.query }).then((reply) => {
                if (searchSequence.current !== pending.request) return;
                if (reply.kind === "failure" && !reply.ok) {
                    setCompletedSearch(pending.query);
                    setTree((current) => ({ ...current, results: new Map(), notice: reply.reason }));
                    return;
                }
                if (reply.kind !== "search" || !reply.ok) return;
                const results = reply.results.map((result) => [result.path, result] as const);
                const notice = reply.timedOut
                    ? "Search stopped after 10 seconds."
                    : reply.truncated
                        ? "Search results are limited."
                        : results.length === 0
                            ? "No matches. Ignored files are not searched."
                            : "";
                setTree((current) => {
                    const entries = new Map(current.entries.map((entry) => [entry.path, entry]));
                    for (const [path] of results) if (!entries.has(path)) entries.set(path, { path, ignored: false, status: null });
                    return { ...current, entries: [...entries.values()], results: new Map(results), notice };
                });
                setCompletedSearch(pending.query);
            }).catch(() => undefined).finally(() => {
                searchActive.current = false;
                runNext();
            });
        };
        const timer = window.setTimeout(() => {
            searchPending.current = { query: searchText, request: id };
            runNext();
        }, 250);
        return () => window.clearTimeout(timer);
    }, [bridge, query, root, searchText, tree.gitAvailable, turnEnded, visible]);

    useEffect(() => {
        reportModel.current(model);
        return () => reportModel.current(undefined);
    }, [model]);

    useEffect(() => {
        const expanded = new Set(openFolders.current);
        if (contentFilterReady) {
            for (const entry of entries) {
                const parts = entry.path.split("/");
                for (let index = 1; index < parts.length; index += 1) expanded.add(`${parts.slice(0, index).join("/")}/`);
            }
        }
        model.resetPaths(entries.map((entry) => entry.path), { initialExpandedPaths: [...expanded] });
        model.setGitStatus(entries.flatMap((entry) => entry.status === null ? [] : [{ path: entry.path, status: entry.status }]));
    }, [contentFilterReady, entries, model]);

    useEffect(() => {
        model.setSearch(query.startsWith("?") || query.length === 0 ? null : query);
    }, [model, query]);

    useEffect(() => {
        if (selected === undefined) return;
        const target = toRelative(root, selected);
        for (const path of model.getSelectedPaths()) if (path !== target) model.getItem(path)?.deselect();
        const item = model.getItem(target);
        if (item !== null && !item.isSelected()) item.select();
        model.scrollToPath(target, { offset: "nearest", focus: false });
    }, [model, root, selected]);

    const contextMenu = (event: MouseEvent<HTMLDivElement>): void => {
        const path = treeRowPath(event.nativeEvent);
        if (path === undefined) return;
        event.preventDefault();
        onContextMenu(path, event.clientX, event.clientY);
    };
    const click = (event: MouseEvent<HTMLDivElement>): void => {
        const path = treeRowPath(event.nativeEvent);
        if (path === undefined) return;
        if (path.endsWith("/")) {
            queueMicrotask(() => {
                const item = model.getItem(path);
                if (item?.isDirectory() && (item as FileTreeDirectoryHandle).isExpanded()) {
                    openFolders.current.add(path);
                    const ignored = tree.entries.some((entry) => entry.path === path && entry.ignored);
                    if (tree.fallback || ignored) void readFolders([toAbsolute(root, path)], ignored);
                } else openFolders.current.delete(path);
            });
            return;
        }
        callback.current(toAbsolute(root, path), false, tree.results.get(path)?.firstLine);
    };
    const doubleClick = (event: MouseEvent<HTMLDivElement>): void => {
        const path = treeRowPath(event.nativeEvent);
        if (path !== undefined && !path.endsWith("/")) callback.current(toAbsolute(root, path), true, tree.results.get(path)?.firstLine);
    };
    const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.key !== "Enter") return;
        const path = model.getSelectedPaths()[0];
        if (path === undefined || path.endsWith("/")) return;
        event.preventDefault();
        callback.current(toAbsolute(root, path), true, tree.results.get(path)?.firstLine);
    };

    return <div className="files-tree-body" onContextMenu={contextMenu} onClick={click} onDoubleClick={doubleClick} onKeyDown={keyDown}>
        <label className="files-tree-search" data-content-search={query.startsWith("?")}>
            <SearchIcon />
            <input aria-label="Filter, or ? to search in files" placeholder="Filter, or ? to search in files" value={query} onChange={(event) => setQuery(event.currentTarget.value)} />
        </label>
        {tree.fallback && !query.startsWith("?") ? <p className="files-tree-note">Filter covers opened folders.</p> : null}
        {tree.notice ? <p className="files-tree-note">{tree.notice}</p> : null}
        <FileTree model={model} className="vera-file-tree" />
    </div>;
}
