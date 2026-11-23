import { useEffect, useMemo, useRef, useState } from "react";

import { ChevronDownIcon, FolderIcon, MoreIcon, RefreshIcon, SearchIcon, CheckIcon, PlusIcon } from "../components/Icons.tsx";
import { usePopoverPlacement } from "../components/usePopoverPlacement.ts";
import {
    folderChoices,
    KIND_LABELS,
    latchedFolder,
    type CustomizeKind,
} from "../customize/catalog.ts";
import { KindIcon } from "../plugins/KindIcon.tsx";
import { DiscoverThemes } from "../customize/DiscoverThemes.tsx";
import { useDesktopExtensions, type DesktopExtensionsState } from "../customize/useDesktopExtensions.ts";
import { useFolderCustomizations } from "../customize/useFolderCustomizations.ts";
import type { DesktopBridge, ExtensionFailure } from "../protocol/bridge.ts";
import { folderName } from "../protocol/sessionGroups.ts";
import { useActiveSession } from "../session/activeSession.ts";
import { useViewEnvironment } from "../views/env.tsx";
import { useRouter } from "./router.tsx";
import { EmptyState, Page } from "./Page.tsx";
import { requestNewChatPrefill } from "../composer/newChatPrefill.ts";
import {
    pluginKindCounts,
    pluginName,
    pluginNoMatch,
    pluginOff,
    pluginRowMeta,
    pluginSectionEmpty,
    pluginSections,
    pluginItems,
    seeMoreLabel,
    type PluginItem,
    type PluginScope,
    type PluginSection,
} from "../plugins/items.ts";
import { PluginMenu } from "../plugins/PluginMenu.tsx";
import { PluginSheet } from "../plugins/PluginSheet.tsx";

type FailureState =
    | { readonly phase: "loading" }
    | { readonly phase: "ok"; readonly failures: readonly ExtensionFailure[] }
    | { readonly phase: "failed"; readonly reason: string };

type PluginsMode = "yours" | "discover";

const KIND_TABS: readonly CustomizeKind[] = ["skills", "agents", "extensions", "instructions", "memory"];
const FIRST_ROWS = 6;

function desktopBridge(): DesktopBridge | undefined {
    return typeof window === "undefined" ? undefined : window.veraDesktop;
}

function useExtensionFailures(bridge: DesktopBridge | undefined, reload: number): FailureState {
    const [state, setState] = useState<FailureState>({ phase: "loading" });
    useEffect(() => {
        if (bridge === undefined) {
            setState({ phase: "failed", reason: "This window has no host bridge." });
            return undefined;
        }
        let live = true;
        setState({ phase: "loading" });
        bridge.readExtensionFailures().then(
            (result) => {
                if (!live) return;
                setState(result.ok ? { phase: "ok", failures: result.failures } : { phase: "failed", reason: result.reason });
            },
            () => {
                if (live) setState({ phase: "failed", reason: "The extension list did not load." });
            },
        );
        return () => {
            live = false;
        };
    }, [bridge, reload]);
    return state;
}

interface FolderMenuProps {
    readonly folder: string | undefined;
    readonly folders: readonly string[];
    readonly onPick: (folder: string) => void;
}

function FolderMenu({ folder, folders, onPick }: FolderMenuProps) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const placed = usePopoverPlacement(open, root);

    useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event: MouseEvent): void => {
            if (root.current !== null && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onPointer);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onPointer);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);

    const choices = folder !== undefined && !folders.includes(folder) ? [folder, ...folders] : folders;
    return (
        <div className="customize-folder" ref={root}>
            <button
                type="button"
                className="ghost-btn"
                aria-haspopup="menu"
                aria-expanded={open}
                title={folder}
                disabled={choices.length === 0}
                onClick={() => setOpen(!open)}
            >
                <FolderIcon />
                {folder === undefined ? "No folder" : folderName(folder)}
                <ChevronDownIcon />
            </button>
            {open ? (
                <div className="folder-menu" role="menu" data-popover="below-start" style={placed}>
                    {choices.map((choice) => (
                        <button
                            key={choice}
                            type="button"
                            role="menuitem"
                            className="folder-item"
                            title={choice}
                            onClick={() => {
                                setOpen(false);
                                onPick(choice);
                            }}
                        >
                            <span className="folder-item-name">{folderName(choice)}</span>
                            <span className="folder-item-path">{choice}</span>
                        </button>
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function AddMenu({ extensions }: { readonly extensions: DesktopExtensionsState }) {
    const [open, setOpen] = useState(false);
    const root = useRef<HTMLDivElement>(null);
    const placed = usePopoverPlacement(open, root);
    useEffect(() => {
        if (!open) return undefined;
        const onPointer = (event: MouseEvent): void => {
            if (root.current !== null && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false);
        };
        const onKey = (event: KeyboardEvent): void => {
            if (event.key === "Escape") setOpen(false);
        };
        document.addEventListener("mousedown", onPointer);
        document.addEventListener("keydown", onKey);
        return () => {
            document.removeEventListener("mousedown", onPointer);
            document.removeEventListener("keydown", onKey);
        };
    }, [open]);
    return (
        <div className="plugins-add" ref={root}>
            <button
                type="button"
                className="solid-btn"
                aria-haspopup="menu"
                aria-expanded={open}
                disabled={extensions.busy}
                onClick={() => setOpen(!open)}
            >
                <PlusIcon />
                Add
                <ChevronDownIcon />
            </button>
            {open ? (
                <div className="folder-menu" role="menu" data-popover="below-end" style={placed}>
                    <button
                        type="button"
                        role="menuitem"
                        className="folder-item"
                        data-desktop-extension-install
                        onClick={() => {
                            setOpen(false);
                            extensions.choose();
                        }}
                    >
                        <span className="folder-item-name">Install from file</span>
                        <span className="folder-item-path">An unpacked extension package</span>
                    </button>
                </div>
            ) : null}
        </div>
    );
}

function ExtensionPreview({ extensions }: { readonly extensions: DesktopExtensionsState }) {
    const preview = extensions.preview;
    if (preview === undefined) return null;
    return (
        <div className="plugin-extension-preview" data-desktop-extension-preview={preview.token}>
            <div>
                <strong>{preview.id}</strong> {preview.version}
            </div>
            <p className="plugin-empty">
                {preview.themes.length === 0 ? "No themes" : `Themes: ${preview.themes.join(", ")}`}
            </p>
            {preview.replaces === undefined ? null : <p className="plugin-empty">Replaces version {preview.replaces}.</p>}
            {preview.hasUnavailableContributions ? (
                <p className="plugin-empty">Some task, page, or menu contributions are not loaded by this version of Vera.</p>
            ) : null}
            <div className="plugin-extension-actions">
                <button type="button" className="ghost-btn" data-desktop-extension-cancel onClick={extensions.cancel}>Cancel</button>
                <button type="button" className="solid-btn" data-desktop-extension-confirm disabled={extensions.busy} onClick={extensions.confirm}>Install</button>
            </div>
        </div>
    );
}

function PluginRow({ item, folder, home, onOpen, onMenu }: {
    readonly item: PluginItem;
    readonly folder: string | undefined;
    readonly home: string | undefined;
    readonly onOpen: () => void;
    readonly onMenu: (point: { readonly x: number; readonly y: number }) => void;
}) {
    const meta = pluginRowMeta(item, folder, home);
    const off = pluginOff(item);
    return (
        <li
            className="plugin-row"
            data-kind={item.kind}
            data-name={item.name}
            data-failed={item.failed}
            data-off={off}
            data-scope={item.scope}
            {...(item.extension === undefined ? {} : {
                "data-desktop-extension": item.extension.id,
                "data-enabled": item.extension.enabled,
            })}
        >
            <button type="button" className="plugin-row-main" onClick={onOpen}>
                <span className="plugin-tile" data-kind={item.kind} data-off={off}>
                    <KindIcon kind={item.kind} />
                </span>
                <span className="plugin-row-body">
                    <span className="plugin-row-name">{pluginName(item)}</span>
                    <span className="plugin-row-desc">{item.description.length === 0 ? "No description." : item.description}</span>
                    <span className="plugin-row-meta">
                        {meta.extension === undefined ? null : <span>{meta.extension}</span>}
                        {meta.extension !== undefined && meta.detail !== undefined ? <span className="plugin-dot">·</span> : null}
                        {meta.detail === undefined ? null : <code>{meta.detail}</code>}
                    </span>
                </span>
                <span className="plugin-row-end">
                    {off ? <span className="plugin-off">Off</span> : item.failed ? null : <CheckIcon className="plugin-check" />}
                </span>
            </button>
            <button
                type="button"
                className="plugin-row-more"
                aria-label={`More for ${item.name}`}
                aria-haspopup="menu"
                onClick={(event) => {
                    const box = event.currentTarget.getBoundingClientRect();
                    onMenu({ x: box.right - 8, y: box.bottom + 4 });
                }}
            >
                <MoreIcon />
            </button>
        </li>
    );
}

const SECTION_TITLES: Readonly<Record<PluginScope, string>> = {
    folder: "In this folder",
    home: "Your home",
    builtin: "Built in",
};

function sectionNote(scope: PluginScope, folderLabel: string | undefined): string | undefined {
    if (scope === "folder") return folderLabel === undefined ? undefined : `Loads only in ${folderLabel}`;
    if (scope === "home") return "Loads in every folder";
    return "Ships with Vera";
}

interface PluginSectionBlockProps {
    readonly section: PluginSection;
    readonly kind: CustomizeKind;
    readonly folder: string | undefined;
    readonly folderLabel: string | undefined;
    readonly folders: readonly string[];
    readonly home: string | undefined;
    readonly open: boolean;
    readonly expanded: boolean;
    readonly onToggle: () => void;
    readonly onExpand: () => void;
    readonly onPickFolder: (folder: string) => void;
    readonly onOpen: (item: PluginItem) => void;
    readonly onMenu: (item: PluginItem, point: { readonly x: number; readonly y: number }) => void;
}

function PluginSectionBlock({
    section,
    kind,
    folder,
    folderLabel,
    folders,
    home,
    open,
    expanded,
    onToggle,
    onExpand,
    onPickFolder,
    onOpen,
    onMenu,
}: PluginSectionBlockProps) {
    const { scope, items } = section;
    const title = (
        <span className="plugin-section-title">
            <b>{SECTION_TITLES[scope]}</b>
            <span className="customize-count" data-plugin-section-count={scope}>{items.length}</span>
        </span>
    );
    const note = sectionNote(scope, folderLabel);
    const shown = expanded ? items : items.slice(0, FIRST_ROWS);
    const more = expanded ? undefined : seeMoreLabel(items.slice(FIRST_ROWS).map(pluginName));
    return (
        <section className="plugin-section" data-section={scope}>
            <div className="plugin-section-head">
                {title}
                {note === undefined ? null : <span className="plugin-section-note">{note}</span>}
                <span className="plugin-section-space" />
                {scope === "folder" ? <FolderMenu folder={folder} folders={folders} onPick={onPickFolder} /> : null}
                {scope === "builtin" ? (
                    <button
                        type="button"
                        className="plugin-section-toggle"
                        aria-expanded={open}
                        aria-label="Built in"
                        data-plugin-section-toggle="builtin"
                        onClick={onToggle}
                    >
                        <ChevronDownIcon />
                    </button>
                ) : null}
            </div>
            {open ? (
                items.length === 0 ? (
                    <div className="plugin-empty-row">
                        <span className="plugin-tile"><FolderIcon /></span>
                        <p>{pluginSectionEmpty(scope, kind, folderLabel)}</p>
                    </div>
                ) : (
                    <>
                        <ul className="plugins-grid">
                            {shown.map((item) => (
                                <PluginRow
                                    key={item.key}
                                    item={item}
                                    folder={folder}
                                    home={home}
                                    onOpen={() => onOpen(item)}
                                    onMenu={(point) => onMenu(item, point)}
                                />
                            ))}
                        </ul>
                        {more === undefined ? null : (
                            <button type="button" className="plugins-more" data-plugin-see-more={scope} onClick={onExpand}>
                                {more}
                            </button>
                        )}
                    </>
                )
            ) : null}
        </section>
    );
}

export function PluginsPage() {
    const { connection } = useViewEnvironment();
    const { navigate } = useRouter();
    const active = useActiveSession();
    const bridge = desktopBridge();
    const rows = connection.sessionRows ?? [];
    const folders = folderChoices(rows);

    // Starts at the folder on screen; otherwise the latest folder is kept until the user picks another.
    const [chosen, setChosen] = useState<string | undefined>(() => (active === undefined || active.chat ? undefined : active.folder));
    const folder = latchedFolder(chosen, folders);
    useEffect(() => {
        if (chosen === undefined && folder !== undefined) setChosen(folder);
    }, [chosen, folder]);

    const [reload, setReload] = useState(0);
    const [kind, setKind] = useState<CustomizeKind>("skills");
    const [query, setQuery] = useState("");
    const [builtinOpen, setBuiltinOpen] = useState(false);
    const [expanded, setExpanded] = useState<readonly PluginScope[]>([]);
    const [picked, setPicked] = useState<PluginItem | undefined>(undefined);
    const [rowMenu, setRowMenu] = useState<{ readonly item: PluginItem; readonly x: number; readonly y: number } | undefined>(undefined);
    const [mode, setMode] = useState<PluginsMode>("yours");
    const yours = mode === "yours";

    const attached = connection.phase === "attached";
    const reading = useFolderCustomizations(bridge, folder, attached, reload);
    const failures = useExtensionFailures(bridge, reload);
    const extensions = useDesktopExtensions(bridge);
    const refreshExtensions = extensions.refresh;
    const folderLabel = folder === undefined ? undefined : folderName(folder);
    const home = connection.ready?.home;
    const searching = query.trim().length > 0;

    // Discover installs extensions outside this hook, so read the list again when the kind is opened.
    useEffect(() => {
        if (yours && kind === "extensions") refreshExtensions();
    }, [yours, kind, refreshExtensions]);

    const items = useMemo(() => {
        if (reading.phase !== "ready") return [];
        return pluginItems(
            reading.reading,
            failures.phase === "ok" ? failures.failures : [],
            extensions.list.phase === "ready" ? extensions.list.extensions : [],
        );
    }, [reading, failures, extensions.list]);
    const kindCounts = useMemo(() => pluginKindCounts(items), [items]);
    const sections = useMemo(() => pluginSections(items, kind, query), [items, kind, query]);

    useEffect(() => {
        setExpanded([]);
    }, [kind, query, folder]);

    useEffect(() => {
        setBuiltinOpen(false);
    }, [kind, folder]);

    // The open sheet follows its row: a removed extension closes it, and a switch flip shows the new state.
    useEffect(() => {
        if (picked === undefined || items.length === 0) return;
        const current = items.find((item) => item.key === picked.key);
        if (current === undefined) setPicked(undefined);
        else if (current !== picked) setPicked(current);
    }, [items, picked]);

    function tryNow(item: PluginItem): void {
        requestNewChatPrefill(`/${item.name}`);
        setPicked(undefined);
        navigate({ kind: "home", ...(folder === undefined ? {} : { folder }) });
    }

    function discoverBody() {
        if (bridge !== undefined) return <DiscoverThemes bridge={bridge} />;
        return (
            <EmptyState title="Nothing to browse">
                <span>
                    Vera has no catalog of installable extensions or skills. Install an extension from a folder with{" "}
                    <span className="customize-code">{"/extension install <path>"}</span> in the terminal, then open Yours to see it.
                </span>
                <span className="customize-empty-action">
                    <button type="button" className="ghost-btn" onClick={() => setMode("yours")}>
                        Open Yours
                    </button>
                </span>
            </EmptyState>
        );
    }

    function listBody() {
        if (!attached) {
            return (
                <EmptyState title="Vera is not connected">
                    Plugins reads what a session in this folder loads. Connect to Vera to see it.
                </EmptyState>
            );
        }
        if (reading.phase === "failed") {
            return (
                <>
                    <p className="customize-note" data-tone="danger">{reading.reason}</p>
                    <button type="button" className="ghost-btn" onClick={() => setReload(reload + 1)}>Retry</button>
                </>
            );
        }
        if (reading.phase !== "ready") return <p className="customize-note">Reading…</p>;
        return (
            <>
                {reading.reading.warnings.map((warning, index) => (
                    <p key={`${index}:${warning}`} className="customize-note">{warning}</p>
                ))}
                {failures.phase === "failed" ? (
                    <p className="customize-note">Extension failures could not be read: {failures.reason}</p>
                ) : null}
                {extensions.list.phase === "failed" ? (
                    <p className="customize-note">The extension list could not be read: {extensions.list.reason}</p>
                ) : null}
                {kind === "extensions" ? <ExtensionPreview extensions={extensions} /> : null}
                {kind === "extensions" && extensions.report !== undefined ? (
                    <p className="customize-note" role="status" data-tone={extensions.report.ok ? undefined : "danger"} data-desktop-extension-report={extensions.report.ok}>
                        {extensions.report.message}
                    </p>
                ) : null}
                {searching && sections.length === 0 ? (
                    <p className="plugin-no-match" data-plugin-no-match>{pluginNoMatch(kind, query)}</p>
                ) : null}
                {sections.map((section) => (
                    <PluginSectionBlock
                        key={section.scope}
                        section={section}
                        kind={kind}
                        folder={folder}
                        folderLabel={folderLabel}
                        folders={folders}
                        home={home}
                        open={section.scope !== "builtin" || searching || builtinOpen}
                        expanded={expanded.includes(section.scope)}
                        onToggle={() => setBuiltinOpen(!builtinOpen)}
                        onExpand={() => setExpanded([...expanded, section.scope])}
                        onPickFolder={setChosen}
                        onOpen={setPicked}
                        onMenu={(item, point) => setRowMenu({ item, ...point })}
                    />
                ))}
            </>
        );
    }

    return (
        <Page
            title="Plugins"
            lede={folderLabel === undefined ? "What Vera loads for a new chat." : `What Vera loads for ${folderLabel}.`}
            actions={(
                <div className="customize-seg" role="group" aria-label="Plugins view">
                    <button type="button" aria-pressed={yours} onClick={() => setMode("yours")}>Yours</button>
                    <button type="button" aria-pressed={!yours} onClick={() => setMode("discover")}>Discover</button>
                </div>
            )}
            wide
        >
            {yours ? (
                <div className="toolbar plugins-toolbar">
                    <label className="search-field plugins-search">
                        <SearchIcon />
                        <input
                            type="search"
                            aria-label={`Search ${KIND_LABELS[kind].plural.toLowerCase()}`}
                            placeholder={`Search ${KIND_LABELS[kind].plural.toLowerCase()}`}
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                        />
                    </label>
                    <div className="plugins-kinds" role="group" aria-label="Plugin kinds">
                        {KIND_TABS.map((candidate) => (
                            <button
                                key={candidate}
                                type="button"
                                aria-pressed={kind === candidate}
                                data-kind={candidate}
                                onClick={() => setKind(candidate)}
                            >
                                {KIND_LABELS[candidate].plural}
                                <span className="customize-count">{kindCounts[candidate]}</span>
                            </button>
                        ))}
                    </div>
                    <button type="button" className="ghost-btn" onClick={() => setReload(reload + 1)}>
                        <RefreshIcon />
                        Reload
                    </button>
                    {kind === "extensions" ? <AddMenu extensions={extensions} /> : null}
                </div>
            ) : null}
            {yours ? listBody() : discoverBody()}
            {picked === undefined ? null : (
                <PluginSheet
                    key={picked.key}
                    item={picked}
                    folderLabel={folderLabel}
                    extensions={extensions}
                    onClose={() => setPicked(undefined)}
                    onTryNow={tryNow}
                />
            )}
            {rowMenu === undefined ? null : (
                <PluginMenu
                    item={rowMenu.item}
                    x={rowMenu.x}
                    y={rowMenu.y}
                    onClose={() => setRowMenu(undefined)}
                />
            )}
        </Page>
    );
}
