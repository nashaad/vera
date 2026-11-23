import { useEffect, useMemo, useRef, useState } from "react";
import { CodeView, type CodeViewHandle } from "@pierre/diffs/react";
import type { CodeViewItem, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import type { FileTreeSearchMode } from "@pierre/trees";

import { ArrowLeftIcon, ArrowRightIcon } from "../components/Icons.tsx";
import { ContextMenu } from "../workbench/ContextMenu.tsx";
import type { MenuEntry } from "../commands/menus.ts";
import { copyText } from "../session/copyText.ts";
import { useActiveSession, type ActiveSession } from "../session/activeSession.ts";
import { diffOptions, type DiffStyle, type OverflowMode } from "../session/diff/pierreOptions.ts";
import { useDiffsFit } from "../session/diff/useDiffsFit.ts";
import { resolveKeyedRange } from "../session/diff/commentRange.ts";
import { ChangesTree, type ChangesTreeModel } from "../session/ChangesTree.tsx";
import { firstNewSideLine, openFileInFiles } from "../session/fileOpen.ts";
import { runTreeAction, treeActionEntries } from "../session/tree-actions.ts";
import { ChangesFileHeader, ChangesFooter } from "../session/changes/ChangesFiles.tsx";
import { ChangesHeader } from "../session/changes/ChangesHeader.tsx";
import { useChangesComments } from "../session/changes/useChangesComments.tsx";
import { useChangesData } from "../session/changes/useChangesData.ts";
import { COPY_PATH, FILTER_COLLAPSE, FILTER_EXPAND, FILTER_HIDE, OPEN_DEFAULT, OPEN_FILES, TOGGLE_FILE } from "../session/changes/commands.ts";
import type { ChangesAnnotation } from "../session/changes/types.ts";
import { childPath } from "./files.ts";
import { clampFilesTree, filesSplitBounds } from "./files-split.ts";
import { Sash } from "../workbench/Sash.tsx";
import { useWorkbench } from "../workbench/context.tsx";
import type { ViewProps } from "./env.tsx";

// The tree takes this width only when the diff keeps its minimum.
const TREE_DEFAULT_WIDTH = 230;
const TREE_DIFF_MIN_WIDTH = 320;
// The tree never narrows past this in a split with room for it.
const TREE_MIN_WIDTH = 160;

export function ChangesView({ visible }: ViewProps) {
    const session = useActiveSession();
    if (session === undefined) return <p className="view-empty">Open a session to see its changes.</p>;
    if (session.chat) return <p className="view-empty">This chat has no folder to compare.</p>;
    const folder = session.folder;
    if (folder === undefined || folder === "") return <p className="view-empty">This session has no folder.</p>;
    return <ChangesBody key={`${session.agentId}:${folder}`} session={session} folder={folder} visible={visible} />;
}

interface ChangesBodyProps {
    readonly session: ActiveSession;
    readonly folder: string;
    readonly visible: boolean;
}

function ChangesBody({ session, folder, visible }: ChangesBodyProps) {
    const workbench = useWorkbench();
    const {
        scope, setScope, destination, setDestination, query, state, list, status, reason, emptyText,
        selectedPath, setSelectedPath, setRefresh, patchVersion, patchError, cache,
        ensurePatches, showMorePatches, remaining, filesByPath, loadDiffFiles, oneFileMode, currentIndex, currentFile,
    } = useChangesData({ session, folder, visible });
    const {
        pending, setPending, direction, setDirection, filePath, annotations, renderAnnotation, openLineEditor, openFileEditor,
    } = useChangesComments({ session, list, scope, filesByPath, cache, patchVersion });

    const [treeShown, setTreeShown] = useState(true);
    const [treeModel, setTreeModel] = useState<ChangesTreeModel | undefined>();
    const [treeWidth, setTreeWidth] = useState<number | undefined>();
    const [splitSize, setSplitSize] = useState({ width: 0, space: 4 });
    const [searchRequest, setSearchRequest] = useState(0);
    const [searchMode, setSearchMode] = useState<FileTreeSearchMode>("hide-non-matches");
    const [overflow, setOverflow] = useState<OverflowMode>("wrap");
    const [diffStyle, setDiffStyle] = useState<DiffStyle>("unified");
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
    const [scrollRequest, setScrollRequest] = useState(0);
    const [treeMenu, setTreeMenu] = useState<{ readonly path: string; readonly x: number; readonly y: number }>();

    const split = useRef<HTMLDivElement>(null);
    const view = useRef<CodeViewHandle<ChangesAnnotation, undefined> | null>(null);
    const scrollTimer = useRef<number | undefined>(undefined);
    // A path the person picked, scrolled to once its patch exists. The scroll
    // spy only changes the mark; it never asks for a scroll.
    const scrollTarget = useRef<string | null>(null);
    // The picked path holds the mark while it stays in view, even when an
    // earlier file can no longer leave the top of the viewport.
    const pinned = useRef<string | null>(null);
    const versions = useRef(new Map<string, { signature: string; diff: FileDiffMetadata; version: number; collapsed: boolean }>());

    useEffect(() => {
        const element = split.current;
        if (element === null) return undefined;
        const update = (): void => {
            const space = Number.parseFloat(getComputedStyle(element).getPropertyValue("--vera-space")) || 4;
            setSplitSize({ width: element.clientWidth, space });
        };
        const observer = new ResizeObserver(update);
        observer.observe(element);
        update();
        return () => observer.disconnect();
    }, [status]);

    useEffect(() => () => {
        window.clearTimeout(scrollTimer.current);
    }, []);

    const bounds = filesSplitBounds(splitSize.width, splitSize.space);
    const treeBounds = {
        ...bounds,
        min: Math.min(bounds.max, Math.max(bounds.min, TREE_MIN_WIDTH)),
    };
    const defaultTreeWidth = splitSize.width - TREE_DEFAULT_WIDTH >= TREE_DIFF_MIN_WIDTH
        ? TREE_DEFAULT_WIDTH
        : bounds.defaultWidth;
    const effectiveTreeWidth = clampFilesTree(treeWidth ?? defaultTreeWidth, treeBounds);

    useEffect(() => {
        const target = scrollTarget.current;
        if (target === null || oneFileMode || !cache.current.has(target)) return;
        if (view.current === null) return;
        view.current.scrollTo({ type: "item", id: target, align: "start", behavior: "instant" });
        scrollTarget.current = null;
    }, [scrollRequest, patchVersion, oneFileMode]);

    useEffect(() => {
        scrollTarget.current = null;
        pinned.current = null;
    }, [list]);

    useEffect(() => {
        if (!oneFileMode) return;
        window.clearTimeout(scrollTimer.current);
    }, [oneFileMode, selectedPath]);

    const pickFile = (path: string): void => {
        scrollTarget.current = path;
        pinned.current = path;
        setSelectedPath(path);
        setScrollRequest((value) => value + 1);
    };

    useEffect(() => {
        if (searchRequest === 0 || treeModel === undefined) return;
        treeModel.openSearch();
    }, [searchRequest, treeModel]);

    const visibleFiles = oneFileMode
        ? currentFile === undefined ? [] : [currentFile]
        : list?.files ?? [];

    const items = useMemo<CodeViewItem<ChangesAnnotation>[]>(() => visibleFiles.flatMap((file) => {
        const patch = cache.current.get(file.path);
        if (patch === undefined) return [];
        const rows = annotations.get(file.path) ?? [];
        const isCollapsed = collapsed.has(file.path);
        const signature = JSON.stringify(rows);
        const previous = versions.current.get(file.path);
        let version = previous?.version ?? 0;
        if (previous !== undefined && (previous.signature !== signature || previous.diff !== patch.diff || previous.collapsed !== isCollapsed)) version += 1;
        versions.current.set(file.path, { signature, diff: patch.diff, version, collapsed: isCollapsed });
        return [{
            id: file.path,
            type: "diff" as const,
            fileDiff: patch.diff,
            annotations: rows,
            collapsed: isCollapsed,
            version,
        }];
    }), [visibleFiles, annotations, collapsed, patchVersion]);

    const diffsFit = useDiffsFit(view, items);

    const openFile = (path: string, line?: number): void => {
        openFileInFiles(workbench, session.agentId, childPath(folder, path), line);
    };

    const toggleCollapsed = (path: string): void => {
        setCollapsed((current) => {
            const next = new Set(current);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    };

    const treeEntries = useMemo<MenuEntry[]>(() => {
        const file = treeMenu === undefined ? undefined : filesByPath.get(treeMenu.path);
        const isCollapsed = treeMenu !== undefined && collapsed.has(treeMenu.path);
        return [
            ...treeActionEntries(treeMenu === undefined ? "" : childPath(folder, treeMenu.path), treeMenu?.path ?? "").map((entry) => entry.kind === "item" ? { ...entry, disabled: file === undefined } : entry),
            { kind: "item", label: "Open in Files", command: OPEN_FILES, disabled: file === undefined || file.status === "deleted" },
            { kind: "separator" },
            { kind: "item", label: isCollapsed ? "Expand file" : "Collapse file", command: TOGGLE_FILE, disabled: file === undefined },
            { kind: "separator" },
            { kind: "item", label: "Filter: hide non-matches", command: FILTER_HIDE, checked: searchMode === "hide-non-matches" },
            { kind: "item", label: "Filter: expand matches", command: FILTER_EXPAND, checked: searchMode === "expand-matches" },
            { kind: "item", label: "Filter: collapse non-matches", command: FILTER_COLLAPSE, checked: searchMode === "collapse-non-matches" },
        ];
    }, [treeMenu, filesByPath, collapsed, searchMode]);

    const runTreeCommand = (command: string, path: string): void => {
        setTreeMenu(undefined);
        if (runTreeAction(command, childPath(folder, path), path, session.bridge)) {
            return;
        } else if (command === COPY_PATH) {
            void copyText(path);
        } else if (command === OPEN_DEFAULT) {
            void session.bridge.revealFolder(childPath(folder, path));
        } else if (command === OPEN_FILES) {
            openFile(path);
        } else if (command === TOGGLE_FILE) {
            toggleCollapsed(path);
        } else if (command === FILTER_HIDE) {
            setSearchMode("hide-non-matches");
        } else if (command === FILTER_EXPAND) {
            setSearchMode("expand-matches");
        } else if (command === FILTER_COLLAPSE) {
            setSearchMode("collapse-non-matches");
        }
    };

    const message = status === "loading" ? "Reading changes..." : emptyText ?? reason ?? "";

    return (
        <div className="changes-view">
            <ChangesHeader
                scope={scope}
                onScope={setScope}
                list={list}
                state={state}
                destination={query.destination}
                onDestination={setDestination}
                status={status}
                overflow={overflow}
                onOverflow={setOverflow}
                diffStyle={diffStyle}
                onDiffStyle={setDiffStyle}
                collapsedCount={collapsed.size}
                onCollapseAll={(allCollapsed) => setCollapsed(allCollapsed
                    ? new Set((list?.files ?? []).map((file) => file.path))
                    : new Set())}
                treeShown={treeShown}
                onTreeShown={setTreeShown}
                onSearch={() => {
                    setTreeShown(true);
                    setSearchRequest((value) => value + 1);
                }}
                onRefresh={() => setRefresh((value) => value + 1)}
                onCopyPaths={() => {
                    void copyText((list?.files ?? []).map((file) => file.path).join("\n"));
                }}
            />
            {patchError !== undefined ? <p className="view-note">{patchError}</p> : null}
            {status === "ready" && list !== undefined ? (
                <div className="changes-split" ref={split}>
                    <div className="changes-main">
                        {oneFileMode && list.total > 1 ? (
                            <div className="changes-one-file">
                                <span className="changes-one-file-note">This diff is large, showing one file at a time</span>
                                <span className="changes-one-file-count">{currentIndex + 1} of {list.files.length}</span>
                                <button
                                    type="button"
                                    className="icon-button"
                                    aria-label="Previous file"
                                    title="Previous file"
                                    disabled={currentIndex <= 0}
                                    onClick={() => {
                                        const file = list.files[Math.max(0, currentIndex - 1)];
                                        if (file !== undefined) pickFile(file.path);
                                    }}
                                ><ArrowLeftIcon /></button>
                                <button
                                    type="button"
                                    className="icon-button"
                                    aria-label="Next file"
                                    title="Next file"
                                    disabled={currentIndex >= list.files.length - 1}
                                    onClick={() => {
                                        const file = list.files[Math.min(list.files.length - 1, currentIndex + 1)];
                                        if (file !== undefined) pickFile(file.path);
                                    }}
                                ><ArrowRightIcon /></button>
                            </div>
                        ) : null}
                        <CodeView<ChangesAnnotation, undefined>
                            key={`${scope}:${list.base}:${oneFileMode ? selectedPath ?? "" : "all"}`}
                            ref={view}
                            className={`review-diffs changes-diffs${diffsFit ? " changes-diffs-fits" : ""}`}
                            items={items}
                            selectedLines={direction}
                            onSelectedLinesChange={(selection) => {
                                setDirection(selection);
                                if (selection !== null && pending !== undefined) {
                                    const file = filesByPath.get(selection.id);
                                    const patch = file === undefined ? undefined : cache.current.get(file.path);
                                    if (file !== undefined && patch?.source.diff !== undefined) {
                                        const resolved = resolveKeyedRange([patch.source], selection.range);
                                        if (resolved !== undefined) {
                                            setPending({ patchKey: resolved.patchKey, range: resolved.range, path: file.path, source: resolved.diff });
                                        }
                                    }
                                }
                            }}
                            options={{
                                ...diffOptions(diffStyle, overflow, "line-info"),
                                disableFileHeader: false,
                                stickyHeaders: true,
                                enableLineSelection: true,
                                enableGutterUtility: true,
                                onGutterUtilityClick: (range: SelectedLineRange, context) => {
                                    openLineEditor(context.item.id, range);
                                },
                                loadDiffFiles,
                                // Leaves room to bring the last file's header into view
                                // when it is picked from the tree.
                                layout: { paddingTop: 8, paddingBottom: 96, gap: 8 },
                            }}
                            onScroll={(scrollTop, viewer) => {
                                if (oneFileMode) return;
                                window.clearTimeout(scrollTimer.current);
                                scrollTimer.current = window.setTimeout(() => {
                                    const held = pinned.current;
                                    if (held !== null) {
                                        const index = visibleFiles.findIndex((file) => file.path === held);
                                        const top = viewer.getTopForItem(held);
                                        const next = index < 0 ? undefined : visibleFiles[index + 1]?.path;
                                        const nextTop = next === undefined ? undefined : viewer.getTopForItem(next);
                                        const height = viewer.getContainerElement()?.clientHeight ?? 0;
                                        if (index >= 0 && top !== undefined && top < scrollTop + height
                                            && (nextTop === undefined || nextTop > scrollTop + 4)) return;
                                        pinned.current = null;
                                    }
                                    let at = visibleFiles[0]?.path;
                                    for (const file of visibleFiles) {
                                        const top = viewer.getTopForItem(file.path);
                                        if (top === undefined) continue;
                                        if (top > scrollTop + 4) break;
                                        at = file.path;
                                    }
                                    if (at !== undefined) setSelectedPath((current) => current === at ? current : at);
                                }, 120);
                            }}
                            renderCustomHeader={(item) => {
                                const file = filesByPath.get(item.id);
                                if (file === undefined) return null;
                                return (
                                    <ChangesFileHeader
                                        file={file}
                                        patch={cache.current.get(file.path)}
                                        collapsed={collapsed.has(file.path)}
                                        commentOpen={filePath === file.path}
                                        onToggle={() => toggleCollapsed(file.path)}
                                        onOpen={() => openFile(file.path, firstNewSideLine(cache.current.get(file.path)?.diff.hunks ?? []))}
                                        onComment={() => openFileEditor(file.path)}
                                        onOpenDefault={() => { void session.bridge.revealFolder(childPath(folder, file.path)); }}
                                        onOpenFiles={() => openFile(file.path, firstNewSideLine(cache.current.get(file.path)?.diff.hunks ?? []))}
                                    />
                                );
                            }}
                            renderAnnotation={renderAnnotation}
                            renderCodeViewFooter={() => oneFileMode ? null : <ChangesFooter remaining={remaining} onVisible={showMorePatches} />}
                        />
                    </div>
                    {treeShown ? (
                        <>
                            <Sash
                                orientation="vertical"
                                label="Changed files tree"
                                value={effectiveTreeWidth}
                                min={treeBounds.min}
                                max={treeBounds.max}
                                direction={-1}
                                onResize={(width) => setTreeWidth(clampFilesTree(width, treeBounds))}
                                onReset={() => setTreeWidth(undefined)}
                            />
                            <div className="changes-tree" style={{ flexBasis: effectiveTreeWidth }}>
                                <ChangesTree
                                    key={searchMode}
                                    files={list.files}
                                    selected={selectedPath}
                                    searchMode={searchMode}
                                    onSelect={(path) => {
                                        pickFile(path);
                                        const file = filesByPath.get(path);
                                        if (file !== undefined) void ensurePatches([file], true);
                                    }}
                                    onModel={setTreeModel}
                                    onContextMenu={(path, x, y) => setTreeMenu({ path, x, y })}
                                />
                            </div>
                        </>
                    ) : null}
                </div>
            ) : (
                <p className={status === "error" ? "view-empty view-error" : "view-empty"}>{message}</p>
            )}
            {treeMenu === undefined ? null : (
                <ContextMenu
                    entries={treeEntries}
                    x={treeMenu.x}
                    y={treeMenu.y}
                    onRun={(command) => runTreeCommand(command, treeMenu.path)}
                    onClose={() => setTreeMenu(undefined)}
                />
            )}
        </div>
    );
}
