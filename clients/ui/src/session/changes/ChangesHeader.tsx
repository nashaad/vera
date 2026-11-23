import { useMemo, useState, type MouseEvent } from "react";

import { MAX_GIT_FILES, type GitFileList, type GitScope, type GitState } from "../../../../shared/git-wire.ts";
import { ArrowRightIcon, BranchIcon, CollapseIcon, ExpandIcon, MoreIcon, RefreshIcon, SearchIcon, SidebarRightIcon, SplitIcon, UnifiedIcon, WrapIcon } from "../../components/Icons.tsx";
import { WindowFillButton } from "../../workbench/WindowFillButton.tsx";
import { ContextMenu } from "../../workbench/ContextMenu.tsx";
import type { MenuEntry } from "../../commands/menus.ts";
import { copyText } from "../copyText.ts";
import { DestinationPicker } from "../DestinationPicker.tsx";
import type { DiffStyle, OverflowMode } from "../diff/pierreOptions.ts";
import { COLLAPSE_ALL, COPY_PATHS, EXPAND_ALL, HIDE_TREE, REFRESH, SCROLL, SEARCH, SHOW_TREE, SPLIT, UNIFIED, WRAP } from "./commands.ts";
import type { LoadStatus } from "./types.ts";

interface ChangesHeaderProps {
    readonly scope: GitScope;
    readonly onScope: (scope: GitScope) => void;
    readonly list: GitFileList | undefined;
    readonly state: GitState | undefined;
    readonly destination: string | null;
    readonly onDestination: (branch: string) => void;
    readonly status: LoadStatus;
    readonly overflow: OverflowMode;
    readonly onOverflow: (mode: OverflowMode) => void;
    readonly diffStyle: DiffStyle;
    readonly onDiffStyle: (style: DiffStyle) => void;
    readonly collapsedCount: number;
    readonly onCollapseAll: (collapsed: boolean) => void;
    readonly treeShown: boolean;
    readonly onTreeShown: (shown: boolean) => void;
    readonly onSearch: () => void;
    readonly onRefresh: () => void;
    readonly onCopyPaths: () => void;
}

// The scope control, the destination, the toolbar and its `...` menu.
export function ChangesHeader({
    scope, onScope, list, state, destination, onDestination, status,
    overflow, onOverflow, diffStyle, onDiffStyle, collapsedCount, onCollapseAll,
    treeShown, onTreeShown, onSearch, onRefresh, onCopyPaths,
}: ChangesHeaderProps) {
    const [toolbarMenu, setToolbarMenu] = useState<{ readonly x: number; readonly y: number }>();
    const formatCount = (value: number): string => value.toLocaleString();
    const addedTotal = list?.added ?? 0;
    const removedTotal = list?.removed ?? 0;
    const branchLabel = state === undefined ? "HEAD" : state.detached ? state.head ?? "HEAD" : state.branch ?? "HEAD";
    const branchScopeReady = state?.repo === true && state.hasCommits;
    const changedNoun = (list?.total ?? 0) === 1 ? "file" : "files";

    const toolbarEntries = useMemo<MenuEntry[]>(() => [
        { kind: "item", label: "Search files", command: SEARCH },
        { kind: "item", label: "Refresh", command: REFRESH },
        { kind: "separator" },
        { kind: "item", label: "Wrap long lines", command: WRAP, checked: overflow === "wrap" },
        { kind: "item", label: "Scroll long lines", command: SCROLL, checked: overflow === "scroll" },
        { kind: "item", label: "Unified view", command: UNIFIED, checked: diffStyle === "unified" },
        { kind: "item", label: "Split view", command: SPLIT, checked: diffStyle === "split" },
        { kind: "separator" },
        { kind: "item", label: "Collapse all files", command: COLLAPSE_ALL, disabled: collapsedCount === 0 },
        { kind: "item", label: "Expand all files", command: EXPAND_ALL, disabled: collapsedCount === 0 },
        { kind: "item", label: treeShown ? "Hide file tree" : "Show file tree", command: treeShown ? HIDE_TREE : SHOW_TREE },
        { kind: "separator" },
        { kind: "item", label: "Copy changed file paths", command: COPY_PATHS },
    ], [overflow, diffStyle, collapsedCount, treeShown]);

    const runToolbarCommand = (command: string): void => {
        setToolbarMenu(undefined);
        if (command === SEARCH) {
            onSearch();
        } else if (command === REFRESH) {
            onRefresh();
        } else if (command === WRAP) {
            onOverflow("wrap");
        } else if (command === SCROLL) {
            onOverflow("scroll");
        } else if (command === UNIFIED) {
            onDiffStyle("unified");
        } else if (command === SPLIT) {
            onDiffStyle("split");
        } else if (command === COLLAPSE_ALL) {
            onCollapseAll(true);
        } else if (command === EXPAND_ALL) {
            onCollapseAll(false);
        } else if (command === SHOW_TREE) {
            onTreeShown(true);
        } else if (command === HIDE_TREE) {
            onTreeShown(false);
        } else if (command === COPY_PATHS) {
            onCopyPaths();
        }
    };

    const menuAnchor = (event: MouseEvent<HTMLButtonElement>, open: (at: { x: number; y: number }) => void): void => {
        const box = event.currentTarget.getBoundingClientRect();
        open({ x: box.left, y: box.bottom });
    };

    return (
        <>
            <div className="changes-toolbar">
                <div className="changes-toolbar-start">
                    <div className="right-seg changes-scope" role="group" aria-label="Changes scope">
                        <button
                            type="button"
                            className="right-seg-option"
                            aria-pressed={scope === "branch"}
                            data-on={scope === "branch"}
                            onClick={() => onScope("branch")}
                        >
                            Branch
                            {scope === "branch" && list !== undefined ? (
                                <span className="changes-scope-counts" title={list.totalsPartial ? "Some counts are a lower bound." : undefined}>
                                    <span className="change-add">+{formatCount(addedTotal)}</span>
                                    <span className="change-del">−{formatCount(removedTotal)}</span>
                                </span>
                            ) : null}
                        </button>
                        <button
                            type="button"
                            className="right-seg-option"
                            aria-pressed={scope === "uncommitted"}
                            data-on={scope === "uncommitted"}
                            onClick={() => onScope("uncommitted")}
                        >
                            Uncommitted
                            {scope === "uncommitted" && list !== undefined ? (
                                <span className="changes-scope-counts" title={list.totalsPartial ? "Some counts are a lower bound." : undefined}>
                                    <span className="change-add">+{formatCount(addedTotal)}</span>
                                    <span className="change-del">−{formatCount(removedTotal)}</span>
                                </span>
                            ) : null}
                        </button>
                    </div>
                    {branchScopeReady && scope === "branch" ? (
                        <DestinationPicker
                            branch={branchLabel}
                            destination={destination}
                            branches={state?.branches ?? []}
                            partial={state?.branchesPartial ?? false}
                            onSelect={onDestination}
                        />
                    ) : null}
                    {state?.repo === true && state.hasCommits && scope === "uncommitted" ? (
                        <span className="changes-pill changes-destination-static">
                            <BranchIcon />
                            <span className="changes-pill-name">{branchLabel}</span>
                            <ArrowRightIcon />
                            <span className="changes-pill-name">working tree</span>
                        </span>
                    ) : null}
                </div>
                <div className="changes-toolbar-actions">
                    <button
                        type="button"
                        className="icon-button"
                        aria-label="Search files"
                        title="Search files"
                        onClick={onSearch}
                    ><SearchIcon /></button>
                    <button
                        type="button"
                        className="icon-button"
                        aria-label="Refresh changes"
                        title="Refresh"
                        onClick={onRefresh}
                    ><RefreshIcon /></button>
                    <button
                        type="button"
                        className="icon-button"
                        aria-label="Wrap long lines"
                        title={overflow === "wrap" ? "Scroll long lines" : "Wrap long lines"}
                        aria-pressed={overflow === "wrap"}
                        onClick={() => onOverflow(overflow === "wrap" ? "scroll" : "wrap")}
                    ><WrapIcon /></button>
                    <button
                        type="button"
                        className="icon-button"
                        aria-label={collapsedCount === 0 ? "Collapse all files" : "Expand all files"}
                        title={collapsedCount === 0 ? "Collapse all files" : "Expand all files"}
                        aria-pressed={collapsedCount > 0}
                        onClick={() => onCollapseAll(collapsedCount === 0)}
                    >{collapsedCount === 0 ? <CollapseIcon /> : <ExpandIcon />}</button>
                    <button
                        type="button"
                        className="icon-button"
                        aria-label={diffStyle === "split" ? "Unified view" : "Split view"}
                        title={diffStyle === "split" ? "Unified view" : "Split view"}
                        aria-pressed={diffStyle === "split"}
                        onClick={() => onDiffStyle(diffStyle === "split" ? "unified" : "split")}
                    >{diffStyle === "split" ? <UnifiedIcon /> : <SplitIcon />}</button>
                    <button
                        type="button"
                        className="icon-button"
                        aria-label={treeShown ? "Hide file tree" : "Show file tree"}
                        title={treeShown ? "Hide file tree" : "Show file tree"}
                        aria-pressed={treeShown}
                        onClick={() => onTreeShown(!treeShown)}
                    ><SidebarRightIcon /></button>
                    <WindowFillButton />
                    <button
                        type="button"
                        className="icon-button"
                        aria-label="More changes actions"
                        title="More actions"
                        aria-haspopup="menu"
                        aria-expanded={toolbarMenu !== undefined}
                        onClick={(event) => menuAnchor(event, setToolbarMenu)}
                    ><MoreIcon /></button>
                </div>
            </div>
            {status === "ready" && list !== undefined && (list.total > list.files.length || list.totalsPartial) ? (
                <p className="view-note">
                    {list.total > list.files.length ? `Showing the first ${formatCount(MAX_GIT_FILES)} of ${formatCount(list.total)} changed ${changedNoun}.` : null}
                    {list.total > list.files.length && list.totalsPartial ? " " : null}
                    {list.totalsPartial ? "Some counts are a lower bound." : null}
                </p>
            ) : null}
            {toolbarMenu === undefined ? null : (
                <ContextMenu
                    entries={toolbarEntries}
                    x={toolbarMenu.x}
                    y={toolbarMenu.y}
                    onRun={runToolbarCommand}
                    onClose={() => setToolbarMenu(undefined)}
                />
            )}
        </>
    );
}
