import { useCallback, useEffect, useRef, useState } from "react";

import { CollapseIcon, SidebarRightIcon, XIcon } from "../components/Icons.tsx";
import { shortenPath } from "../components/homePath.ts";
import { CHAT_FOLDER_LABEL } from "../protocol/sessionGroups.ts";
import { useActiveSession, type ActiveSession } from "../session/activeSession.ts";
import { subscribeFileOpen } from "../session/fileOpen.ts";
import { FilesTree, type FilesTreeModel } from "../session/FilesTree.tsx";
import type { FileTreeDirectoryHandle, FileTreeSearchMode } from "@pierre/trees";
import { Sash } from "../workbench/Sash.tsx";
import { WindowFillButton } from "../workbench/WindowFillButton.tsx";
import type { ViewProps } from "./env.tsx";
import { FilePreview } from "./FilePreview.tsx";
import { pathUnder } from "./files.ts";
import { FileTabsBar } from "./FileTabsBar.tsx";
import { ContextMenu } from "../workbench/ContextMenu.tsx";
import { runTreeAction, treeActionEntries } from "../session/tree-actions.ts";
import { FilesMenu } from "./FilesMenu.tsx";
import { clampFilesTree, filesSplitBounds } from "./files-split.ts";
import { activateFileTab, closeAllFileTabs, closeFileTab, DEFAULT_FILE_MENU_SETTINGS, emptyFileTabs, openFileTab, setFileTabMode } from "./file-tabs.ts";

export function FilesView({ visible }: ViewProps) {
    const session = useActiveSession();
    if (session === undefined) return <p className="view-empty">Open a session to see its files.</p>;
    const folder = session.folder;
    if (folder === undefined || folder === "") return <p className="view-empty">This session has no folder.</p>;
    return <FolderFiles key={`${session.agentId}:${folder}`} session={session} folder={folder} visible={visible} />;
}

interface FolderFilesProps {
    readonly session: ActiveSession;
    readonly folder: string;
    readonly visible: boolean;
}

function collapseAll(model: FilesTreeModel | undefined): void {
    if (model === undefined) return;
    for (const row of model.getVisibleRows(0, model.getVisibleCount())) {
        if (row.kind === "directory") {
            const item = model.getItem(row.path);
            if (item?.isDirectory()) (item as FileTreeDirectoryHandle).collapse();
        }
    }
}

function FolderFiles({ session, folder, visible }: FolderFilesProps) {
    const [fileTabs, setFileTabs] = useState(emptyFileTabs);
    const [settings, setSettings] = useState(DEFAULT_FILE_MENU_SETTINGS);
    const [target, setTarget] = useState<{ readonly path: string; readonly line: number; readonly request: number }>();
    const [treeShown, setTreeShown] = useState(true);
    const [treeModel, setTreeModel] = useState<FilesTreeModel | undefined>();
    const [collapseVersion, setCollapseVersion] = useState(0);
    const [searchMode, setSearchMode] = useState<FileTreeSearchMode>("hide-non-matches");
    const [treeMenu, setTreeMenu] = useState<{ readonly path: string; readonly x: number; readonly y: number }>();
    const [treeWidth, setTreeWidth] = useState<number | undefined>();
    const [size, setSize] = useState({ width: 0, space: 4 });
    const split = useRef<HTMLDivElement>(null);
    const requests = useRef(0);
    const openFile = useCallback((path: string, keep: boolean, line?: number) => {
        setFileTabs((current) => openFileTab(current, path, { preview: settings.previewTabs, keep }));
        if (line !== undefined && Number.isInteger(line) && line > 0) {
            requests.current += 1;
            setTarget({ path, line, request: requests.current });
        } else {
            setTarget(undefined);
        }
    }, [settings.previewTabs]);
    useEffect(() => {
        const element = split.current;
        if (element === null) return undefined;
        const update = (): void => {
            const space = Number.parseFloat(getComputedStyle(element).getPropertyValue("--vera-space")) || 4;
            setSize({ width: element.clientWidth, space });
        };
        const observer = new ResizeObserver(update);
        observer.observe(element);
        update();
        return () => observer.disconnect();
    }, []);
    useEffect(() => subscribeFileOpen(session.agentId, (path, line) => openFile(path, true, line)), [session.agentId, openFile]);
    const bounds = filesSplitBounds(size.width, size.space);
    const effectiveWidth = clampFilesTree(treeWidth ?? bounds.defaultWidth, bounds);
    const running = session.watch.status !== "idle";
    const opened = fileTabs.activePath ?? undefined;
    const openedTab = fileTabs.tabs.find((tab) => tab.path === opened);
    const closeTab = (path: string): void => {
        if (fileTabs.tabs.length === 1 && fileTabs.tabs[0]?.path === path) setTreeShown(true);
        if (target?.path === path) setTarget(undefined);
        setFileTabs((current) => closeFileTab(current, path));
    };
    const closeAll = (): void => {
        setFileTabs(closeAllFileTabs);
        setTarget(undefined);
        setTreeShown(true);
    };
    const collapseTree = (): void => {
        collapseAll(treeModel);
        setCollapseVersion((version) => version + 1);
    };
    return (
        <div className="files-view" data-preview={opened !== undefined}>
            <FileTabsBar
                tabs={fileTabs.tabs}
                activePath={fileTabs.activePath}
                onActivate={(path) => {
                    setTarget(undefined);
                    setFileTabs((current) => activateFileTab(current, path));
                }}
                onKeep={(path) => setFileTabs((current) => openFileTab(current, path, { keep: true }))}
                onClose={closeTab}
            />
            <div className="file-preview-bar">
                <span className="file-preview-path" title={opened}>{opened ? pathUnder(folder, opened) : "Files"}</span>
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Browse files"
                    title="Browse files"
                    aria-pressed={treeShown}
                    onClick={() => setTreeShown((shown) => !shown)}
                ><SidebarRightIcon /></button>
                <button type="button" className="icon-button" aria-label="Collapse all folders" title="Collapse all folders" onClick={collapseTree}><CollapseIcon /></button>
                <FilesMenu
                    treeShown={treeShown}
                    settings={settings}
                    hasTabs={fileTabs.tabs.length > 0}
                    onToggleTree={() => setTreeShown((shown) => !shown)}
                    onSettingsChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
                    onCloseAll={closeAll}
                    searchMode={searchMode}
                    onSearchMode={setSearchMode}
                    onCollapseAll={collapseTree}
                />
                <WindowFillButton />
                <button
                    type="button"
                    className="icon-button"
                    aria-label="Close files"
                    title="Close"
                    disabled={fileTabs.tabs.length === 0}
                    onClick={closeAll}
                ><XIcon /></button>
            </div>
            <div className="files-split" data-tree-position={settings.treePosition} ref={split}>
                <div className="files-editor">
                    {opened === undefined ? null : <FilePreview
                        key={opened}
                        bridge={session.bridge}
                        folder={folder}
                        path={opened}
                        sessionId={session.agentId}
                        visible={visible}
                        running={running}
                        mode={openedTab?.mode ?? "source"}
                        onModeChange={(mode) => setFileTabs((current) => setFileTabMode(current, opened, mode))}
                        wordWrap={settings.wordWrap}
                        scrollPastEnd={settings.scrollPastEnd}
                        tabSize={settings.tabSize}
                        targetLine={target?.path === opened ? target : undefined}
                    />}
                </div>
                {opened === undefined || !treeShown ? null : (
                    <Sash orientation="vertical" label="Files tree" value={effectiveWidth} min={bounds.min} max={bounds.max} direction={settings.treePosition === "left" ? 1 : -1}
                        onResize={(width) => setTreeWidth(clampFilesTree(width, bounds))} onReset={() => setTreeWidth(undefined)} />
                )}
                <div className="files-tree" hidden={!treeShown} style={size.width === 0 ? undefined : { flexBasis: effectiveWidth }}>
                    {session.chat ? (
                        <p className="right-path">{CHAT_FOLDER_LABEL}</p>
                    ) : (
                        <p className="right-path" title={folder}>{shortenPath(folder)}</p>
                    )}
                    <FilesTree
                        bridge={session.bridge}
                        root={folder}
                        visible={visible && treeShown}
                        running={running}
                        selected={opened}
                        onOpenFile={openFile}
                        searchMode={searchMode}
                        onModel={setTreeModel}
                        collapseVersion={collapseVersion}
                        onContextMenu={(path, x, y) => setTreeMenu({ path, x, y })}
                    />
                </div>
            </div>
            {treeMenu === undefined ? null : (
                <ContextMenu
                    x={treeMenu.x}
                    y={treeMenu.y}
                    entries={treeActionEntries(
                        treeMenu.path.startsWith("/") ? treeMenu.path : `${folder.replace(/[\\/]$/, "")}/${treeMenu.path}`,
                        treeMenu.path,
                    )}
                    onClose={() => setTreeMenu(undefined)}
                    onRun={(command) => {
                        const absolute = treeMenu.path.startsWith("/") ? treeMenu.path : `${folder.replace(/[\\/]$/, "")}/${treeMenu.path}`;
                        runTreeAction(command, absolute, pathUnder(folder, absolute), session.bridge);
                    }}
                />
            )}
        </div>
    );
}
